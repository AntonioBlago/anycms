<?php
/**
 * Plugin Name:       AI Automation Connector
 * Plugin URI:        https://github.com/AntonioBlago/anycms
 * Description:       Receives AI-generated articles from Visibly and publishes them as WordPress posts. Verifies the HMAC signature, acknowledges immediately, and fetches the article in the background.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      8.0
 * Author:            Antonio Blago
 * License:           MIT
 * Text Domain:       ai-automation-connector
 *
 * The contract in one sentence: a webhook is a signal, not a job with a return
 * value. Visibly waits 10 seconds for the response and does NOT retry when it
 * fails to arrive, because the request had already reached you. Answering only
 * after the post is written means being delivered to repeatedly and doing the
 * same work several times.
 *
 * So: verify, acknowledge with 202, then fetch.
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit; // Direkter Aufruf: nichts zu sehen.
}

const AIAC_OPTION_GROUP = 'aiac_settings';
const AIAC_NAMESPACE    = 'ai-automation/v1';
const AIAC_DEFAULT_BASE = 'https://app.visibly-ai.com';

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
        // eine WordPress-Anmeldung. Ohne diese Zeile verlangt WordPress einen
        // eingeloggten Nutzer und der Webhook käme nie an.
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
    $signatur  = (string) $request->get_header('x_webhook_signature');
    if (!aiac_verify_signature($roh, $secret, $signatur)) {
        return new WP_REST_Response(['error' => 'invalid_signature'], 401);
    }

    $payload = json_decode($roh, true);
    if (!is_array($payload)) {
        return new WP_REST_Response(['error' => 'invalid_json'], 400);
    }

    $event      = (string) ($payload['event'] ?? '');
    $article_id = (int) ($payload['article_id'] ?? 0);
    $bekannt    = ['article.approved', 'article.updated', 'article.published'];

    if ($article_id === 0 || !in_array($event, $bekannt, true)) {
        // Freundlich quittieren: ein Fehler würde Wiederholungen auslösen, die
        // nie etwas ändern.
        return new WP_REST_Response(['status' => 'ignored', 'event' => $event], 200);
    }

    if (aiac_option('aiac_api_key', 'AIAC_API_KEY') === '') {
        return new WP_REST_Response(['error' => 'api_key_missing'], 500);
    }

    // Läuft dieser Artikel schon? Ein Transient ist die einzige Sperre, die
    // sich mehrere PHP-Prozesse teilen; `add` ist atomar, `set` wäre es nicht.
    $sperre = 'aiac_lock_' . $article_id;
    if (get_transient($sperre) !== false) {
        return new WP_REST_Response(['status' => 'already_processing', 'article_id' => $article_id], 202);
    }
    set_transient($sperre, 1, 5 * MINUTE_IN_SECONDS);

    // Die Arbeit in einen Cron-Lauf legen, der unmittelbar nach dieser Antwort
    // startet. WordPress hat keinen Hintergrund-Thread; das ist der übliche Weg.
    wp_schedule_single_event(time(), 'aiac_process_article', [$article_id, $payload]);
    // Ohne diesen Anstoß wartet der Cron auf den nächsten Seitenaufruf.
    spawn_cron();

    return new WP_REST_Response(['status' => 'accepted', 'article_id' => $article_id], 202);
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
    $sperre = 'aiac_lock_' . $article_id;
    try {
        $artikel = aiac_fetch_article($article_id);
        if ($artikel === null) {
            error_log("[aiac] Artikel {$article_id} nicht abrufbar");
            return;
        }
        $post_id = aiac_upsert_post($artikel);
        if ($post_id === 0) {
            return;
        }
        $url = get_permalink($post_id);
        if (is_string($url) && $url !== '') {
            // Erst die Rückmeldung macht die URL in Visibly bekannt; ohne sie
            // kann Visibly den Beitrag später nicht gezielt aktualisieren.
            aiac_confirm_published($article_id, $url);
        }
    } finally {
        delete_transient($sperre);
    }
}

/** Einen Artikel über die Pull-API holen. `null` bei jedem Fehler. */
function aiac_fetch_article(int $article_id): ?array
{
    $basis = rtrim(aiac_option('aiac_base_url', 'AIAC_BASE_URL', AIAC_DEFAULT_BASE), '/');
    $key   = aiac_option('aiac_api_key', 'AIAC_API_KEY');

    $antwort = wp_remote_get(
        "{$basis}/api/v1/articles/{$article_id}?include_markdown=true",
        [
            'timeout' => 30,
            'headers' => [
                'Authorization' => "Bearer {$key}",
                'Accept'        => 'application/json',
                'User-Agent'    => 'ai-automation-connector-wp/1.0',
            ],
        ]
    );

    if (is_wp_error($antwort) || wp_remote_retrieve_response_code($antwort) !== 200) {
        return null;
    }
    $daten = json_decode(wp_remote_retrieve_body($antwort), true);
    return is_array($daten) && isset($daten['article']) ? $daten['article'] : null;
}

