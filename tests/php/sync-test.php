<?php
/** Sync helpers (src/sync.php) that do not need a request – the protocol itself is covered by tests/api/sync.test.mjs. */
declare(strict_types=1);

test('ETag matching (strong, weak, lists)', function () {
    $etag = nr_sync_etag('blob');
    assert_matches('/^"[0-9a-f]{32}"$/', $etag);
    assert_true(nr_sync_etag_matches($etag, $etag));
    assert_true(nr_sync_etag_matches('W/' . $etag, $etag));
    assert_true(nr_sync_etag_matches('"nope", ' . $etag, $etag));
    assert_false(nr_sync_etag_matches('"nope"', $etag));
    assert_false(nr_sync_etag_matches('', $etag));
    assert_false(nr_sync_etag_matches('*', $etag));
});

test('vault path = sha256(token), sharded, never the token itself', function () {
    $token = str_repeat('A', 43);
    $file = nr_sync_file($token);
    $id = hash('sha256', $token);
    assert_true(str_ends_with($file, '/' . substr($id, 0, 2) . '/' . $id . '.vault'));
    assert_not_contains($token, $file);
});

test('allowed networks (CIDR matching, IPv4-mapped IPv6)', function () {
    if (NR_SYNC_ALLOWED_NETS !== []) fail('the committed default must be [] (everyone)');
    assert_true(nr_ip_in_nets('203.0.113.7', []), 'empty list = everyone');
    $nets = ['127.0.0.0/8', '192.168.0.0/16', '10.1.2.3', 'fc00::/7', '172.16.0.0/12'];
    foreach (['127.0.0.1', '192.168.44.1', '10.1.2.3', '::ffff:192.168.1.1', 'fd00::1', '172.31.0.1'] as $ip) {
        assert_true(nr_ip_in_nets($ip, $nets), "$ip allowed");
    }
    foreach (['10.1.2.4', '8.8.8.8', '172.32.0.1', '2001:db8::1', 'garbage', ''] as $ip) {
        assert_false(nr_ip_in_nets($ip, $nets), "$ip refused");
    }
});

test('limits are sane', function () {
    assert_true(NR_SYNC_MAX_BYTES >= 100_000 && NR_SYNC_MAX_BYTES <= 10_000_000, 'NR_SYNC_MAX_BYTES');
    assert_true(NR_SYNC_MIN_BYTES === 33, 'magic + flags + iv + tag');
    foreach ([NR_RATE_COLLECT_MISS, NR_RATE_ARTICLE_MISS, NR_RATE_SYNC, NR_RATE_SYNC_CREATE] as $rule) {
        assert_true(is_array($rule) && count($rule) === 2 && $rule[0] > 0 && $rule[1] > 0, 'rate rule [max, window]');
    }
    assert_true(NR_CACHE_TTL > NR_REFRESH_MIN_AGE && NR_STALE_TTL > NR_CACHE_TTL, 'cache TTL ordering');
});
