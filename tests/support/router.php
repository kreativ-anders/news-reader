<?php
/**
 * Router for PHP's built-in web server – mirrors nginx.conf.example for the tests:
 *   /api/*                     → api/index.php (front controller)
 *   /src, /var, /tools, /tests, /gherkin → 404 (never served)
 *   dotfiles, *.vault, *.php   → 404
 *   every 404                  → 404.html in the language of the address or the browser
 *   everything else            → static file (directories serve index.html)
 *
 *   php -S 127.0.0.1:8080 -t <docroot> tests/support/router.php
 */
declare(strict_types=1);

$root = $_SERVER['DOCUMENT_ROOT'];
$path = rawurldecode((string)parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH));

if (preg_match('#^/api(/|$)#', $path)) {
    chdir($root . '/api');
    require $root . '/api/index.php';
    return true;
}

// INFO: like error_page + map $news_reader_404 in the nginx configs – language of the address, else the first browser language
$notFound = function () use ($root, $path): bool {
    $lang = preg_match('#^/(de|fr|it|es)/#', $path, $m) ? $m[1]
        : (preg_match('#^(de|fr|it|es)#', (string)($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''), $m) ? $m[1] : '');
    http_response_code(404);
    header('Content-Type: text/html; charset=utf-8');
    readfile($root . ($lang ? "/$lang" : '') . '/404.html');
    return true;
};

if (preg_match('#^/(src|var|tools|tests|gherkin|node_modules)(/|$)#', $path)
    || preg_match('#/\.#', $path)
    || preg_match('#\.(vault|php|md|example|lock)$#i', $path)) {
    return $notFound();
}
$file = $root . $path;
if (!is_file($file) && !(is_dir($file) && is_file(rtrim($file, '/') . '/index.html'))) return $notFound();

// the built-in server does not know these types
$types = ['webmanifest' => 'application/manifest+json', 'woff2' => 'font/woff2', 'mjs' => 'text/javascript'];
$ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
if (isset($types[$ext]) && is_file($root . $path)) {
    header('Content-Type: ' . $types[$ext]);
    readfile($root . $path);
    return true;
}

return false;
