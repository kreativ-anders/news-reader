<?php
/**
 * Fixture web server for the integration and E2E tests – a tiny fake "internet".
 *
 *   php -S 127.0.0.1:8090 tests/fixtures/router.php
 *
 * Serves tests/fixtures/www/ with placeholders expanded, so dates are always recent
 * and absolute links point back to this server:
 *   {{base}}    http://127.0.0.1:<port>
 *   {{date:N}}  RFC 2822 date, N days ago (RSS)
 *   {{iso:N}}   ISO 8601 date, N days ago (Atom, sitemaps, HTML)
 *
 * Special routes simulate upstream failures (see $special below).
 */
declare(strict_types=1);

$path = (string)parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$base = 'http://' . ($_SERVER['HTTP_HOST'] ?? '127.0.0.1');

$special = [
    '/redirect'     => fn() => redirect('/feeds/rss.xml'),
    '/redirect-2'   => fn() => redirect('/redirect'),
    '/loop'         => fn() => redirect('/loop'),
    '/to-private'   => fn() => redirect('http://10.0.0.1/feed.xml'),
    '/missing'      => fn() => status(404, 'not found'),
    '/server-error' => fn() => status(500, 'boom'),
    '/too-large'    => fn() => send('text/html', '<!doctype html><html><body>' . str_repeat('<p>large</p>', 500_000) . '</body></html>'),
    '/text.txt'     => fn() => send('text/plain', "just some text\n"),
    '/slow'         => function () { sleep(3); send('application/rss+xml', expand(file_get_contents(__DIR__ . '/www/feeds/rss.xml'))); },
    '/guess/feed'   => fn() => send('application/atom+xml', expand(file_get_contents(__DIR__ . '/www/feeds/atom.xml'))),
];

if (isset($special[$path])) {
    $special[$path]();
    exit;
}

$file = realpath(__DIR__ . '/www' . (str_ends_with($path, '/') ? $path . 'index.html' : $path));
if ($file === false || !str_starts_with($file, realpath(__DIR__ . '/www')) || !is_file($file)) {
    status(404, 'not found');
    exit;
}

$types = ['xml' => 'application/xml', 'html' => 'text/html; charset=utf-8', 'txt' => 'text/plain', 'opml' => 'text/xml', 'svg' => 'image/svg+xml'];
$type = $types[pathinfo($file, PATHINFO_EXTENSION)] ?? 'application/octet-stream';
if (str_contains($path, '/feeds/rss')) $type = 'application/rss+xml';
if (str_contains($path, '/feeds/atom')) $type = 'application/atom+xml';
send($type, expand((string)file_get_contents($file)));

function expand(string $s): string
{
    global $base;
    $s = str_replace('{{base}}', $base, $s);
    return (string)preg_replace_callback('/\{\{(date|iso):(\d+(?:\.\d+)?)\}\}/', function ($m) {
        $ts = time() - (int)round((float)$m[2] * 86400);
        return $m[1] === 'date' ? gmdate(DATE_RSS, $ts) : gmdate('Y-m-d\TH:i:s\Z', $ts);
    }, $s);
}

function send(string $type, string $body): void
{
    header('Content-Type: ' . $type);
    header('Content-Length: ' . strlen($body));
    echo $body;
}

function status(int $code, string $body): void
{
    http_response_code($code);
    send('text/plain', $body);
}

function redirect(string $to): void
{
    http_response_code(302);
    header('Location: ' . $to);
}
