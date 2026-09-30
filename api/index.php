<?php
declare(strict_types=1);

// INFO: front controller for the whole API (README → Collector, Articles, Sync)
//       GET|POST /api/collect?url=…   GET /api/article?url=…   GET|PUT|DELETE /api/sync

ini_set('display_errors', '0'); // WARNING: warnings must never corrupt the JSON output
ini_set('log_errors', '1');

require __DIR__ . '/../src/config.php';
require __DIR__ . '/../src/response.php';
require __DIR__ . '/../src/ratelimit.php';
require __DIR__ . '/../src/gc.php';

// INFO: minimum PHP version (README → Setup) – fail loudly instead of with subtle differences
if (PHP_VERSION_ID < 80500) {
    nr_error('SERVER_MISCONFIGURED', 'PHP 8.5 or newer is required (running ' . PHP_VERSION . ').', 500);
}

$nrPath = (string)parse_url((string)($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);

// INFO: retention periods (privacy policy) must hold without cron – src/gc.php
nr_gc_schedule(NR_RATE_DIR, 'nr_rate_gc');

if (preg_match('#/api/sync/?$#', $nrPath)) {
    require __DIR__ . '/../src/sync.php';
    nr_gc_schedule(NR_SYNC_DIR, 'nr_sync_gc');
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

nr_gc_schedule(NR_CACHE_DIR, 'nr_cache_gc');

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
nr_api_headers('GET, POST');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($method !== 'GET' && $method !== 'POST') {
    nr_error('METHOD_NOT_ALLOWED', 'Use GET (or POST for a body fetched from error.clientTry).', 405);
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

if ($method === 'POST') nr_collect_client($url, $limit);

[$key, $cached] = nr_collect_read($url);
$usable = $cached !== null && !isset($cached['data']['error']);

if ($cached !== null) {
    $ttl = nr_cache_ttl($cached, NR_CACHE_TTL, NR_ERROR_TTL);
    $refreshAllowed = $forceRefresh && $cached['age'] >= NR_REFRESH_MIN_AGE;
    if ($cached['age'] < $ttl && !$refreshAllowed) {
        nr_serve_cached($cached, 'HIT', $limit);
    }
}

// INFO: only upstream fetches count against the rate limit – checked here, counted once a slot is held,
//       so BUSY answers and waiting for another request's result cost nothing
if ($wait = nr_rate_hit_wide('collect', NR_RATE_COLLECT_MISS, NR_RATE_COLLECT_MISS_48, true)) {
    if ($usable) nr_serve_cached($cached, 'STALE', $limit);
    nr_rate_reject($wait);
}

// INFO: one refresh per URL at a time – others get stale data or wait (bounded) for the result
$lock = nr_lock($key, 0);
if ($lock === false) {
    if ($usable) nr_serve_cached($cached, 'STALE', $limit);
    $lock = nr_lock($key, NR_LOCK_WAIT);
    if ($lock === false) nr_busy();
    [, $fresh] = nr_collect_read($url);
    if ($fresh !== null && $fresh['age'] < nr_cache_ttl($fresh, NR_CACHE_TTL, NR_ERROR_TTL)) {
        nr_unlock($lock);
        nr_serve_cached($fresh, 'HIT', $limit);
    }
}

if (!nr_upstream_slot()) {
    nr_unlock($lock);
    if ($usable) nr_serve_cached($cached, 'STALE', $limit);
    nr_busy('Too many upstream fetches are running – try again shortly.');
}
if ($wait = nr_rate_hit_wide('collect', NR_RATE_COLLECT_MISS, NR_RATE_COLLECT_MISS_48)) {
    nr_unlock($lock);
    if ($usable) nr_serve_cached($cached, 'STALE', $limit);
    nr_rate_reject($wait);
}

// INFO: conditional refresh of a known feed – 304 keeps the entries, anything else goes through nr_resolve()
//       (a 200 response is handed over, so the feed is not fetched twice)
$feedUrl = $cached['data']['source']['feedUrl'] ?? null;
if ($usable && !empty($cached['data']['upstream']) && is_string($feedUrl)) {
    $res = nr_fetch($feedUrl, NR_ACCEPT, $cached['data']['upstream']);
    if ($res['ok'] && $res['status'] === 304) {
        $data = $cached['data'];
        $data['meta']['fetchedAt'] = nr_iso(time());
        $data['upstream'] = nr_fetch_validators($res['finalUrl']) ?: $data['upstream'];
        unset($data['meta']['lastError']);
        nr_collect_write($url, $data);
        nr_unlock($lock);
        nr_serve_cached(['data' => ['cachedAt' => time()] + $data, 'age' => 0], 'REVALIDATED', $limit);
    }
    if ($res['ok']) nr_fetch_prime($feedUrl, $res);
}

$result = nr_resolve($url);

if ($result['ok']) {
    $source = $result['payload']['source'];
    if (in_array($source['type'], ['rss', 'rdf', 'atom'], true) && $source['feedUrl'] !== null) {
        $validators = nr_fetch_validators($source['feedUrl']);
        if ($validators) $result['payload']['upstream'] = $validators;
    }
    nr_collect_write($url, $result['payload']);
    nr_unlock($lock);
    nr_serve_cached(['data' => $result['payload'] + ['cachedAt' => time()], 'age' => 0], 'MISS', $limit);
}

if ($usable && $cached['age'] < NR_STALE_TTL) {
    nr_unlock($lock);
    $cached['data']['meta']['lastError'] = ['code' => $result['code'], 'message' => $result['message']]
        + (isset($result['status']) ? ['upstreamStatus' => $result['status']] : []);
    nr_serve_cached($cached, 'STALE', $limit);
}

$error = ['code' => $result['code'], 'message' => $result['message']];
foreach (['tried' => 'tried', 'status' => 'upstreamStatus', 'rule' => 'rule'] as $from => $to) {
    if (isset($result[$from])) $error[$to] = $result[$from];
}
// INFO: 401/403 = the source turns the server away (often a bot wall) – the app may still reach it itself
$blocked = in_array($result['status'] ?? 0, [401, 403], true);
if ($blocked) $error['clientTry'] = nr_client_try($url);

// INFO: "no feed" and "blocked" are cached briefly to protect the source from repeated probing, a temporary
//       failure even more briefly – otherwise every request waiting for the lock would try the dead source again
$errorTtl = nr_error_ttl($error, NR_ERROR_TTL);
if ($blocked || in_array($result['code'], ['NO_FEED_DETECTED', 'PLATFORM_NO_FEED'], true) || ($errorTtl < NR_ERROR_TTL && !$usable)) {
    nr_collect_write_error($url, $error, $errorTtl);
}
nr_unlock($lock);

nr_json(['error' => $error, 'meta' => ['cached' => false]], 422);

// INFO: POST ?url=…&from=<one of error.clientTry> with the body the app fetched itself. Parsed for this caller only:
//       the server cannot tell a genuine body from a forged one, so nothing is cached or shared (README → Collector)
function nr_collect_client(string $url, int $limit): never
{
    $from = (string)($_GET['from'] ?? '');
    $match = array_values(array_filter(nr_client_try($url), fn($u) => nr_normalize_url($u) === nr_normalize_url($from)));
    if (!nr_is_http_url($from) || $match === []) {
        nr_error('INVALID_URL', 'Provide one of the addresses from error.clientTry in the "from" parameter.', 400);
    }
    if ($wait = nr_rate_hit_wide('collect-client', NR_RATE_COLLECT_CLIENT, NR_RATE_COLLECT_CLIENT_48)) nr_rate_reject($wait);

    $tooLarge = fn() => nr_error('PAYLOAD_TOO_LARGE', 'Body larger than ' . NR_CLIENT_MAX_BYTES . ' bytes.', 413);
    if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > NR_CLIENT_MAX_BYTES) $tooLarge();
    $body = (string)file_get_contents('php://input', false, null, 0, NR_CLIENT_MAX_BYTES + 1);
    if (strlen($body) > NR_CLIENT_MAX_BYTES) $tooLarge();

    header('Cache-Control: no-store');
    $result = nr_resolve_client($url, $match[0], $body);
    if (!$result['ok']) nr_json(['error' => ['code' => $result['code'], 'message' => $result['message']]], 422);

    $data = $result['payload'];
    $data['entries'] = array_map(fn(array $e) => array_diff_key($e, ['content' => 0]), array_slice($data['entries'], 0, $limit));
    $data['meta'] = [
        'count'            => count($data['entries']),
        'fetchedAt'        => $data['meta']['fetchedAt'],
        'cached'           => false,
        'stale'            => false,
        'cachedAt'         => null,
        'nextRefreshAfter' => nr_iso(time() + NR_CLIENT_REFRESH_AFTER),
        'version'          => NR_VERSION,
    ];
    nr_json($data);
}

function nr_serve_cached(array $cached, string $state, int $limit): never
{
    $data = $cached['data'];
    $cachedAt = (int)$data['cachedAt'];
    unset($data['cachedAt'], $data['schema'], $data['upstream']);

    header('X-Collector-Cache: ' . $state);

    if (isset($data['error'])) {
        $ttl = nr_cache_ttl($cached, NR_CACHE_TTL, NR_ERROR_TTL);
        header('Cache-Control: public, max-age=' . max(0, $ttl - $cached['age']));
        nr_json(['error' => $data['error'], 'meta' => [
            'cached'           => true,
            'cachedAt'         => nr_iso($cachedAt),
            'nextRefreshAfter' => nr_iso($cachedAt + $ttl),
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
    nr_etag_check(implode('|', [$data['source']['inputUrl'] ?? '', $limit, $cachedAt, $state, $data['meta']['lastError']['code'] ?? '']));
    nr_json($data);
}
