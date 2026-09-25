<?php
/**
 * News Reader – front controller for the whole API.
 *
 *   GET /api/collect?url=<encoded-url>[&refresh=1][&limit=50]   Collector (alias: /api/?url=…)
 *       Resolves any website / feed URL into normalized JSON entries.
 *       Results are cached per source URL for 24 h (shared across all clients).
 *   GET|PUT|DELETE /api/sync                                     encrypted sync vault (src/sync.php)
 */
declare(strict_types=1);

require __DIR__ . '/../src/config.php';
require __DIR__ . '/../src/http.php';
require __DIR__ . '/../src/parsers.php';
require __DIR__ . '/../src/cache.php';
require __DIR__ . '/../src/rules.php';
require __DIR__ . '/../src/resolver.php';
require __DIR__ . '/../src/ratelimit.php';

ini_set('display_errors', '0'); // warnings must never corrupt the output
ini_set('log_errors', '1');

$nrPath = (string)parse_url((string)($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
if (preg_match('#/api/sync/?$#', $nrPath)) {
    require __DIR__ . '/../src/sync.php';
    nr_sync_handle();
}
if (!preg_match('#/api/(collect/?|index\.php)?$#', $nrPath)) {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":{"code":"NOT_FOUND","message":"Unknown endpoint. Use /api/collect or /api/sync."}}';
    exit;
}

set_time_limit(90);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('X-Content-Type-Options: nosniff');

$missing = array_values(array_filter(['dom', 'libxml', 'mbstring'], fn($e) => !extension_loaded($e)));
if ($missing) {
    nr_respond(['error' => [
        'code'    => 'SERVER_MISCONFIGURED',
        'message' => 'Enable these PHP extensions in php.ini: ' . implode(', ', $missing),
    ]], 500);
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    nr_respond(['error' => ['code' => 'METHOD_NOT_ALLOWED', 'message' => 'Use GET.']], 405);
}

// ------------------------------------------------------------------ input

$url = trim((string)($_GET['url'] ?? ''));
$forceRefresh = in_array(strtolower((string)($_GET['refresh'] ?? '')), ['1', 'true', 'yes'], true);
$limit = max(1, min(NR_MAX_ENTRIES, (int)($_GET['limit'] ?? NR_MAX_ENTRIES)));

if ($url === '') {
    nr_respond([
        'name'    => 'News Reader Collector',
        'service' => 'collector',
        'version' => NR_VERSION,
        'sync'    => NR_SYNC_ENABLED,
        'usage'   => 'GET /api/collect?url=<url-encoded website or feed URL>[&refresh=1][&limit=1..' . NR_MAX_ENTRIES . ']',
        'example' => '/api/collect?url=' . rawurlencode('https://www.anthropic.com/news'),
    ], 400);
}

// Allow "example.com/news" without scheme
if (!preg_match('#^[a-z][a-z0-9+.-]*://#i', $url)) {
    $url = 'https://' . $url;
}
if (!filter_var($url, FILTER_VALIDATE_URL)) {
    nr_respond(['error' => ['code' => 'INVALID_URL', 'message' => 'Provide a valid HTTP(S) URL in the "url" parameter.']], 400);
}
if (($invalid = nr_validate_target($url)) !== null) {
    nr_respond(['error' => ['code' => $invalid['code'], 'message' => $invalid['message']]], 400);
}

// ------------------------------------------------------------------ cache

$cached = nr_cache_read($url);

if ($cached !== null) {
    $isError = isset($cached['data']['error']);
    $ttl = $isError ? NR_ERROR_TTL : NR_CACHE_TTL;
    $refreshAllowed = $forceRefresh && $cached['age'] >= NR_REFRESH_MIN_AGE;

    if ($cached['age'] < $ttl && !$refreshAllowed) {
        nr_serve_cached($cached, 'HIT', $limit);
    }
}

// ------------------------------------------------------------------ rate limit (only upstream fetches count)

if ($wait = nr_rate_hit('collect', NR_RATE_COLLECT_MISS)) {
    if ($cached !== null && !isset($cached['data']['error'])) {
        nr_serve_cached($cached, 'STALE', $limit);
    }
    nr_rate_reject($wait);
}

// ------------------------------------------------------------------ refresh (one process per URL)

$lock = nr_lock($url, false);

if ($lock === null) {
    // Another request is refreshing right now.
    if ($cached !== null && !isset($cached['data']['error'])) {
        nr_serve_cached($cached, 'STALE', $limit);
    }
    $lock = nr_lock($url, true); // wait for the other refresh, then re-check
    $fresh = nr_cache_read($url);
    if ($fresh !== null && $fresh['age'] < (isset($fresh['data']['error']) ? NR_ERROR_TTL : NR_CACHE_TTL)) {
        nr_unlock($lock);
        nr_serve_cached($fresh, 'HIT', $limit);
    }
}

$result = nr_resolve($url);

if ($result['ok']) {
    nr_cache_write($url, $result['payload']);
    nr_unlock($lock);
    nr_serve_cached(nr_cache_read($url), 'MISS', $limit);
}

// Upstream failed: fall back to stale data if we have it
if ($cached !== null && !isset($cached['data']['error']) && $cached['age'] < NR_STALE_TTL) {
    nr_unlock($lock);
    $cached['data']['meta']['lastError'] = ['code' => $result['code'], 'message' => $result['message']];
    nr_serve_cached($cached, 'STALE', $limit);
}

$error = ['code' => $result['code'], 'message' => $result['message']];
if (isset($result['tried'])) $error['tried'] = $result['tried'];
if (isset($result['status'])) $error['upstreamStatus'] = $result['status'];
if (isset($result['rule'])) $error['rule'] = $result['rule'];

// Cache "no feed" results briefly to protect the source from repeated probing
if (in_array($result['code'], ['NO_FEED_DETECTED', 'PLATFORM_NO_FEED'], true)) {
    nr_cache_write($url, ['error' => $error]);
}
nr_unlock($lock);

nr_respond(['error' => $error, 'meta' => ['cached' => false]], 422);

// ------------------------------------------------------------------ helpers

function nr_serve_cached(array $cached, string $state, int $limit): never
{
    $data = $cached['data'];
    $cachedAt = (int)$data['cachedAt'];
    unset($data['cachedAt']);

    header('X-Collector-Cache: ' . $state);

    if (isset($data['error'])) {
        header('Cache-Control: public, max-age=' . max(0, NR_ERROR_TTL - $cached['age']));
        nr_respond(['error' => $data['error'], 'meta' => [
            'cached'           => true,
            'cachedAt'         => gmdate('Y-m-d\TH:i:s\Z', $cachedAt),
            'nextRefreshAfter' => gmdate('Y-m-d\TH:i:s\Z', $cachedAt + NR_ERROR_TTL),
        ]], 422);
    }

    $data['entries'] = array_slice($data['entries'], 0, $limit);
    $data['meta']['count']            = count($data['entries']);
    $data['meta']['cached']           = $state !== 'MISS';
    $data['meta']['stale']            = $state === 'STALE';
    $data['meta']['cachedAt']         = gmdate('Y-m-d\TH:i:s\Z', $cachedAt);
    $data['meta']['nextRefreshAfter'] = gmdate('Y-m-d\TH:i:s\Z', $cachedAt + NR_CACHE_TTL);
    $data['meta']['version']          = NR_VERSION;

    header('Cache-Control: public, max-age=' . max(0, NR_CACHE_TTL - (time() - $cachedAt)));
    nr_respond($data, 200);
}

function nr_respond(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}
