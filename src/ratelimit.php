<?php
declare(strict_types=1);

// INFO: file-based fixed-window rate limiter – one file per (bucket, client), named
//       sha256(salt|bucket|client). The client address itself is never written to disk.
//       Returns 0 if allowed, otherwise the seconds until the window resets. $client defaults to nr_rate_client().
//       $peek only checks the limit without counting.
function nr_rate_hit(string $bucket, array $rule, ?string $client = null, bool $peek = false): int
{
    [$max, $window] = $rule;
    if ($max <= 0) return 0;

    if (!is_dir(NR_RATE_DIR) && !@mkdir(NR_RATE_DIR, 0775, true) && !is_dir(NR_RATE_DIR)) {
        return 0; // WARNING: fails open – rate limiting must never break the service
    }

    $file = NR_RATE_DIR . '/' . hash('sha256', nr_rate_salt() . '|' . $bucket . '|' . ($client ?? nr_rate_client()));
    $fh = @fopen($file, 'c+');
    if ($fh === false) return 0;

    try {
        flock($fh, LOCK_EX);
        $now = time();
        [$start, $n] = array_map('intval', array_pad(explode(' ', (string)stream_get_contents($fh)), 2, 0));
        if ($now - $start >= $window) {
            $start = $now;
            $n = 0;
        }
        if ($n >= $max) {
            return max(1, $start + $window - $now);
        }
        if ($peek) return 0;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, $start . ' ' . ($n + 1));
        fflush($fh);
        return 0;
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

// INFO: IPv6 clients usually own a whole /64 – counting single addresses would make the limit trivial to bypass.
//       $prefixBytes = 6 gives the /48 a site usually gets.
function nr_rate_client(int $prefixBytes = 8): string
{
    $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    $bin = @inet_pton($ip);
    if ($bin === false) return $ip;
    if (strlen($bin) === 16 && !str_starts_with($bin, str_repeat("\0", 10) . "\xff\xff")) {
        return bin2hex(substr($bin, 0, $prefixBytes)) . '::/' . ($prefixBytes * 8);
    }
    return inet_ntop(substr($bin, -4)) ?: $ip;
}

// INFO: per /64 first, then per /48 for IPv6 clients – one /48 holds 65536 /64s
function nr_rate_hit_wide(string $bucket, array $rule, array $rule48, bool $peek = false): int
{
    if ($wait = nr_rate_hit($bucket, $rule, null, $peek)) return $wait;
    $wide = nr_rate_client(6);
    return str_ends_with($wide, '/48') ? nr_rate_hit($bucket . '/48', $rule48, $wide, $peek) : 0;
}

function nr_rate_salt(): string
{
    static $salt = null;
    if ($salt !== null) return $salt;

    $file = NR_RATE_DIR . '/.salt';
    $salt = (string)@file_get_contents($file);
    if (strlen($salt) >= 32) return $salt;

    $fh = @fopen($file, 'x');
    if ($fh !== false) {
        $salt = bin2hex(random_bytes(32));
        fwrite($fh, $salt);
        fclose($fh);
        @chmod($file, 0600);
        return $salt;
    }
    usleep(50_000);
    $salt = (string)@file_get_contents($file);
    return strlen($salt) >= 32 ? $salt : ($salt = bin2hex(random_bytes(32)));
}

// INFO: counters older than the longest window (1 day) are useless
function nr_rate_gc(): void
{
    $limit = time() - 2 * 86400;
    foreach (glob(NR_RATE_DIR . '/*', GLOB_NOSORT) ?: [] as $f) {
        if (@filemtime($f) < $limit) @unlink($f);
    }
}

function nr_rate_reject(int $retryAfter): never
{
    header('Retry-After: ' . $retryAfter);
    nr_json(['error' => ['code' => 'RATE_LIMITED', 'message' => 'Too many requests – try again in ' . $retryAfter . ' s.']], 429);
}
