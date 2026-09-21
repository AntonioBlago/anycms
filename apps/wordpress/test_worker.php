<?php
/** Child process for test_wordpress.php; only a disposable AIAC_TESTING installation. */
declare(strict_types=1);
if (PHP_SAPI !== 'cli' || count($argv) !== 4) {
    exit(1);
}
require rtrim($argv[1], '/') . '/wp-load.php';
if (!defined('AIAC_TESTING') || AIAC_TESTING !== true) {
    exit(1);
}
require_once __DIR__ . '/ai-automation-connector.php';
add_filter('pre_http_request', static fn() => ['response' => ['code' => 200], 'body' => '{}', 'headers' => []]);
if ($argv[2] === 'claim') {
    echo aiac_claim('aiac_parallel_claim', 60) !== null ? 'owner' : 'busy';
} else {
    $body = wp_json_encode(['event' => 'article.updated', 'article_id' => (int) $argv[3], 'timestamp' => gmdate('Y-m-d\TH:i:s\Z')]);
    $request = new WP_REST_Request('POST');
    $request->set_body($body);
    $request->set_header('X-Webhook-Signature', 'sha256=' . hash_hmac('sha256', $body, 'test-secret'));
    echo aiac_handle_webhook($request)->get_status();
}
