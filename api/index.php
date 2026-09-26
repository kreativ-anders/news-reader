<?php
declare(strict_types=1);

// INFO: front controller for the whole API (README → Collector, Articles, Sync)
//       GET /api/collect?url=…   GET /api/article?url=…   GET|PUT|DELETE /api/sync

ini_set('display_errors', '0'); // WARNING: warnings must never corrupt the JSON output
ini_set('log_errors', '1');

require __DIR__ . '/../src/config.php';
require __DIR__ . '/../src/response.php';
require __DIR__ . '/../src/ratelimit.php';

$nrPath = (string)parse_url((string)($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);

if (preg_match('#/api/sync/?$#', $nrPath)) {
    require __DIR__ . '/../src/sync.php';
    nr_sync_handle();
}

$missing = array_values(array_filter(['dom', 'libxml', 'mbstring'], fn($e) => !extension_loaded($e)));
if ($missing) {
    nr_error('SERVER_MISCONFIGURED', 'Enable these PHP extensions in php.ini: ' . implode(', ', $missing), 500);
}

require __DIR__ . '/../src/http.php';
require __DIR__ . '/../src/cache.php';
require __DIR__ . '/../src/parsers.php';
require __DIR__ . '/../src/readable.php';

if (preg_match('#/api/article/?$#', $nrPath)) {
    set_time_limit(NR_TIME_BUDGET + 30);
    nr_article_handle();
}
if (!preg_match('#/api/(collect/?|index\.php)?$#', $nrPath)) {
    nr_error('NOT_FOUND', 'Unknown endpoint. Use /api/collect, /api/article or /api/sync.', 404);
}

require __DIR__ . '/../src/rules.php';
require __DIR__ . '/../src/resolver.php';

set_time_limit(NR_TIME_BUDGET + 30);
nr_api_headers('GET');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($method !== 'GET') {
    nr_error('METHOD_NOT_ALLOWED', 'Use GET.', 405);
}

$url = trim((string)($_GET['url'] ?? ''));
$forceRefresh = in_array(strtolower((string)($_GET['refresh'] ?? '')), ['1', 'true', 'yes'], true);
$limit = max(1, min(NR_MAX_ENTRIES, (int)($_GET['limit'] ?? NR_MAX_ENTRIES)));

if ($url === '') {
    nr_json([
        'name'    => 'News Reader Collector',
        'service' => 'collector',
        'version' => NR_VERSION,
        'sync'    => NR_SYNC_ENABLED,
        'usage'   => 'GET /api/collect?url=<url-encoded website or feed URL>[&refresh=1][&limit=1..' . NR_MAX_ENTRIES . ']',
        'example' => '/api/collect?url=' . rawurlencode('https://www.anthropic.com/news'),
    ], 400);
}

if (!preg_match('#^[a-z][a-z0-9+.-]*://#i', $url)) {
    $url = 'https://' . $url;
}
if (!nr_is_http_url($url) || !filter_var($url, FILTER_VALIDATE_URL)) {
    nr_error('INVALID_URL', 'Provide a valid HTTP(S) URL in the "url" parameter.', 400);
}
if (($invalid = nr_validate_target($url)) !== null) {
    nr_error($invalid['code'], $invalid['message'], 400);
}

$cached = nr_cache_read($url);
$usable = $cached !== null && !isset($cached['data']['error']);

if ($cached !== null) {
    $ttl = $usable ? NR_CACHE_TTL : NR_ERROR_TTL;
    $refreshAllowed = $forceRefresh && $cached['age'] >= NR_REFRESH_MIN_AGE;
    if ($cached['age'] < $ttl && !$refreshAllowed) {
        nr_serve_cached($cached, 'HIT', $limit);
    }
}

// INFO: only upstream fetches count against the rate limit
if ($wait = nr_rate_hit('collect', NR_RATE_COLLECT_MISS)) {
    if ($usable) nr_serve_cached($cached, 'STALE', $limit);
    nr_rate_reject($wait);
}

// INFO: one refresh per URL at a time – others get stale data or wait for the result
$lock = nr_lock($url, false);
if ($lock === null) {
    if ($usable) nr_serve_cached($cached, 'STALE', $limit);
    $lock = nr_lock($url, true);
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
    nr_serve_cached(['data' => $result['payload'] + ['cachedAt' => time()], 'age' => 0], 'MISS', $limit);
}

if ($usable && $cached['age'] < NR_STALE_TTL) {
    nr_unlock($lock);
    $cached['data']['meta']['lastError'] = ['code' => $result['code'], 'message' => $result['message']];
    nr_serve_cached($cached, 'STALE', $limit);
}

$error = ['code' => $result['code'], 'message' => $result['message']];
foreach (['tried' => 'tried', 'status' => 'upstreamStatus', 'rule' => 'rule'] as $from => $to) {
    if (isset($result[$from])) $error[$to] = $result[$from];
}

// INFO: "no feed" is cached briefly to protect the source from repeated probing
if (in_array($result['code'], ['NO_FEED_DETECTED', 'PLATFORM_NO_FEED'], true)) {
    nr_cache_write($url, ['error' => $error]);
}
nr_unlock($lock);

nr_json(['error' => $error, 'meta' => ['cached' => false]], 422);

function nr_serve_cached(array $cached, string $state, int $limit): never
{
    $data = $cached['data'];
    $cachedAt = (int)$data['cachedAt'];
    unset($data['cachedAt'], $data['schema']);

    header('X-Collector-Cache: ' . $state);

    if (isset($data['error'])) {
        header('Cache-Control: public, max-age=' . max(0, NR_ERROR_TTL - $cached['age']));
        nr_json(['error' => $data['error'], 'meta' => [
            'cached'           => true,
            'cachedAt'         => nr_iso($cachedAt),
            'nextRefreshAfter' => nr_iso($cachedAt + NR_ERROR_TTL),
        ]], 422);
    }

    $data['entries'] = array_map(function (array $e): array {
        unset($e['content']);
        return $e;
    }, array_slice($data['entries'], 0, $limit));
    $data['meta']['count']            = count($data['entries']);
    $data['meta']['cached']           = $state !== 'MISS';
    $data['meta']['stale']            = $state === 'STALE';
    $data['meta']['cachedAt']         = nr_iso($cachedAt);
    $data['meta']['nextRefreshAfter'] = nr_iso($cachedAt + NR_CACHE_TTL);
    $data['meta']['version']          = NR_VERSION;

    header('Cache-Control: public, max-age=' . max(0, NR_CACHE_TTL - (time() - $cachedAt)));
    nr_json($data);
}
