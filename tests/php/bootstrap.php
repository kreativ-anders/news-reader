<?php
/**
 * Minimal test harness – no Composer, no PHPUnit, needs PHP 8.5+ (like the app).
 *
 *   php tests/php/run.php            all *-test.php files in this folder
 *   php tests/php/run.php parsers    only files whose name contains "parsers"
 *
 * A test file calls test('name', fn() => …) and uses the assert helpers below.
 * Every PHP warning/notice/deprecation inside a test counts as a failure.
 */
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '1');

if (PHP_VERSION_ID < 80500) {
    fwrite(STDERR, 'PHP 8.5+ required, running ' . PHP_VERSION . PHP_EOL);
    exit(1);
}

// Load the server code exactly like api/index.php does. Unit tests are pure: no network,
// no files written (cache, sync and rate limits are covered by the API tests in tests/api/).
require_once __DIR__ . '/../../src/config.php';
require_once __DIR__ . '/../../src/response.php';
require_once __DIR__ . '/../../src/http.php';
require_once __DIR__ . '/../../src/parsers.php';
require_once __DIR__ . '/../../src/cache.php';
require_once __DIR__ . '/../../src/rules.php';
require_once __DIR__ . '/../../src/resolver.php';
require_once __DIR__ . '/../../src/ratelimit.php';
require_once __DIR__ . '/../../src/readable.php';
require_once __DIR__ . '/../../src/sync.php';

final class AssertionFailed extends Exception {}

$GLOBALS['NR_TESTS'] = [];

function test(string $name, callable $fn): void
{
    $GLOBALS['NR_TESTS'][] = [$GLOBALS['NR_TEST_FILE'] ?? '', $name, $fn];
}

function fail(string $msg): never
{
    throw new AssertionFailed($msg);
}

function export(mixed $v): string
{
    $s = var_export($v, true);
    return strlen($s) > 400 ? substr($s, 0, 400) . '…' : $s;
}

function assert_true(mixed $v, string $msg = ''): void
{
    if ($v !== true) fail(($msg ? "$msg: " : '') . 'expected true, got ' . export($v));
}

function assert_false(mixed $v, string $msg = ''): void
{
    if ($v !== false) fail(($msg ? "$msg: " : '') . 'expected false, got ' . export($v));
}

function assert_same(mixed $expected, mixed $actual, string $msg = ''): void
{
    if ($expected !== $actual) fail(($msg ? "$msg: " : '') . "\n    expected " . export($expected) . "\n    got      " . export($actual));
}

function assert_null(mixed $v, string $msg = ''): void
{
    assert_same(null, $v, $msg);
}

function assert_not_null(mixed $v, string $msg = ''): void
{
    if ($v === null) fail(($msg ? "$msg: " : '') . 'expected a value, got null');
}

function assert_contains(string $needle, string $haystack, string $msg = ''): void
{
    if (!str_contains($haystack, $needle)) fail(($msg ? "$msg: " : '') . 'expected to contain ' . export($needle) . ' in ' . export($haystack));
}

function assert_not_contains(string $needle, string $haystack, string $msg = ''): void
{
    if (str_contains($haystack, $needle)) fail(($msg ? "$msg: " : '') . 'must not contain ' . export($needle) . ' in ' . export($haystack));
}

function assert_matches(string $regex, string $actual, string $msg = ''): void
{
    if (!preg_match($regex, $actual)) fail(($msg ? "$msg: " : '') . "expected to match $regex, got " . export($actual));
}

/** Load a fixture from tests/fixtures/www with placeholders expanded (like tests/fixtures/router.php). */
function fixture(string $path, string $base = 'https://fixture.test'): string
{
    $s = (string)file_get_contents(__DIR__ . '/../fixtures/www/' . ltrim($path, '/'));
    $s = str_replace('{{base}}', $base, $s);
    return (string)preg_replace_callback('/\{\{(date|iso):(\d+(?:\.\d+)?)\}\}/', function ($m) {
        $ts = time() - (int)round((float)$m[2] * 86400);
        return $m[1] === 'date' ? gmdate(DATE_RSS, $ts) : gmdate('Y-m-d\TH:i:s\Z', $ts);
    }, $s);
}

function run_tests(): int
{
    $failed = 0;
    $passed = 0;
    $current = null;
    foreach ($GLOBALS['NR_TESTS'] as [$file, $name, $fn]) {
        if ($file !== $current) { echo "\n$file\n"; $current = $file; }
        $warnings = [];
        set_error_handler(function (int $no, string $msg, string $f, int $l) use (&$warnings): bool {
            $warnings[] = "$msg (" . basename($f) . ":$l)";
            return true;
        });
        try {
            $fn();
            if ($warnings) fail("PHP warnings:\n    " . implode("\n    ", $warnings));
            $passed++;
            echo "  ✓ $name\n";
        } catch (Throwable $e) {
            $failed++;
            $where = $e instanceof AssertionFailed ? '' : ' [' . get_class($e) . ' in ' . basename($e->getFile()) . ':' . $e->getLine() . ']';
            echo "  ✗ $name$where\n    " . str_replace("\n", "\n    ", $e->getMessage()) . "\n";
        } finally {
            restore_error_handler();
        }
    }
    echo "\n" . ($failed ? "FAILED: $failed of " . ($passed + $failed) : "OK: $passed tests") . "\n";
    return $failed ? 1 : 0;
}
