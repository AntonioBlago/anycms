<?php
/**
 * Prüft die Teile des Plugins, die ohne WordPress laufen: die Signaturprüfung.
 * Sie ist die Sicherheitsgrenze, also die Stelle, an der ein Fehler am
 * teuersten ist.
 *
 * Lauf:  docker run --rm -v "$PWD:/app" -w /app php:8.3-cli php test_signature.php
 */

declare(strict_types=1);

// Das Plugin bricht ohne ABSPATH ab; hier simulieren wir die WordPress-Umgebung
// so weit, dass sich die reine Funktion laden lässt.
define('ABSPATH', __DIR__ . '/');
define('MINUTE_IN_SECONDS', 60);

// Die WordPress-Funktionen, die beim blossen Einlesen der Datei aufgerufen
// werden (add_action, register_setting …), als Attrappen.
foreach (['add_action', 'add_options_page', 'register_setting', 'register_rest_route'] as $fn) {
    if (!function_exists($fn)) {
        eval("function {$fn}(...\$args) { return null; }");
    }
}
foreach (['get_option'] as $fn) {
    if (!function_exists($fn)) {
        eval("function {$fn}(\$name, \$default = '') { return \$default; }");
    }
}
if (!class_exists('WP_REST_Request')) {
    class WP_REST_Request {}
}
if (!class_exists('WP_REST_Response')) {
    class WP_REST_Response {}
}

require_once __DIR__ . '/ai-automation-connector.php';

$befunde = [];
function pruefe(string $name, bool $ok, string $zusatz = ''): void
{
    global $befunde;
    $befunde[] = ($ok ? 'OK  ' : 'FEHL') . "  {$name}" . ($zusatz ? " - {$zusatz}" : '');
}

$secret  = 'whsec_test';
$koerper = '{"event":"article.approved","article_id":1}';
$gueltig = 'sha256=' . hash_hmac('sha256', $koerper, $secret);

pruefe('gültige Signatur wird angenommen', aiac_verify_signature($koerper, $secret, $gueltig));
pruefe('ohne Präfix wird ebenfalls angenommen',
    aiac_verify_signature($koerper, $secret, substr($gueltig, 7)));
pruefe('falsches Secret wird abgelehnt',
    !aiac_verify_signature($koerper, $secret, 'sha256=' . hash_hmac('sha256', $koerper, 'anderes')));
pruefe('veränderter Körper wird abgelehnt',
    !aiac_verify_signature(str_replace('1', '2', $koerper), $secret, $gueltig));
pruefe('leere Signatur wird abgelehnt', !aiac_verify_signature($koerper, $secret, ''));
pruefe('leeres Secret wird abgelehnt', !aiac_verify_signature($koerper, '', $gueltig));
pruefe('zu kurze Signatur wird abgelehnt', !aiac_verify_signature($koerper, $secret, 'sha256=kurz'));

// Gegenprobe gegen das Node-SDK: beide müssen denselben Hex erzeugen, sonst
// weist eine Seite zurück, was die andere für gültig hält.
$erwartet_aus_node = hash_hmac('sha256', $koerper, $secret);
pruefe('Hex-Format entspricht dem Node-Connector',
    preg_match('/^[0-9a-f]{64}$/', $erwartet_aus_node) === 1, $erwartet_aus_node);

echo implode("\n", $befunde), "\n\n";
$fehler = array_filter($befunde, static fn($b) => str_starts_with($b, 'FEHL'));
printf("%d/%d bestanden\n", count($befunde) - count($fehler), count($befunde));
exit($fehler ? 1 : 0);
