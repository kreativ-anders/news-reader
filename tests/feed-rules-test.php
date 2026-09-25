<?php
/**
 * Offline test for the platform rules (no network).
 *   php tests/feed-rules-test.php
 * Checks every rule's "examples" plus URLs that must NOT be rewritten.
 */
declare(strict_types=1);

require __DIR__ . '/../src/config.php';
require __DIR__ . '/../src/http.php';
require __DIR__ . '/../src/rules.php';

$rules = nr_rules();
$fail = 0;
$count = 0;
$ids = [];

$check = function (bool $ok, string $msg) use (&$fail, &$count): void {
    $count++;
    if (!$ok) { $fail++; fwrite(STDERR, "FAIL  $msg\n"); }
};

foreach ($rules as $i => $rule) {
    $id = $rule['id'] ?? "#$i";
    $check(isset($rule['id'], $rule['hosts'], $rule['match']), "$id: needs id, hosts, match");
    $check(!isset($ids[$id]), "$id: duplicate id");
    $ids[$id] = true;
    $check(@preg_match($rule['match'], '') !== false, "$id: invalid regex");
    $check(isset($rule['none']) || !empty($rule['feeds']) || isset($rule['lookup']), "$id: needs feeds, lookup or none");
    $check(!empty($rule['examples']), "$id: needs at least one example");

    foreach ($rule['examples'] ?? [] as $input => $expected) {
        $m = nr_rule_match($input, $rules);
        $got = $m === null ? 'null'
            : ($m['none'] !== null ? '!none' : ($m['feeds'][0] ?? $m['lookup']['url'] ?? 'null'));
        $check($m !== null && $m['id'] === $id && $got === $expected,
            "$id: $input\n        expected [$id] $expected\n        got      [" . ($m['id'] ?? '-') . "] $got");
    }
}

// Must not be rewritten: already feeds, or pages left to discovery
$untouched = [
    'https://medium.com/feed/@vignarajj',
    'https://medium.com/feed/better-programming',
    'https://example.substack.com/feed',
    'https://www.reddit.com/r/selfhosted/.rss',
    'https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ',
    'https://www.youtube.com/@GoogleDevelopers',
    'https://github.com/php/php-src/releases.atom',
    'https://github.com/kreativ-anders.atom',
    'https://example.wordpress.com/feed/',
    'https://news.google.com/rss/search?q=rss',
    'https://example.org/blog',
];
foreach ($untouched as $input) {
    $m = nr_rule_match($input, $rules);
    $check($m === null, "untouched: $input → [" . ($m['id'] ?? '') . '] ' . ($m['feeds'][0] ?? ''));
}

echo ($fail ? "FAILED $fail" : 'OK') . " – $count checks, " . count($rules) . " rules\n";
exit($fail ? 1 : 0);
