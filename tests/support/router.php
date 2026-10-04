<?php
/**
 * Router for PHP's built-in web server – mirrors nginx.conf.example for the tests:
 *   /api/*                     → api/index.php (front controller)
 *   /src, /var, /tools, /tests, /gherkin → 404 (never served)
 *   dotfiles, *.vault, *.php   → 404
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

if (preg_match('#^/(src|var|tools|tests|gherkin|node_modules)(/|$)#', $path)
    || preg_match('#/\.#', $path)
    || preg_match('#\.(vault|php|md|example|lock)$#i', $path)) {
    http_response_code(404);
    header('Content-Type: text/plain');
    echo 'not found';
    return true;
}

// the built-in server does not know these types
$types = ['webmanifest' => 'application/manifest+json', 'woff2' => 'font/woff2', 'mjs' => 'text/javascript'];
$ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
if (isset($types[$ext]) && is_file($root . $path)) {
    header('Content-Type: ' . $types[$ext]);
    readfile($root . $path);
    return true;
}

return false;
