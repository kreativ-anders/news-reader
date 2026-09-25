<?php
declare(strict_types=1);

/**
 * Platform rules engine (data: src/feed-rules.php, optional src/feed-rules.local.php).
 * Maps a page URL to the platform's native feed URL(s) without fetching the page.
 */

/** All rules, local overrides first. Loaded once per request. */
function nr_rules(): array
{
    static $rules = null;
    if ($rules === null) {
        $local = __DIR__ . '/feed-rules.local.php';
        $rules = array_merge(is_file($local) ? (array)require $local : [], (array)require __DIR__ . '/feed-rules.php');
    }
    return $rules;
}

/**
 * First rule matching the URL, with expanded templates.
 * Returns null if no rule applies or the rule points back to the input URL (the input already is the feed).
 *
 * @return array{id:string, feeds:list<string>, lookup:?array{url:string,field:string}, none:?string}|null
 */
function nr_rule_match(string $url, ?array $rules = null): ?array
{
    $p = parse_url($url);
    if (!is_array($p) || empty($p['host'])) return null;

    $hostFull = strtolower((string)$p['host']);
    $host = (string)preg_replace('/^(?:www|m|mobile)\./', '', $hostFull);
    $subject = ($p['path'] ?? '') === '' ? '/' : (string)$p['path'];
    if (isset($p['query']) && $p['query'] !== '') $subject .= '?' . $p['query'];

    $vars = ['host' => $hostFull, 'origin' => nr_origin($url)];

    foreach ($rules ?? nr_rules() as $rule) {
        if (in_array($host, $rule['except'] ?? [], true)) continue;

        $sub = nr_rule_host_match($host, $rule['hosts'] ?? []);
        if ($sub === null) continue;
        if (!preg_match($rule['match'], $subject, $m)) continue;

        $v = $vars + ['sub' => $sub];
        foreach ($m as $k => $val) {
            if (is_int($k) && $k > 0) $v[(string)$k] = $val;
        }

        if (isset($rule['none'])) {
            return ['id' => $rule['id'], 'feeds' => [], 'lookup' => null, 'none' => (string)$rule['none']];
        }

        $self = nr_normalize_url($url);
        $feeds = [];
        foreach ($rule['feeds'] ?? [] as $tpl) {
            $feed = nr_rule_expand($tpl, $v);
            if ($feed !== '' && nr_normalize_url($feed) !== $self) $feeds[] = $feed;
        }
        $lookup = isset($rule['lookup'])
            ? ['url' => nr_rule_expand($rule['lookup']['url'], $v), 'field' => (string)$rule['lookup']['field']]
            : null;

        if ($feeds === [] && $lookup === null) return null; // input URL is the feed itself
        return ['id' => $rule['id'], 'feeds' => array_values(array_unique($feeds)), 'lookup' => $lookup, 'none' => null];
    }
    return null;
}

/** '' for an exact host match, the subdomain part for a wildcard match, null for no match. */
function nr_rule_host_match(string $host, array $patterns): ?string
{
    foreach ($patterns as $pattern) {
        $pattern = strtolower($pattern);
        if (str_starts_with($pattern, '*.')) {
            $suffix = substr($pattern, 1); // ".medium.com"
            if (str_ends_with($host, $suffix) && strlen($host) > strlen($suffix)) {
                return (string)preg_replace('/^www\./', '', substr($host, 0, -strlen($suffix)));
            }
        } elseif ($host === $pattern) {
            return '';
        }
    }
    return null;
}

function nr_rule_expand(string $template, array $vars): string
{
    return (string)preg_replace_callback('/\{(\w+)\}/', fn($m) => $vars[$m[1]] ?? '', $template);
}

/** Resolve a lookup rule (JSON endpoint that names the feed URL). */
function nr_rule_lookup(array $lookup): ?string
{
    $res = nr_fetch($lookup['url']);
    if (!$res['ok']) return null;
    $node = json_decode($res['body'], true);
    foreach (explode('.', $lookup['field']) as $key) {
        if (!is_array($node) || !array_key_exists(ctype_digit($key) ? (int)$key : $key, $node)) return null;
        $node = $node[ctype_digit($key) ? (int)$key : $key];
    }
    return is_string($node) && preg_match('#^https?://#i', $node) ? $node : null;
}
