<?php
declare(strict_types=1);
define('AIAC_PURE_TEST', true);
require __DIR__ . '/ai-automation-connector.php';
$html = '<p>a</p><figure><img src="https://app.visibly-ai.com/media/aaa.webp" alt="A" loading="lazy"></figure>';
$out = aiac_rewrite_image_urls($html, ['https://app.visibly-ai.com/media/aaa.webp' => 'https://kunde.de/wp-content/uploads/aaa.webp']);
assert(str_contains($out, 'https://kunde.de/wp-content/uploads/aaa.webp'));
assert(!str_contains($out, 'app.visibly-ai.com'));
assert(aiac_rewrite_image_urls($html, []) === $html);
echo "OK\n";
