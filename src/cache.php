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

// INFO: skipped when the disk is nearly full (the response is served anyway) – var/sync lives on the same disk
function nr_cache_write(string $url, array $data, string $ns = ''): void
{
    $free = @disk_free_space(NR_CACHE_DIR);
    if ($free !== false && $free < NR_CACHE_MIN_FREE) return;
    $data['cachedAt'] = time();
    $data['schema'] = NR_CACHE_SCHEMA;
    $file = nr_cache_path($url, 'json', $ns);
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json === false || @file_put_contents($tmp, $json) !== strlen($json) || !@rename($tmp, $file)) {
        @unlink($tmp);
        return;
    }
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

function nr_busy(string $message = 'The source is being fetched by another request – try again shortly.'): never
{
    header('Retry-After: 10');
    nr_error('BUSY', $message, 503);
}

// INFO: bounds the PHP workers tied up by slow sources: at most NR_UPSTREAM_SLOTS upstream fetches at once, and
//       NR_UPSTREAM_PER_CLIENT per client (/64). Slots are non-blocking flocks, released when the request ends.
//       Fails open if the slot files cannot be created.
function nr_upstream_slot(): bool
{
    static $held = null;
    if ($held !== null) return true;

    $take = function (array $files) {
        foreach ($files as $f) {
            $fh = @fopen($f, 'c');
            if ($fh === false) return true;
            if (flock($fh, LOCK_EX | LOCK_NB)) {
                @touch($f); // INFO: keeps per-client slot files from the rate GC while in use
                return $fh;
            }
            fclose($fh);
        }
        return false;
    };

    if (!is_dir(NR_RATE_DIR)) @mkdir(NR_RATE_DIR, 0775, true);
    $client = hash('sha256', nr_rate_salt() . '|slot|' . nr_rate_client());
    $mine = $take(array_map(fn($i) => NR_RATE_DIR . '/' . $client . '.slot' . $i, range(0, max(1, NR_UPSTREAM_PER_CLIENT) - 1)));
    if ($mine === false) return false;

    $slots = range(0, max(1, NR_UPSTREAM_SLOTS) - 1);
    shuffle($slots);
    $global = $take(array_map(fn($i) => NR_CACHE_DIR . '/.slot-' . $i, $slots));
    if ($global === false) {
        nr_unlock($mine);
        return false;
    }
    $held = [$mine, $global];
    return true;
}

function nr_unlock($fp): void
{
    if (is_resource($fp)) {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

// INFO: bounds disk usage – anyone can make the Collector cache arbitrary public URLs.
//       Old files go first, then the oldest ones until the total is below NR_CACHE_MAX_BYTES.
function nr_cache_gc(): void
{
    $limit = time() - NR_CACHE_GC_AGE;
    $files = [];
    $total = 0;
    foreach (glob(NR_CACHE_DIR . '/*', GLOB_NOSORT) ?: [] as $f) {
        $st = @stat($f);
        if ($st === false) continue;
        if ($st['mtime'] < $limit) {
            @unlink($f);
            continue;
        }
        if (str_ends_with($f, '.lock')) continue;
        $files[$f] = [$st['mtime'], $st['size']];
        $total += $st['size'];
    }
    if ($total <= NR_CACHE_MAX_BYTES) return;
    uasort($files, fn($a, $b) => $a[0] <=> $b[0]);
    foreach ($files as $f => [, $size]) {
        if ($total <= NR_CACHE_MAX_BYTES) break;
        if (@unlink($f)) $total -= $size;
    }
}
