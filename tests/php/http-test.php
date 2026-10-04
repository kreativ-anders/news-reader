<?php
// Gherkin: gherkin/server_protection.feature
/** SSRF protection and URL helpers (src/http.php) – no network. */
declare(strict_types=1);

test('public vs. private / reserved IPs', function () {
    foreach (['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'] as $ip) {
        assert_true(nr_is_public_ip($ip), "$ip is public");
    }
    foreach ([
        '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
        '0.0.0.0', '0.1.2.3', '100.64.0.1', '100.127.255.255', '255.255.255.255',
        '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::127.0.0.1',
        '64:ff9b::a00:1', '64:ff9b::7f00:1', 'not-an-ip',
    ] as $ip) {
        assert_false(nr_is_public_ip($ip), "$ip must be blocked");
    }
    assert_true(nr_is_public_ip('100.63.255.255'), 'just below CGNAT');
    assert_true(nr_is_public_ip('100.128.0.1'), 'just above CGNAT');
});

test('validate target: scheme and private literals are rejected', function () {
    if (NR_ALLOW_PRIVATE_HOSTS) fail('NR_ALLOW_PRIVATE_HOSTS must be false in the committed config');
    foreach (['ftp://example.org/', 'file:///etc/passwd', 'gopher://x', 'javascript:alert(1)', 'http://', '/relative'] as $u) {
        assert_same('UNSUPPORTED_URL', nr_validate_target($u)['code'] ?? null, $u);
    }
    foreach (['http://127.0.0.1/', 'http://[::1]/', 'http://10.1.2.3:8080/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]/'] as $u) {
        assert_same('FORBIDDEN_HOST', nr_validate_target($u)['code'] ?? null, $u);
    }
});

test('absolute URLs', function () {
    $b = 'https://ex.test/blog/post/index.html?x=1';
    assert_same('https://ex.test/a', nr_absolute_url('/a', $b));
    assert_same('https://ex.test/blog/post/b', nr_absolute_url('b', $b));
    assert_same('https://ex.test/blog/c', nr_absolute_url('../c', $b));
    assert_same('https://cdn.test/x', nr_absolute_url('//cdn.test/x', $b));
    assert_same('https://ex.test/blog/post/index.html?y=2', nr_absolute_url('?y=2', $b));
    assert_same('https://ex.test/blog/post/index.html?x=1#f', nr_absolute_url('#f', $b));
    assert_same('http://other.test/', nr_absolute_url('http://other.test/', $b));
    assert_same('https://ex.test/a&b', nr_absolute_url('/a&amp;b', $b), 'entities decoded');
    assert_same($b, nr_absolute_url('', $b));
});

test('URL normalization (cache key)', function () {
    assert_same('https://ex.test/news', nr_normalize_url('HTTPS://EX.test:443/news/'));
    assert_same('http://ex.test:8080/news?a=1', nr_normalize_url('http://ex.test:8080/news/?a=1'));
    assert_same('https://ex.test/', nr_normalize_url('https://ex.test'));
    assert_same('https://ex.test:8443', nr_origin('https://ex.test:8443/x/y'));
});
