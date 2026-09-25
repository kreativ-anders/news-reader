<?php
declare(strict_types=1);

/** Shared per-URL file cache. The cache belongs to the source URL, never to a user. */

/**
 * $ns separates cache kinds for the same URL ('' = Collector feed, 'article' = extracted article).
 */
function nr_cache_path(string $url, string $ext = 'json', string $ns = ''): string
{
    if (!is_dir(NR_CACHE_DIR)) {
        mkdir(NR_CACHE_DIR, 0775, true);
    }
    return NR_CACHE_DIR . '/' . hash('sha256', ($ns !== '' ? $ns . '|' : '') . nr_normalize_url($url)) . '.' . $ext;
}

/** @return array{data:array, age:int}|null */
function nr_cache_read(string $url, string $ns = ''): ?array
{
    $file = nr_cache_path($url, 'json', $ns);
    if (!is_file($file)) return null;

    $data = json_decode((string)@file_get_contents($file), true);
    if (!is_array($data) || !isset($data['cachedAt']) || ($data['schema'] ?? 1) !== NR_CACHE_SCHEMA) return null;

    return ['data' => $data, 'age' => time() - (int)$data['cachedAt']];
}

function nr_cache_write(string $url, array $data, string $ns = ''): void
{
    $data['cachedAt'] = time();
    $data['schema'] = NR_CACHE_SCHEMA;
    $file = nr_cache_path($url, 'json', $ns);
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    rename($tmp, $file); // atomic replace
}

/**
 * Per-URL lock so that concurrent requests do not hit the source in parallel.
 * @return resource|null  null if $wait=false and another process holds it
 */
function nr_lock(string $url, bool $wait, string $ns = '')
{
    $fp = fopen(nr_cache_path($url, 'lock', $ns), 'c');
    if ($fp === false) return null;
    if (!flock($fp, LOCK_EX | ($wait ? 0 : LOCK_NB))) {
        fclose($fp);
        return null;
    }
    return $fp;
}

function nr_unlock($fp): void
{
    if (is_resource($fp)) {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}
