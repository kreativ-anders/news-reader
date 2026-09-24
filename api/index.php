<?php
/**
 * FeedForge – GET /api/?url=<encoded-url>[&refresh=1][&limit=50]
 *
 * Resolves any website / feed URL into normalized JSON entries.
 * Results are cached per source URL for 24 h (shared across all clients).
 *
 * /api/sync is routed to src/sync.php (Flint client state, see README).
 */
declare(strict_types=1);

require __DIR__ . '/../src/config.php';
require __DIR__ . '/../src/http.php';
require __DIR__ . '/../src/parsers.php';
require __DIR__ . '/../src/cache.php';
require __DIR__ . '/../src/resolver.php';

// Flint sync store: /api/sync (same front controller, separate handler)
$ffPath = (string)parse_url((string)($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
if (preg_match('#/api/sync/?$#', $ffPath)) {
    require __DIR__ . '/../src/sync.php';
    ini_set('display_errors', '0');
    ini_set('log_errors', '1');
    ff_sync_handle();
}

set_time_limit(90);
ini_set('display_errors', '0'); // warnings must never corrupt the JSON output
ini_set('log_errors', '1');

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('X-Content-Type-Options: nosniff');

$missing = array_values(array_filter(['dom', 'libxml', 'mbstring'], fn($e) => !extension_loaded($e)));
if ($missing) {
    ff_respond(['error' => [
        'code'    => 'SERVER_MISCONFIGURED',
        'message' => 'Enable these PHP extensions in php.ini: ' . implode(', ', $missing),
    ]], 500);
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    ff_respond(['error' => ['code' => 'METHOD_NOT_ALLOWED', 'message' => 'Use GET.']], 405);
}

// ------------------------------------------------------------------ input

$url = trim((string)($_GET['url'] ?? ''));
$forceRefresh = in_array(strtolower((string)($_GET['refresh'] ?? '')), ['1', 'true', 'yes'], true);
$limit = max(1, min(FF_MAX_ENTRIES, (int)($_GET['limit'] ?? FF_MAX_ENTRIES)));

if ($url === '') {
    ff_respond([
        'name'    => 'FeedForge',
        'version' => FF_VERSION,
        'usage'   => 'GET /api/?url=<url-encoded website or feed URL>[&refresh=1][&limit=1..' . FF_MAX_ENTRIES . ']',
        'example' => '/api/?url=' . rawurlencode('https://www.anthropic.com/news'),
    ], 400);
}

// Allow "example.com/news" without scheme
if (!preg_match('#^[a-z][a-z0-9+.-]*://#i', $url)) {
    $url = 'https://' . $url;
}
if (!filter_var($url, FILTER_VALIDATE_URL)) {
    ff_respond(['error' => ['code' => 'INVALID_URL', 'message' => 'Provide a valid HTTP(S) URL in the "url" parameter.']], 400);
}
if (($invalid = ff_validate_target($url)) !== null) {
    ff_respond(['error' => ['code' => $invalid['code'], 'message' => $invalid['message']]], 400);
}

// ------------------------------------------------------------------ cache

$cached = ff_cache_read($url);

if ($cached !== null) {
    $isError = isset($cached['data']['error']);
    $ttl = $isError ? FF_ERROR_TTL : FF_CACHE_TTL;
    $refreshAllowed = $forceRefresh && $cached['age'] >= FF_REFRESH_MIN_AGE;

    if ($cached['age'] < $ttl && !$refreshAllowed) {
        ff_serve_cached($cached, 'HIT', $limit);
    }
}

// ------------------------------------------------------------------ refresh (one process per URL)

$lock = ff_lock($url, false);

if ($lock === null) {
    // Another request is refreshing right now.
    if ($cached !== null && !isset($cached['data']['error'])) {
        ff_serve_cached($cached, 'STALE', $limit);
    }
    $lock = ff_lock($url, true); // wait for the other refresh, then re-check
    $fresh = ff_cache_read($url);
    if ($fresh !== null && $fresh['age'] < (isset($fresh['data']['error']) ? FF_ERROR_TTL : FF_CACHE_TTL)) {
        ff_unlock($lock);
        ff_serve_cached($fresh, 'HIT', $limit);
    }
}

$result = ff_resolve($url);

if ($result['ok']) {
    ff_cache_write($url, $result['payload']);
    ff_unlock($lock);
    ff_serve_cached(ff_cache_read($url), 'MISS', $limit);
}

// Upstream failed: fall back to stale data if we have it
if ($cached !== null && !isset($cached['data']['error']) && $cached['age'] < FF_STALE_TTL) {
    ff_unlock($lock);
    $cached['data']['meta']['lastError'] = ['code' => $result['code'], 'message' => $result['message']];
    ff_serve_cached($cached, 'STALE', $limit);
}

$error = ['code' => $result['code'], 'message' => $result['message']];
if (isset($result['tried'])) $error['tried'] = $result['tried'];
if (isset($result['status'])) $error['upstreamStatus'] = $result['status'];

// Cache "no feed" results briefly to protect the source from repeated probing
if ($result['code'] === 'NO_FEED_DETECTED') {
    ff_cache_write($url, ['error' => $error]);
}
ff_unlock($lock);

ff_respond(['error' => $error, 'meta' => ['cached' => false]], 422);

// ------------------------------------------------------------------ helpers

function ff_serve_cached(array $cached, string $state, int $limit): never
{
    $data = $cached['data'];
    $cachedAt = (int)$data['cachedAt'];
    unset($data['cachedAt']);

    header('X-FeedForge-Cache: ' . $state);

    if (isset($data['error'])) {
        header('Cache-Control: public, max-age=' . max(0, FF_ERROR_TTL - $cached['age']));
        ff_respond(['error' => $data['error'], 'meta' => [
            'cached'           => true,
            'cachedAt'         => gmdate('Y-m-d\TH:i:s\Z', $cachedAt),
            'nextRefreshAfter' => gmdate('Y-m-d\TH:i:s\Z', $cachedAt + FF_ERROR_TTL),
        ]], 422);
    }

    $data['entries'] = array_slice($data['entries'], 0, $limit);
    $data['meta']['count']            = count($data['entries']);
    $data['meta']['cached']           = $state !== 'MISS';
    $data['meta']['stale']            = $state === 'STALE';
    $data['meta']['cachedAt']         = gmdate('Y-m-d\TH:i:s\Z', $cachedAt);
    $data['meta']['nextRefreshAfter'] = gmdate('Y-m-d\TH:i:s\Z', $cachedAt + FF_CACHE_TTL);
    $data['meta']['version']          = FF_VERSION;

    header('Cache-Control: public, max-age=' . max(0, FF_CACHE_TTL - (time() - $cachedAt)));
    ff_respond($data, 200);
}

function ff_respond(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}
