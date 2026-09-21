<?php
/**
 * Integration regressions using real WordPress posts, KSES, options and cron.
 * ONLY on a disposable installation: define('AIAC_TESTING', true) in wp-config.php,
 * then: wp eval-file /path/to/test_wordpress.php
 * HTTP calls are intercepted; no Visibly account or credentials are used.
 */
if (!defined('AIAC_TESTING') || AIAC_TESTING !== true || !defined('WP_CLI') || !WP_CLI) {
    throw new RuntimeException('Use a disposable WordPress installation with AIAC_TESTING=true and WP-CLI.');
}
require_once __DIR__ . '/ai-automation-connector.php';

global $checks, $failures, $http, $article, $fetch_callback, $fetch_error, $confirm_error;
$checks = 0;
$failures = [];
$http = [];
$article = [];
$fetch_callback = null;
$fetch_error = false;
$confirm_error = false;

add_filter('pre_http_request', static function ($pre, $args, $url) {
    global $http, $article, $fetch_callback, $fetch_error, $confirm_error;
    if (str_contains($url, 'wp-cron.php')) {
        return ['response' => ['code' => 200], 'body' => '', 'headers' => []];
    }
    $http[] = [$url, $args];
    if ($fetch_error) {
        return new WP_Error('test_network', 'Simulated network failure');
    }
    if ($args['method'] === 'POST') {
        return ['response' => ['code' => $confirm_error ? 503 : 200], 'body' => '{}', 'headers' => []];
    }
    $snapshot = $article;
    if ($fetch_callback) {
        $callback = $fetch_callback;
        $fetch_callback = null;
        $callback();
    }
    return ['response' => ['code' => 200], 'body' => wp_json_encode(['article' => $snapshot]), 'headers' => []];
}, 10, 3);

function aiac_test_reset(): void
{
    global $wpdb, $http, $article, $fetch_callback, $fetch_error, $confirm_error;
    foreach (get_posts(['post_type' => 'post', 'post_status' => array_values(get_post_stati()), 'numberposts' => -1]) as $post) {
        wp_delete_post($post->ID, true);
    }
    foreach (_get_cron_array() as $when => $hooks) {
        foreach ($hooks as $hook => $events) {
            if (str_starts_with($hook, 'aiac_')) {
                foreach ($events as $event) {
                    wp_unschedule_event($when, $hook, $event['args']);
                }
            }
        }
    }
    $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name LIKE %s", $wpdb->esc_like('aiac_') . '%'));
    wp_cache_flush();
    wp_set_current_user(0);
    update_option('aiac_api_key', 'cp_test');
    update_option('aiac_webhook_secret', 'test-secret');
    update_option('aiac_post_status', 'draft');
    $article = ['id' => 42, 'slug' => 'existing', 'title' => 'Imported', 'content_html' => '<p>Version 1</p>',
        'status' => 'approved', 'revision' => 1, 'content_format' => 'html'];
    $http = [];
    $fetch_callback = null;
    $fetch_error = false;
    $confirm_error = false;
}

function aiac_test_request(array $overrides = [], ?string $signature = null): WP_REST_Request
{
    $body = wp_json_encode(array_merge(['event' => 'article.approved', 'article_id' => 42,
        'timestamp' => gmdate('Y-m-d\TH:i:s\Z'), 'revision' => 1], $overrides));
    $request = new WP_REST_Request('POST', '/ai-automation/v1/webhook');
    $request->set_body($body);
    $request->set_header('Content-Type', 'application/json');
    $request->set_header('X-Webhook-Signature', $signature ?? 'sha256=' . hash_hmac('sha256', $body, 'test-secret'));
    return $request;
}

function aiac_test_jobs(string $hook = 'aiac_process_article'): array
{
    $jobs = [];
    foreach (_get_cron_array() as $when => $hooks) {
        foreach ($hooks[$hook] ?? [] as $event) {
            $jobs[] = ['when' => $when, 'args' => $event['args']];
        }
    }
    return $jobs;
}

function aiac_test_run_job(string $hook = 'aiac_process_article'): void
{
    $job = aiac_test_jobs($hook)[0] ?? null;
    if (!$job) {
        throw new RuntimeException('No scheduled ' . $hook);
    }
    wp_unschedule_event($job['when'], $hook, $job['args']);
    do_action_ref_array($hook, $job['args']);
}

function aiac_test_assert(bool $ok, string $message = 'Assertion failed'): void
{
    if (!$ok) {
        throw new RuntimeException($message);
    }
}

function aiac_test(string $name, callable $test): void
{
    global $checks, $failures;
    aiac_test_reset();
    try {
        $test();
        $checks++;
        WP_CLI::log('PASS ' . $name);
    } catch (Throwable $e) {
        $failures[] = $name . ': ' . $e->getMessage();
        WP_CLI::log('FAIL ' . end($failures));
    }
}

