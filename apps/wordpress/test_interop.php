<?php
/**
 * Interop: prüft eine Signatur, die der Node-Connector erzeugt hat.
 *
 * Drei Sprachen implementieren denselben HMAC. Weichen sie ab, weist eine
 * Seite zurück, was die andere für gültig hält, und der Fehler zeigt sich erst
 * in Produktion als "invalid_signature" ohne erkennbaren Grund.
 *
 * Aufruf:  php test_interop.php <koerper-datei> <signatur> <secret>
 */

declare(strict_types=1);

define('ABSPATH', __DIR__ . '/');
define('MINUTE_IN_SECONDS', 60);
foreach (['add_action', 'add_options_page', 'register_setting', 'register_rest_route'] as $fn) {
    if (!function_exists($fn)) {
        eval("function {$fn}(...\$args) { return null; }");
    }
}
if (!function_exists('get_option')) {
    eval("function get_option(\$name, \$default = '') { return \$default; }");
}
if (!class_exists('WP_REST_Request')) { class WP_REST_Request {} }
if (!class_exists('WP_REST_Response')) { class WP_REST_Response {} }

require_once __DIR__ . '/ai-automation-connector.php';

[$_, $koerperDatei, $signatur, $secret] = $argv + [null, null, null, null];
$koerper = file_get_contents($koerperDatei);

$ok = aiac_verify_signature($koerper, $secret, $signatur);
echo $ok ? "PHP akzeptiert die Node-Signatur\n" : "PHP LEHNT die Node-Signatur AB\n";

// Gegenrichtung: PHP signiert, die Ausgabe prüft der Aufrufer in Node/Python.
echo 'php-signatur=sha256=' . hash_hmac('sha256', $koerper, $secret) . "\n";
exit($ok ? 0 : 1);
