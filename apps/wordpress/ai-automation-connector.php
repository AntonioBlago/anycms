<?php
/**
 * Plugin Name:       AI Automation Connector
 * Plugin URI:        https://github.com/AntonioBlago/anycms
 * Description:       Receives AI-generated articles from Visibly and publishes them as WordPress posts. Verifies the HMAC signature, acknowledges immediately, and fetches the article in the background.
 * Version:           1.1.0
 * Requires at least: 6.0
 * Requires PHP:      8.0
 * Author:            Antonio Blago
 * License:           MIT
 * Text Domain:       ai-automation-connector
 *
 * Verify the signed timestamp, persist a background job, acknowledge with 202.
 * Visibly does not retry a read timeout. Queue failures return 503 so delivery
 * can be retried; transient background failures have their own bounded retries.
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit; // Direkter Aufruf: nichts zu sehen.
}

const AIAC_OPTION_GROUP = 'aiac_settings';
const AIAC_NAMESPACE    = 'ai-automation/v1';
const AIAC_DEFAULT_BASE = 'https://app.visibly-ai.com';
const AIAC_WEBHOOK_MAX_AGE = 300;
const AIAC_MAX_ATTEMPTS = 5;

/** Option lesen, mit Konstanten-Vorrang: wp-config.php schlägt die Datenbank. */
function aiac_option(string $name, string $konstante, string $default = ''): string
{
    if (defined($konstante) && constant($konstante)) {
        return (string) constant($konstante);
    }
    return (string) get_option($name, $default);
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook-Route
// ─────────────────────────────────────────────────────────────────────────────

add_action('rest_api_init', static function (): void {
    register_rest_route(AIAC_NAMESPACE, '/webhook', [
        'methods'             => 'POST',
        'callback'            => 'aiac_handle_webhook',
        // Der Webhook authentifiziert sich über die HMAC-Signatur, nicht über
        // eine WordPress-Anmeldung. Die Prüfung erfolgt im Handler.
        'permission_callback' => '__return_true',
    ]);
});

/**
 * Nimmt den Webhook entgegen, prüft die Signatur und quittiert sofort.
 */
function aiac_handle_webhook(WP_REST_Request $request): WP_REST_Response
{
    $secret = aiac_option('aiac_webhook_secret', 'AIAC_WEBHOOK_SECRET');
    if ($secret === '') {
        return new WP_REST_Response(['error' => 'webhook_secret_missing'], 500);
    }

    // Den ROHEN Body verwenden: die Signatur gilt für die gesendeten Bytes.
    // Aus geparstem JSON neu zu serialisieren ändert Reihenfolge und
    // Leerzeichen, und jede gültige Signatur fiele durch.
    $roh       = $request->get_body();
    if (strlen($roh) > 65536) {
        return new WP_REST_Response(['error' => 'payload_too_large'], 413);
    }
    $signatur  = (string) $request->get_header('x_webhook_signature');
    if (!aiac_verify_signature($roh, $secret, $signatur)) {
        return new WP_REST_Response(['error' => 'invalid_signature'], 401);
    }

    $payload = json_decode($roh, true);
    if (!is_array($payload)) {
        return new WP_REST_Response(['error' => 'invalid_json'], 400);
    }

    $timestamp = $payload['timestamp'] ?? null;
    if (!is_string($timestamp)
        || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/D', $timestamp)
        || ($sent = strtotime($timestamp)) === false
        || $sent < time() - AIAC_WEBHOOK_MAX_AGE || $sent > time() + 60) {
        return new WP_REST_Response(['error' => 'invalid_timestamp'], 401);
    }
    $event = $payload['event'] ?? null;
    if (!is_string($event)) {
        return new WP_REST_Response(['error' => 'invalid_event'], 400);
    }
    // Eine Bestätigung darf keinen weiteren Import auslösen.
    if (!in_array($event, ['article.approved', 'article.updated'], true)) {
        return new WP_REST_Response(['status' => 'ignored', 'event' => $event], 202);
    }
    $article_id = $payload['article_id'] ?? null;
    if (!is_int($article_id) || $article_id <= 0) {
        return new WP_REST_Response(['error' => 'invalid_article_id'], 400);
    }

    if (aiac_option('aiac_api_key', 'AIAC_API_KEY') === '') {
        return new WP_REST_Response(['error' => 'api_key_missing'], 500);
    }

    if (aiac_base_url() === '') {
        return new WP_REST_Response(['error' => 'invalid_base_url'], 500);
    }
    $receipt = 'aiac_receipt_' . hash('sha256', $roh);
    // Die Datenbank erzwingt Eindeutigkeit auch ohne persistenten Object Cache.
    $claim = aiac_claim($receipt, 2 * AIAC_WEBHOOK_MAX_AGE + 60);
    if ($claim === null) {
        $existing = aiac_read_claim($receipt);
        $ready = is_array($existing) && !empty($existing['ready']);
        return new WP_REST_Response(['status' => $ready ? 'duplicate' : 'queue_busy'], $ready ? 202 : 503);
    }
    // Erst Aufräumen und Auftrag dauerhaft planen, dann Erfolg quittieren.
    if (!aiac_schedule($claim['expires'], 'aiac_release_claim', [$receipt, $claim['token']])
        || !aiac_schedule(time(), 'aiac_process_article', [$article_id, ['delivery' => $receipt, 'attempt' => 0]])) {
        aiac_release_claim($receipt, $claim['token']);
        return new WP_REST_Response(['error' => 'queue_failed'], 503);
    }
    global $wpdb;
    $ready = array_merge($claim, ['ready' => true]);
    if ($wpdb->query($wpdb->prepare(
        "UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND option_value = %s",
        maybe_serialize($ready), $receipt, maybe_serialize($claim)
    )) !== 1) {
        return new WP_REST_Response(['error' => 'queue_state_failed'], 503);
    }
    spawn_cron();

    return new WP_REST_Response(['status' => 'accepted', 'article_id' => $article_id], 202);
}

/** Atomare, zeitlich begrenzte Reservierung; abgelaufene Besitzer sicher ablösen. */
function aiac_claim(string $name, int $ttl): ?array
{
    global $wpdb;
    $old = aiac_read_claim($name);
    if (is_array($old) && ($old['expires'] ?? PHP_INT_MAX) < time()) {
        aiac_release_claim($name, (string) ($old['token'] ?? ''));
    }
    $claim = ['token' => bin2hex(random_bytes(16)), 'expires' => time() + $ttl, 'ready' => false];
    // add_option() kann bei konkurrierenden Inserts den Wert überschreiben.
    // INSERT IGNORE lässt genau einen Besitzer gewinnen. Diese internen
    // Optionen werden ausschließlich direkt gelesen, ohne Object-Cache.
    $inserted = $wpdb->query($wpdb->prepare(
        "INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
        $name, maybe_serialize($claim)
    ));
    return $inserted === 1 ? $claim : null;
}

function aiac_read_claim(string $name): ?array
{
    global $wpdb;
    $value = $wpdb->get_var($wpdb->prepare(
        "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $name
    ));
    $claim = maybe_unserialize($value);
    return is_array($claim) ? $claim : null;
}

/** Compare-and-delete: ein alter Worker darf die neue Sperre nicht löschen. */
function aiac_release_claim(string $name, string $token): void
{
    global $wpdb;
    $claim = aiac_read_claim($name);
    if (!is_array($claim) || ($claim['token'] ?? null) !== $token) {
        return;
    }
    $wpdb->query($wpdb->prepare(
        "DELETE FROM {$wpdb->options} WHERE option_name = %s AND option_value = %s",
        $name, maybe_serialize($claim)
    ));
    wp_cache_delete($name, 'options');
}
add_action('aiac_release_claim', 'aiac_release_claim', 10, 2);

function aiac_schedule(int $when, string $hook, array $args): bool
{
    global $wpdb;
    // WP-Cron speichert alle Events in einer Option. Gleichzeitige Webhooks
    // dürfen sich diese Liste nicht gegenseitig überschreiben. Der DB-Lock
    // wird auch beim Abbruch der Verbindung automatisch freigegeben.
    $mutex = 'aiac_cron_' . md5(DB_NAME . '|' . $wpdb->options);
    if ((string) $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 2)', $mutex)) !== '1') {
        error_log('[aiac] Cron-Warteschlange ist belegt');
        return false;
    }
    try {
        // Ein anderer Request kann die Cron-Option seit dem WP-Boot geändert haben.
        wp_cache_delete('cron', 'options');
        wp_cache_delete('alloptions', 'options');
        if (wp_next_scheduled($hook, $args) !== false) {
            return true;
        }
        $result = wp_schedule_single_event($when, $hook, $args, true);
        if ($result !== true) {
            error_log('[aiac] Hintergrundauftrag konnte nicht geplant werden: ' . $hook);
            return false;
        }
        return true;
    } finally {
        $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $mutex));
    }
}

