<?php
declare(strict_types=1);

// INFO: shared per-URL file cache – it belongs to the source URL, never to a user.
//       $ns separates cache kinds for the same URL ('' = Collector feed, 'article' = extracted article).
function nr_cache_path(string $url, string $ext = 'json', string $ns = ''): string
{
    if (!is_dir(NR_CACHE_DIR)) {
        @mkdir(NR_CACHE_DIR, 0775, true);
    }
    return NR_CACHE_DIR . '/' . hash('sha256', ($ns !== '' ? $ns . '|' : '') . nr_normalize_url($url)) . '.' . $ext;
}

function nr_cache_read(string $url, string $ns = ''): ?array
{
    $raw = @file_get_contents(nr_cache_path($url, 'json', $ns));
    if ($raw === false) return null;

    $data = json_decode($raw, true);
    if (!is_array($data) || !isset($data['cachedAt']) || ($data['schema'] ?? 1) !== NR_CACHE_SCHEMA) return null;

    return ['data' => $data, 'age' => time() - (int)$data['cachedAt']];
}

function nr_cache_write(string $url, array $data, string $ns = ''): void
{
    $data['cachedAt'] = time();
    $data['schema'] = NR_CACHE_SCHEMA;
    $file = nr_cache_path($url, 'json', $ns);
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json === false || @file_put_contents($tmp, $json) !== strlen($json) || !@rename($tmp, $file)) {
        @unlink($tmp);
        return;
    }
    if (random_int(1, 500) === 1) nr_cache_gc();
}

// INFO: per-URL lock so that concurrent requests do not hit the source in parallel. Waits at most $wait
//       seconds (0 = not at all) – a blocking flock() would tie up PHP workers for as long as a slow source
//       takes, and that time does not count against max_execution_time.
//       Returns the handle, false if another process holds it, null if no lock file can be created.
function nr_lock(string $url, float $wait, string $ns = '')
{
    $path = nr_cache_path($url, 'lock', $ns);
    $fp = @fopen($path, 'c');
    if ($fp === false) return null;
    $deadline = microtime(true) + $wait;
    while (!flock($fp, LOCK_EX | LOCK_NB)) {
        if (microtime(true) >= $deadline) {
            fclose($fp);
            return false;
        }
        usleep(100_000);
    }
    @touch($path); // INFO: the lock file is never written – without this, the GC deletes it while in use
    return $fp;
}

// INFO: cached error entries carry their own lifetime ('ttl'); temporary upstream failures only a short one
function nr_error_ttl(array $error, int $default): int
{
    $status = (int)($error['upstreamStatus'] ?? 0);
    $transient = ($error['code'] ?? '') === 'UPSTREAM_FETCH_FAILED'
        || (($error['code'] ?? '') === 'UPSTREAM_HTTP_ERROR' && ($status >= 500 || $status === 429));
    return $transient ? NR_TRANSIENT_ERROR_TTL : $default;
}

function nr_cache_ttl(array $cached, int $ttl, int $errorTtl): int
{
    return isset($cached['data']['error']) ? (int)($cached['data']['ttl'] ?? $errorTtl) : $ttl;
}

function nr_busy(): never
{
    header('Retry-After: 10');
    nr_error('BUSY', 'The source is being fetched by another request – try again shortly.', 503);
}

function nr_unlock($fp): void
{
    if (is_resource($fp)) {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

// INFO: bounds disk usage – anyone can make the Collector cache arbitrary public URLs
function nr_cache_gc(): void
{
    $limit = time() - NR_CACHE_GC_AGE;
    foreach (glob(NR_CACHE_DIR . '/*', GLOB_NOSORT) ?: [] as $f) {
        if (@filemtime($f) < $limit) @unlink($f);
    }
}
