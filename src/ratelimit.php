<?php
declare(strict_types=1);

/**
 * Tiny file-based fixed-window rate limiter – no database, no shared memory.
 *
 * One file per (bucket, client): var/rate/<sha256(salt|bucket|ip)>. The IP itself
 * is never written to disk; the salt is random per installation.
 *
 * @param array{0:int,1:int} $rule [max requests, window seconds]
 * @return int 0 if allowed, otherwise seconds until the window resets
 */
function nr_rate_hit(string $bucket, array $rule, bool $count = true): int
{
    [$max, $window] = $rule;
    if ($max <= 0) return 0;

    $dir = NR_RATE_DIR;
    if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
        return 0; // fail open: rate limiting must never break the service
    }

    $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    $file = $dir . '/' . hash('sha256', nr_rate_salt() . '|' . $bucket . '|' . $ip);

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
        if ($count) {
            $n++;
            ftruncate($fh, 0);
            rewind($fh);
            fwrite($fh, $start . ' ' . $n);
            fflush($fh);
        }
        return 0;
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
        if (random_int(1, 200) === 1) nr_rate_gc();
    }
}

function nr_rate_salt(): string
{
    static $salt = null;
    if ($salt !== null) return $salt;
    $file = NR_RATE_DIR . '/.salt';
    $salt = (string)@file_get_contents($file);
    if (strlen($salt) < 32) {
        $salt = bin2hex(random_bytes(32));
        @file_put_contents($file, $salt, LOCK_EX);
    }
    return $salt;
}

/** Delete counters that are older than the longest window (2 days). */
function nr_rate_gc(): void
{
    $limit = time() - 2 * 86400;
    foreach (glob(NR_RATE_DIR . '/*') ?: [] as $f) {
        if (@filemtime($f) < $limit) @unlink($f);
    }
}

/** Send 429 with Retry-After and a JSON error. */
function nr_rate_reject(int $retryAfter): never
{
    http_response_code(429);
    header('Content-Type: application/json; charset=utf-8');
    header('Retry-After: ' . $retryAfter);
    echo json_encode(['error' => ['code' => 'RATE_LIMITED', 'message' => 'Too many requests – try again in ' . $retryAfter . ' s.']]);
    exit;
}
