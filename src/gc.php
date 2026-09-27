<?php
declare(strict_types=1);

// INFO: time-based cleanup without cron. Every request only stat()s <dir>/.gc; when the last run is older than
//       NR_GC_INTERVAL, the request runs $gc once its response has been sent. A non-blocking flock makes sure only
//       one process cleans a directory at a time – all others carry on without waiting.
const NR_GC_INTERVAL = 3600;

function nr_gc_schedule(string $dir, callable $gc): void
{
    static $scheduled = [];
    if (isset($scheduled[$dir]) || !is_dir($dir)) return;
    $last = @filemtime($dir . '/.gc');
    if ($last !== false && time() - $last < NR_GC_INTERVAL) return;

    $scheduled[$dir] = true;
    register_shutdown_function('nr_gc_run', $dir, $gc);
}

function nr_gc_run(string $dir, callable $gc): void
{
    if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();

    $fh = @fopen($dir . '/.gc', 'c+');
    if ($fh === false) return;
    try {
        if (!flock($fh, LOCK_EX | LOCK_NB)) return;
        // INFO: another process may have finished a run between our stat() and the lock
        $last = (int)stream_get_contents($fh);
        if (time() - $last < NR_GC_INTERVAL) return;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, (string)time());
        fflush($fh);
        @set_time_limit(300);
        $gc();
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}