aiac_test('Public REST route rejects forged HMAC before creating jobs', static function () {
    $response = rest_do_request(aiac_test_request([], 'sha256=' . str_repeat('0', 64)));
    aiac_test_assert($response->get_status() === 401 && !aiac_test_jobs());
});
aiac_test('Missing signature rejected', static function () {
    aiac_test_assert(aiac_handle_webhook(aiac_test_request([], ''))->get_status() === 401);
});
foreach (['missing' => null, 'old' => '2000-01-01T00:00:00Z', 'future' => '2100-01-01T00:00:00Z', 'relative' => 'now'] as $name => $stamp) {
    aiac_test('Reject ' . $name . ' timestamp', static function () use ($stamp) {
        aiac_test_assert(aiac_handle_webhook(aiac_test_request(['timestamp' => $stamp]))->get_status() === 401);
    });
}
aiac_test('Python ISO timestamp with microseconds is accepted', static function () {
    $stamp = gmdate('Y-m-d\TH:i:s') . '.123456+00:00';
    aiac_test_assert(aiac_handle_webhook(aiac_test_request(['timestamp' => $stamp]))->get_status() === 202);
    aiac_test_assert(count(aiac_test_jobs()) === 1);
});
aiac_test('Invalid article IDs cannot be coerced into another article', static function () {
    foreach ([-1, 0, '42bad', [42], true, 42.5] as $id) {
        aiac_test_assert(aiac_handle_webhook(aiac_test_request(['article_id' => $id]))->get_status() === 400);
    }
    aiac_test_assert(!aiac_test_jobs());
});
aiac_test('Oversized request rejected', static function () {
    aiac_test_assert(aiac_handle_webhook(aiac_test_request(['padding' => str_repeat('x', 65536)]))->get_status() === 413);
});
aiac_test('Published notifications and connection tests never import', static function () {
    foreach (['article.published', 'webhook.test', 'article.failed'] as $event) {
        aiac_test_assert(aiac_handle_webhook(aiac_test_request(['event' => $event]))->get_status() === 202);
    }
    aiac_test_assert(!aiac_test_jobs());
});
aiac_test('Replay rejected both during and after successful processing', static function () {
    $request = aiac_test_request();
    aiac_handle_webhook($request);
    aiac_test_assert(aiac_handle_webhook($request)->get_data()['status'] === 'duplicate');
    aiac_test_assert(count(aiac_test_jobs()) === 1);
    aiac_test_run_job();
    aiac_test_assert(aiac_handle_webhook($request)->get_data()['status'] === 'duplicate');
    aiac_test_assert(!aiac_test_jobs());
});
aiac_test('Cron failure returns 503 and permits delivery retry', static function () {
    $block = static fn($pre, $event) => $event->hook === 'aiac_process_article' ? false : $pre;
    add_filter('pre_schedule_event', $block, 10, 2);
    try {
        aiac_test_assert(aiac_handle_webhook(aiac_test_request())->get_status() === 503);
        aiac_test_assert(!aiac_test_jobs());
    } finally {
        remove_filter('pre_schedule_event', $block, 10);
    }
    aiac_test_assert(aiac_handle_webhook(aiac_test_request())->get_status() === 202);
    aiac_test_assert(count(aiac_test_jobs()) === 1);
});
aiac_test('Receipt cleanup failure also returns 503', static function () {
    $block = static fn($pre, $event) => $event->hook === 'aiac_release_claim' ? false : $pre;
    add_filter('pre_schedule_event', $block, 10, 2);
    try {
        aiac_test_assert(aiac_handle_webhook(aiac_test_request())->get_status() === 503 && !aiac_test_jobs());
    } finally {
        remove_filter('pre_schedule_event', $block, 10);
    }
});
aiac_test('Duplicate claims never overwrite the owner; stale release is harmless', static function () {
    global $wpdb;
    $one = aiac_claim('aiac_test_lock', 60);
    aiac_test_assert($one !== null && aiac_claim('aiac_test_lock', 60) === null);
    aiac_release_claim('aiac_test_lock', 'different-owner');
    aiac_test_assert(aiac_read_claim('aiac_test_lock')['token'] === $one['token']);
    $expired = array_merge($one, ['expires' => time() - 1]);
    $wpdb->update($wpdb->options, ['option_value' => maybe_serialize($expired)], ['option_name' => 'aiac_test_lock']);
    $two = aiac_claim('aiac_test_lock', 60);
    aiac_test_assert($two !== null && $two['token'] !== $one['token']);
    aiac_release_claim('aiac_test_lock', $one['token']);
    aiac_test_assert(aiac_read_claim('aiac_test_lock')['token'] === $two['token']);
});
aiac_test('Parallel PHP processes have one claim owner and retain every distinct delivery', static function () {
    foreach (['claim', 'webhook'] as $mode) {
        $processes = [];
        for ($i = 0; $i < 8; $i++) {
            $pipes = [];
            $process = proc_open([PHP_BINARY, __DIR__ . '/test_worker.php', ABSPATH, $mode, (string) ($i + 100)],
                [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            fclose($pipes[0]);
            $processes[] = [$process, $pipes];
        }
        $results = [];
        foreach ($processes as [$process, $pipes]) {
            $output = stream_get_contents($pipes[1]);
            $errors = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            aiac_test_assert(proc_close($process) === 0, $errors);
            $results[] = trim($output);
        }
        if ($mode === 'claim') {
            aiac_test_assert(count(array_filter($results, static fn($r) => $r === 'owner')) === 1, json_encode($results));
        } else {
            wp_cache_flush();
            $accepted = count(array_filter($results, static fn($r) => $r === '202'));
            aiac_test_assert($accepted === 8 && count(aiac_test_jobs()) === 8,
                'Accepted ' . $accepted . ', persisted ' . count(aiac_test_jobs()) . ': ' . json_encode($results));
        }
    }
});
aiac_test('Unrelated published post survives slug collision', static function () {
    $original = wp_insert_post(['post_title' => 'Editorial', 'post_content' => 'Keep me', 'post_name' => 'existing', 'post_status' => 'publish']);
    aiac_process_article(42);
    $imported = aiac_find_post(42);
    aiac_test_assert($imported > 0 && $imported !== $original);
    aiac_test_assert(get_post($original)->post_content === 'Keep me');
    aiac_test_assert(!get_post_meta($original, '_aiac_article_id', true));
});
aiac_test('Draft and pending posts never send publication confirmations', static function () {
    global $http;
    foreach (['draft', 'pending'] as $status) {
        update_option('aiac_post_status', $status);
        aiac_process_article(42);
        $post_id = aiac_find_post(42);
        aiac_test_assert(get_post_status($post_id) === $status);
        aiac_test_assert(count(array_filter($http, static fn($r) => $r[1]['method'] === 'POST')) === 0);
        wp_delete_post($post_id, true);
    }
});
aiac_test('Later manual publication queues and sends confirmation once', static function () {
    global $http;
    aiac_process_article(42);
    $post_id = aiac_find_post(42);
    wp_update_post(['ID' => $post_id, 'post_status' => 'publish']);
    aiac_test_assert(count(aiac_test_jobs('aiac_confirm_post')) === 1);
    aiac_test_run_job('aiac_confirm_post');
    aiac_confirm_post($post_id);
    aiac_test_assert(count(array_filter($http, static fn($r) => $r[1]['method'] === 'POST')) === 1);
});
aiac_test('Automatic publication confirms after metadata exists', static function () {
    global $http;
    update_option('aiac_post_status', 'publish');
    aiac_process_article(42);
    aiac_test_assert(get_post_status(aiac_find_post(42)) === 'publish');
    aiac_test_assert(count(array_filter($http, static fn($r) => $r[1]['method'] === 'POST')) === 1);
});
aiac_test('Queued confirmation rechecks status after unpublishing', static function () {
    global $http;
    aiac_process_article(42);
    $id = aiac_find_post(42);
    wp_update_post(['ID' => $id, 'post_status' => 'publish']);
    wp_update_post(['ID' => $id, 'post_status' => 'draft']);
    aiac_test_run_job('aiac_confirm_post');
    aiac_test_assert(count(array_filter($http, static fn($r) => $r[1]['method'] === 'POST')) === 0);
});
aiac_test('Update arriving during fetch is eventually applied', static function () {
    global $article, $fetch_callback;
    aiac_handle_webhook(aiac_test_request());
    $fetch_callback = static function () {
        global $article;
        $article['revision'] = 2;
        $article['content_html'] = '<p>Version 2</p>';
        aiac_test_assert(aiac_handle_webhook(aiac_test_request(['event' => 'article.updated', 'revision' => 2]))->get_status() === 202);
    };
    aiac_test_run_job();
    aiac_test_assert(count(aiac_test_jobs()) === 1);
    aiac_test_run_job();
    aiac_test_assert(get_post(aiac_find_post(42))->post_content === '<p>Version 2</p>');
    aiac_test_assert(!aiac_test_jobs());
});
aiac_test('Worker contention retries without writing a duplicate', static function () {
    $lock = aiac_claim('aiac_worker_42', 300);
    aiac_process_article(42);
    aiac_test_assert(aiac_find_post(42) === 0 && count(aiac_test_jobs()) === 1);
    aiac_release_claim('aiac_worker_42', $lock['token']);
    aiac_test_run_job();
    aiac_test_assert(aiac_find_post(42) > 0);
});
aiac_test('Same and older revisions preserve manual edits', static function () {
    global $article;
    $article['revision'] = 2;
    aiac_process_article(42);
    $id = aiac_find_post(42);
    wp_update_post(['ID' => $id, 'post_content' => 'Manual edit']);
    aiac_process_article(42);
    $article['revision'] = 1;
    aiac_process_article(42);
    aiac_test_assert(get_post($id)->post_content === 'Manual edit');
});
aiac_test('Withdrawn approvals are not imported', static function () {
    global $article;
    foreach (['draft', 'rejected', 'archived'] as $status) {
        $article['status'] = $status;
        aiac_process_article(42);
        aiac_test_assert(aiac_find_post(42) === 0);
    }
});
aiac_test('Network failures retry with a bounded attempt count', static function () {
    global $fetch_error;
    $fetch_error = true;
    aiac_process_article(42);
    for ($i = 0; $i < AIAC_MAX_ATTEMPTS; $i++) {
        aiac_test_run_job();
    }
    aiac_test_assert(!aiac_test_jobs() && aiac_read_claim('aiac_worker_42') === null);
});
aiac_test('Confirmation failure retries without reimporting content', static function () {
    global $confirm_error;
    update_option('aiac_post_status', 'publish');
    $confirm_error = true;
    aiac_process_article(42);
    aiac_test_assert(count(aiac_test_jobs('aiac_confirm_post')) === 1 && !aiac_test_jobs());
    $confirm_error = false;
    aiac_test_run_job('aiac_confirm_post');
    aiac_test_assert(get_post_meta(aiac_find_post(42), '_aiac_confirmed_url', true) !== '');
});
aiac_test('Mismatching or malformed pull response rejected', static function () {
    global $article;
    $article['id'] = 43;
    aiac_test_assert(aiac_fetch_article(42) === null);
    $article = 'not an article';
    aiac_test_assert(aiac_fetch_article(42) === null);
});
aiac_test('HTTP and credential-bearing hosts rejected before sending keys', static function () {
    global $http;
    foreach (['http://example.com', 'https://user:pass@example.com', 'https://example.com/?q=1', 'https://example.com/#fragment'] as $url) {
        update_option('aiac_base_url', $url);
        aiac_test_assert(aiac_fetch_article(42) === null);
        aiac_test_assert(!aiac_confirm_published(42, 'https://example.com/post'));
    }
    aiac_test_assert(!$http);
});
aiac_test('External URLs in webhook ignored; HTTP calls disable redirects and verify TLS', static function () {
    global $http;
    update_option('aiac_post_status', 'publish');
    aiac_handle_webhook(aiac_test_request(['pull_url' => 'http://127.0.0.1/private', 'content_html' => 'Untrusted']));
    aiac_test_run_job();
    foreach ($http as [$url, $args]) {
        aiac_test_assert(str_starts_with($url, AIAC_DEFAULT_BASE . '/api/v1/articles/42'));
        aiac_test_assert($args['redirection'] === 0 && $args['sslverify'] === true && $args['reject_unsafe_urls'] === true);
    }
    aiac_test_assert(get_post(aiac_find_post(42))->post_content === '<p>Version 1</p>');
});
aiac_test('Explicit KSES removes scripts and event handlers even as administrator', static function () {
    global $article;
    wp_set_current_user(1);
    aiac_test_assert(current_user_can('unfiltered_html'));
    $article['content_html'] = '<p onclick="alert(1)">Safe</p><script>alert(1)</script><a href="javascript:alert(1)">link</a>';
    aiac_process_article(42);
    $content = get_post(aiac_find_post(42))->post_content;
    aiac_test_assert(!str_contains($content, '<script') && !str_contains($content, 'onclick=') && !str_contains($content, 'javascript:'));
    aiac_test_assert(str_contains($content, '<p>Safe</p>'));
});
aiac_test('Backslashes survive WordPress insert and update', static function () {
    global $article;
    $article['content_html'] = '<p>C:\\path\\file and \\d+</p>';
    aiac_process_article(42);
    aiac_test_assert(get_post(aiac_find_post(42))->post_content === $article['content_html']);
    $article['revision']++;
    $article['content_html'] = '<p>Updated C:\\path\\file</p>';
    aiac_process_article(42);
    aiac_test_assert(get_post(aiac_find_post(42))->post_content === $article['content_html']);
});

WP_CLI::log(sprintf('%d/%d integration tests passed on WordPress %s / PHP %s', $checks, $checks + count($failures), get_bloginfo('version'), PHP_VERSION));
if ($failures) {
    WP_CLI::error(implode("\n", $failures));
}