/**
 * Beitrag anlegen oder aktualisieren.
 *
 * Die Visibly-Artikel-ID liegt als Meta am Beitrag: darüber wird beim zweiten
 * Mal derselbe Beitrag gefunden statt ein Duplikat angelegt. Existiert kein
 * Treffer, entscheidet der Slug.
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

    $vorhanden = aiac_find_post($article_id, $slug);
    $status    = aiac_option('aiac_post_status', 'AIAC_POST_STATUS', 'draft');

    $daten = [
        'post_title'   => (string) ($artikel['title'] ?? ''),
        'post_name'    => $slug,
        'post_content' => $inhalt,
        'post_excerpt' => (string) ($artikel['meta_description'] ?? ''),
        'post_type'    => 'post',
    ];

    if ($vorhanden > 0) {
        // Beim Aktualisieren bleibt der Status, wie er ist: ein
        // veröffentlichter Beitrag wird durch eine Textänderung nicht wieder
        // zum Entwurf.
        $daten['ID'] = $vorhanden;
        $post_id = wp_update_post($daten, true);
    } else {
        $daten['post_status'] = in_array($status, ['draft', 'publish', 'pending'], true) ? $status : 'draft';
        $post_id = wp_insert_post($daten, true);
    }

    if (is_wp_error($post_id)) {
        error_log('[aiac] Beitrag konnte nicht geschrieben werden: ' . $post_id->get_error_message());
        return 0;
    }

    $post_id = (int) $post_id;
    update_post_meta($post_id, '_aiac_article_id', $article_id);
    update_post_meta($post_id, '_aiac_revision', (int) ($artikel['revision'] ?? 1));
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

/** Bestehenden Beitrag über die Visibly-ID finden, sonst über den Slug. */
function aiac_find_post(int $article_id, string $slug): int
{
    $treffer = get_posts([
        'post_type'      => 'post',
        'post_status'    => 'any',
        'numberposts'    => 1,
        'fields'         => 'ids',
        'meta_key'       => '_aiac_article_id',
        'meta_value'     => $article_id,
    ]);
    if ($treffer) {
        return (int) $treffer[0];
    }

    $per_slug = get_posts([
        'post_type'   => 'post',
        'post_status' => 'any',
        'numberposts' => 1,
        'fields'      => 'ids',
        'name'        => $slug,
    ]);
    return $per_slug ? (int) $per_slug[0] : 0;
}

/** Veröffentlichung an Visibly zurückmelden. */
function aiac_confirm_published(int $article_id, string $url): bool
{
    $basis = rtrim(aiac_option('aiac_base_url', 'AIAC_BASE_URL', AIAC_DEFAULT_BASE), '/');
    $key   = aiac_option('aiac_api_key', 'AIAC_API_KEY');

    $antwort = wp_remote_post(
        "{$basis}/api/v1/articles/{$article_id}/confirm",
        [
            'timeout' => 30,
            'headers' => [
                'Authorization' => "Bearer {$key}",
                'Content-Type'  => 'application/json',
                'User-Agent'    => 'ai-automation-connector-wp/1.0',
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
    register_setting(AIAC_OPTION_GROUP, 'aiac_base_url', ['sanitize_callback' => 'esc_url_raw']);
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
                        <p class="description"><code>lc_…</code> (account) or <code>cp_…</code> (project).</p>
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
                        <p class="description">Leave as is unless you run your own installation.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}
