<?php
declare(strict_types=1);

/** Shared per-URL file cache. The cache belongs to the source URL, never to a user. */

function ff_cache_path(string $url, string $ext = 'json'): string
{
    if (!is_dir(FF_CACHE_DIR)) {
        mkdir(FF_CACHE_DIR, 0775, true);
    }
    return FF_CACHE_DIR . '/' . hash('sha256', ff_normalize_url($url)) . '.' . $ext;
}

/** @return array{data:array, age:int}|null */
function ff_cache_read(string $url): ?array
{
    $file = ff_cache_path($url);
    if (!is_file($file)) return null;

    $data = json_decode((string)@file_get_contents($file), true);
    if (!is_array($data) || !isset($data['cachedAt'])) return null;

    return ['data' => $data, 'age' => time() - (int)$data['cachedAt']];
}

function ff_cache_write(string $url, array $data): void
{
    $data['cachedAt'] = time();
    $file = ff_cache_path($url);
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    rename($tmp, $file); // atomic replace
}

/**
 * Per-URL lock so that concurrent requests do not hit the source in parallel.
 * @return resource|null  null if $wait=false and another process holds it
 */
function ff_lock(string $url, bool $wait)
{
    $fp = fopen(ff_cache_path($url, 'lock'), 'c');
    if ($fp === false) return null;
    if (!flock($fp, LOCK_EX | ($wait ? 0 : LOCK_NB))) {
        fclose($fp);
        return null;
    }
    return $fp;
}

function ff_unlock($fp): void
{
    if (is_resource($fp)) {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}
