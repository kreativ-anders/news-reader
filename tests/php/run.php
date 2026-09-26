<?php
/** php tests/php/run.php [filter] – runs tests/php/*-test.php (see bootstrap.php). */
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

$filter = $argv[1] ?? '';
foreach (glob(__DIR__ . '/*-test.php') ?: [] as $file) {
    if ($filter !== '' && !str_contains(basename($file), $filter)) continue;
    $GLOBALS['NR_TEST_FILE'] = basename($file);
    require $file;
}
exit(run_tests());