function aiac_retry(int $article_id, array $payload): void
{
    $attempt = (int) ($payload['attempt'] ?? 0);
    if ($attempt >= AIAC_MAX_ATTEMPTS) {
        error_log("[aiac] Import {$article_id}: Wiederholungen ausgeschöpft");
        return;
    }
    $payload['attempt'] = $attempt + 1;
    aiac_schedule(time() + 30 * (2 ** $attempt), 'aiac_process_article', [$article_id, $payload]);
}

/**
 * HMAC-SHA256 im Format `sha256=<hex>`, zeitkonstant verglichen.
 *
 * `hash_equals` ist Pflicht: ein `===` bricht beim ersten falschen Zeichen ab
 * und verrät über die Laufzeit, wie viele Zeichen stimmten.
 */
function aiac_verify_signature(string $payload, string $secret, string $header): bool
{
    if ($secret === '' || $header === '') {
        return false;
    }
    $geliefert = str_starts_with($header, 'sha256=') ? substr($header, 7) : $header;
    $erwartet  = hash_hmac('sha256', $payload, $secret);
    return hash_equals($erwartet, $geliefert);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verarbeitung (Hintergrund)
// ─────────────────────────────────────────────────────────────────────────────

add_action('aiac_process_article', 'aiac_process_article', 10, 2);

/**
 * Artikel holen, als Beitrag schreiben, URL zurückmelden.
 */
function aiac_process_article(int $article_id, array $payload = []): void
{
    $sperre = 'aiac_worker_' . $article_id;
    $claim = aiac_claim($sperre, 5 * MINUTE_IN_SECONDS);
    if ($claim === null) {
        aiac_retry($article_id, $payload);
        return;
    }
    try {
        $artikel = aiac_fetch_article($article_id);
        if ($artikel === null) {
            error_log("[aiac] Artikel {$article_id} nicht abrufbar");
            aiac_retry($article_id, $payload);
            return;
        }
        // Inzwischen zurückgezogene Freigaben nicht durch alte Events umgehen.
        if (!in_array($artikel['status'] ?? '', ['approved', 'published'], true)) {
            return;
        }
        $post_id = aiac_upsert_post($artikel);
        if ($post_id === 0) {
            aiac_retry($article_id, $payload);
            return;
        }
        aiac_confirm_post($post_id);
    } catch (Throwable $error) {
        error_log("[aiac] Import {$article_id} fehlgeschlagen");
        aiac_retry($article_id, $payload);
    } finally {
        aiac_release_claim($sperre, $claim['token']);
    }
}

/** Einen Artikel über die Pull-API holen. `null` bei jedem Fehler. */
function aiac_fetch_article(int $article_id): ?array
{
    $basis = aiac_base_url();
    $key   = aiac_option('aiac_api_key', 'AIAC_API_KEY');
    if ($basis === '' || $key === '') {
        return null;
    }

    $antwort = wp_safe_remote_get(
        "{$basis}/api/v1/articles/{$article_id}?include_markdown=true",
        [
            'timeout' => 30,
            'redirection' => 0,
            'sslverify' => true,
            'limit_response_size' => 5 * 1024 * 1024,
            'headers' => [
                'Authorization' => "Bearer {$key}",
                'Accept'        => 'application/json',
                'User-Agent'    => 'ai-automation-connector-wp/1.1',
            ],
        ]
    );

    if (is_wp_error($antwort) || wp_remote_retrieve_response_code($antwort) !== 200) {
        return null;
    }
    $daten = json_decode(wp_remote_retrieve_body($antwort), true);
    $article = is_array($daten) ? ($daten['article'] ?? null) : null;
    return is_array($article) && ($article['id'] ?? null) === $article_id ? $article : null;
}

/**
 * Beitrag anlegen oder aktualisieren.
 *
 * Die Visibly-Artikel-ID liegt als Meta am Beitrag: darüber wird beim zweiten
 * Mal derselbe Beitrag gefunden statt ein Duplikat angelegt. Ein gleicher
 * Slug erlaubt niemals die Übernahme eines anderen Beitrags.
 */
function aiac_upsert_post(array $artikel): int
{
    $article_id = (int) ($artikel['id'] ?? 0);
    $slug       = sanitize_title((string) ($artikel['slug'] ?? ''));
    if ($article_id === 0 || $slug === '') {
        error_log('[aiac] Artikel ohne ID oder Slug');
        return 0;
    }

    $inhalt = (string) ($artikel['content_html'] ?? '');
    if (($artikel['content_format'] ?? 'html') === 'markdown' && !empty($artikel['content_markdown'])) {
        // WordPress rendert kein Markdown; der HTML-Zweig ist der sichere Weg.
        // Liegt nur Markdown vor, wandern die Zeilen als Absätze hinein.
        $inhalt = wpautop((string) $artikel['content_markdown']);
    }

    $vorhanden = aiac_find_post($article_id);
    $revision = (int) ($artikel['revision'] ?? 1);
    if ($vorhanden > 0) {
        if (get_post_status($vorhanden) === 'trash') {
            return 0;
        }
        if ((int) get_post_meta($vorhanden, '_aiac_revision', true) >= $revision) {
            return $vorhanden;
        }
    }
    $status    = aiac_option('aiac_post_status', 'AIAC_POST_STATUS', 'draft');

    $daten = [
        'post_title'   => sanitize_text_field((string) ($artikel['title'] ?? '')),
        'post_name'    => $slug,
        'post_content' => wp_kses_post($inhalt),
        'post_excerpt' => sanitize_text_field((string) ($artikel['meta_description'] ?? '')),
        'post_type'    => 'post',
    ];

    if ($vorhanden > 0) {
        // Beim Aktualisieren bleibt der Status, wie er ist: ein
        // veröffentlichter Beitrag wird durch eine Textänderung nicht wieder
        // zum Entwurf.
        $daten['ID'] = $vorhanden;
        $post_id = wp_update_post(wp_slash($daten), true);
    } else {
        $daten['post_status'] = in_array($status, ['draft', 'publish', 'pending'], true) ? $status : 'draft';
        $post_id = wp_insert_post(wp_slash($daten), true);
    }

    if (is_wp_error($post_id) || !$post_id) {
        error_log('[aiac] Beitrag konnte nicht geschrieben werden');
        return 0;
    }

    $post_id = (int) $post_id;
    update_post_meta($post_id, '_aiac_article_id', $article_id);
    update_post_meta($post_id, '_aiac_revision', $revision);
    if (!empty($artikel['content_language'])) {
        update_post_meta($post_id, '_aiac_language', sanitize_text_field((string) $artikel['content_language']));
    }

    // Keywords als Schlagwörter: sie kommen aus einem fremden System, deshalb
    // erst durch sanitize_text_field.
    if (!empty($artikel['keywords']) && is_array($artikel['keywords'])) {
        $tags = array_filter(array_map(
            static fn($k) => is_string($k) ? sanitize_text_field($k) : '',
            $artikel['keywords']
        ));
        if ($tags) {
            wp_set_post_tags($post_id, $tags, false);
        }
    }

    return $post_id;
}

/** Ausschließlich bereits zugeordnete Beiträge finden, auch im Papierkorb. */
function aiac_find_post(int $article_id): int
{
    $treffer = get_posts([
        'post_type'      => 'post',
        'post_status'    => array_values(get_post_stati()),
        'numberposts'    => 1,
        'fields'         => 'ids',
        'meta_key'       => '_aiac_article_id',
        'meta_value'     => $article_id,
    ]);
    return $treffer ? (int) $treffer[0] : 0;
}

/** Auch eine spätere manuelle Freigabe melden, ohne den Editor zu blockieren. */
add_action('transition_post_status', static function (string $new, string $old, WP_Post $post): void {
    if ($new === 'publish' && $old !== 'publish' && $post->post_type === 'post'
        && (int) get_post_meta($post->ID, '_aiac_article_id', true) > 0) {
        aiac_schedule(time(), 'aiac_confirm_post', [$post->ID, 0]);
    }
}, 10, 3);
add_action('aiac_confirm_post', 'aiac_confirm_post', 10, 2);

function aiac_confirm_post(int $post_id, int $attempt = 0): void
{
    if (get_post_status($post_id) !== 'publish') {
        return;
    }
    $article_id = (int) get_post_meta($post_id, '_aiac_article_id', true);
    $url = get_permalink($post_id);
    if ($article_id <= 0 || !is_string($url) || $url === ''
        || get_post_meta($post_id, '_aiac_confirmed_url', true) === $url) {
        return;
    }
    if (aiac_confirm_published($article_id, $url)) {
        update_post_meta($post_id, '_aiac_confirmed_url', $url);
    } elseif ($attempt < AIAC_MAX_ATTEMPTS) {
        aiac_schedule(time() + 30 * (2 ** $attempt), 'aiac_confirm_post', [$post_id, $attempt + 1]);
    } else {
        error_log("[aiac] Veröffentlichung {$article_id} konnte nicht bestätigt werden");
    }
}

/** Keine Zugangsdaten über HTTP oder an durch Redirects bestimmte Hosts senden. */
function aiac_valid_base_url(string $url): bool
{
    $parts = wp_parse_url($url);
    return is_array($parts) && ($parts['scheme'] ?? '') === 'https' && !empty($parts['host'])
        && !isset($parts['user']) && !isset($parts['pass'])
        && !isset($parts['query']) && !isset($parts['fragment']);
}

function aiac_base_url(): string
{
    $url = rtrim(aiac_option('aiac_base_url', 'AIAC_BASE_URL', AIAC_DEFAULT_BASE), '/');
    return aiac_valid_base_url($url) ? $url : '';
}

function aiac_sanitize_base_url($value): string
{
    $url = is_string($value) ? esc_url_raw(trim($value), ['https']) : '';
    if (!aiac_valid_base_url($url)) {
        add_settings_error('aiac_base_url', 'invalid_base_url', 'Enter an HTTPS URL without credentials, query or fragment.');
        return (string) get_option('aiac_base_url', AIAC_DEFAULT_BASE);
    }
    return rtrim($url, '/');
}

/** Veröffentlichung an Visibly zurückmelden. */
function aiac_confirm_published(int $article_id, string $url): bool
{
    $basis = aiac_base_url();
    $key   = aiac_option('aiac_api_key', 'AIAC_API_KEY');
    if ($basis === '' || $key === '') {
        return false;
    }

    $antwort = wp_safe_remote_post(
        "{$basis}/api/v1/articles/{$article_id}/confirm",
        [
            'timeout' => 30,
            'redirection' => 0,
            'sslverify' => true,
            'limit_response_size' => 65536,
            'headers' => [
                'Authorization' => "Bearer {$key}",
                'Content-Type'  => 'application/json',
                'User-Agent'    => 'ai-automation-connector-wp/1.1',
            ],
            'body'    => wp_json_encode(['published_url' => $url]),
        ]
    );

    if (is_wp_error($antwort)) {
        error_log('[aiac] Rueckmeldung fehlgeschlagen: ' . $antwort->get_error_message());
        return false;
    }
    return wp_remote_retrieve_response_code($antwort) === 200;
}

// ─────────────────────────────────────────────────────────────────────────────
// Einstellungsseite
// ─────────────────────────────────────────────────────────────────────────────

add_action('admin_menu', static function (): void {
    add_options_page(
        'AI Automation Connector',
        'AI Automation',
        'manage_options',
        'ai-automation-connector',
        'aiac_settings_page'
    );
});

add_action('admin_init', static function (): void {
    register_setting(AIAC_OPTION_GROUP, 'aiac_webhook_secret', ['sanitize_callback' => 'sanitize_text_field']);
    register_setting(AIAC_OPTION_GROUP, 'aiac_api_key', ['sanitize_callback' => 'sanitize_text_field']);
    register_setting(AIAC_OPTION_GROUP, 'aiac_base_url', ['sanitize_callback' => 'aiac_sanitize_base_url']);
    register_setting(AIAC_OPTION_GROUP, 'aiac_post_status', ['sanitize_callback' => 'sanitize_text_field']);
});

function aiac_settings_page(): void
{
    if (!current_user_can('manage_options')) {
        return;
    }
    $webhook_url = rest_url(AIAC_NAMESPACE . '/webhook');
    $status      = get_option('aiac_post_status', 'draft');
    ?>
    <div class="wrap">
        <h1>AI Automation Connector</h1>
        <p>
            Paste this URL into Visibly as a CMS connection of type
            <strong>Webhook</strong>:
        </p>
        <p><code style="user-select:all"><?php echo esc_html($webhook_url); ?></code></p>
        <p>
            No account yet?
            <a href="https://app.visibly-ai.com" target="_blank" rel="noopener">
                Get one at app.visibly-ai.com
            </a>, then copy your API key from Settings.
        </p>
        <form method="post" action="options.php">
            <?php settings_fields(AIAC_OPTION_GROUP); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="aiac_webhook_secret">Webhook secret</label></th>
                    <td>
                        <input type="password" id="aiac_webhook_secret" name="aiac_webhook_secret"
                               value="<?php echo esc_attr(get_option('aiac_webhook_secret', '')); ?>"
                               class="regular-text" autocomplete="off" />
                        <p class="description">The same value you entered in the Visibly connection.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="aiac_api_key">API key</label></th>
                    <td>
                        <input type="password" id="aiac_api_key" name="aiac_api_key"
                               value="<?php echo esc_attr(get_option('aiac_api_key', '')); ?>"
                               class="regular-text" autocomplete="off" />
                        <p class="description">Use a project key (<code>cp_…</code>) to limit access. Account keys (<code>lc_…</code>) can access multiple projects.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="aiac_post_status">New posts arrive as</label></th>
                    <td>
                        <select id="aiac_post_status" name="aiac_post_status">
                            <option value="draft" <?php selected($status, 'draft'); ?>>Draft (review first)</option>
                            <option value="pending" <?php selected($status, 'pending'); ?>>Pending review</option>
                            <option value="publish" <?php selected($status, 'publish'); ?>>Published</option>
                        </select>
                        <p class="description">
                            Updates never change the status: a published post stays published.
                        </p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="aiac_base_url">Visibly host</label></th>
                    <td>
                        <input type="url" id="aiac_base_url" name="aiac_base_url"
                               value="<?php echo esc_attr(get_option('aiac_base_url', AIAC_DEFAULT_BASE)); ?>"
                               class="regular-text" placeholder="<?php echo esc_attr(AIAC_DEFAULT_BASE); ?>" />
                        <p class="description">Public HTTPS URL. Leave as is unless you run your own installation.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}
