<?php
// INFO: regression tests for the security review (XML/gzip bombs, link schemes, SSRF edge cases, rate-limit grouping)
declare(strict_types=1);

test('XML entity expansion ("billion laughs") is refused quickly', function () {
    $ent = '<!ENTITY a "aaaaaaaaaa">';
    $prev = 'a';
    foreach (range(1, 9) as $i) {
        $ent .= "<!ENTITY e$i \"" . str_repeat("&$prev;", 10) . '">';
        $prev = "e$i";
    }
    $xml = "<?xml version=\"1.0\"?><!DOCTYPE rss [$ent]><rss version=\"2.0\"><channel><title>&$prev;</title>"
        . "<item><title>&$prev;</title><link>https://example.org/a</link></item></channel></rss>";
    $t = microtime(true);
    $feed = nr_parse_feed($xml, 'https://example.org/feed');
    assert_true(microtime(true) - $t < 2, 'parsing must not expand the entities');
    assert_true($feed === null || strlen((string)$feed['title']) < 1_000_000, 'no expanded title');
});

test('gzip bodies are capped (decompression bomb)', function () {
    assert_same('hello', nr_gunzip(gzencode('hello')));
    assert_null(nr_gunzip(gzencode(str_repeat('A', NR_MAX_BODY_BYTES + 1))), 'over the cap');
    assert_null(nr_gunzip('not gzip'), 'garbage');
    assert_null(nr_load_xml(gzencode('<rss>' . str_repeat(' ', NR_MAX_BODY_BYTES) . '</rss>')), 'gzip feed over the cap');
});

test('feed entries with non-http(s) links never leave the Collector', function () {
    $xml = '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>'
        . '<item><title>js</title><link>javascript:alert(1)</link></item>'
        . '<item><title>data</title><link>data:text/html,&lt;script&gt;x&lt;/script&gt;</link></item>'
        . '<item><title>vb</title><link> JavaScript:alert(2)</link></item>'
        . '<item><title>ok</title><link>https://example.org/ok</link>'
        . '<description>&lt;img src="javascript:alert(3)"&gt;&lt;img src="https://example.org/i.jpg" width="600"&gt;</description></item>'
        . '</channel></rss>';
    $feed = nr_parse_feed($xml, 'https://example.org/feed');
    assert_same(['https://example.org/ok'], array_column($feed['entries'], 'url'));
    assert_same('https://example.org/i.jpg', $feed['entries'][0]['image']);
    assert_false(nr_is_http_url('javascript:alert(1)'));
    assert_false(nr_is_http_url('https://' . str_repeat('a', 2100)), 'over 2048 chars');
    assert_true(nr_is_http_url('HTTPS://Example.org/x'));
});

test('SSRF edge cases: multicast, benchmark, 6to4, credentials, ports', function () {
    foreach (['224.0.0.1', '239.255.255.250', '198.18.0.1', '198.19.255.255', '2002:7f00:1::1', '2002:a00:1::1', 'ff02::1'] as $ip) {
        assert_false(nr_is_public_ip($ip), "$ip must be blocked");
    }
    assert_true(nr_is_public_ip('198.20.0.1'), 'just above 198.18/15');
    assert_same('UNSUPPORTED_URL', nr_validate_target('https://user:pw@example.org/')['code'] ?? null, 'credentials');
    foreach (['http://example.org:22/', 'https://example.org:6379/'] as $u) {
        assert_same('FORBIDDEN_HOST', nr_validate_target($u)['code'] ?? null, $u);
    }
    assert_same(443, nr_url_port('https://example.org/'));
    assert_same(8080, nr_url_port('http://example.org:8080/'));
});

test('rate limit: IPv6 clients are grouped per /64', function () {
    $prev = $_SERVER['REMOTE_ADDR'] ?? null;
    try {
        $_SERVER['REMOTE_ADDR'] = '2001:db8:1:2::1';
        $a = nr_rate_client();
        $_SERVER['REMOTE_ADDR'] = '2001:db8:1:2:ffff:ffff:ffff:ffff';
        assert_same($a, nr_rate_client(), 'same /64');
        $_SERVER['REMOTE_ADDR'] = '2001:db8:1:3::1';
        assert_true($a !== nr_rate_client(), 'other /64');
        $_SERVER['REMOTE_ADDR'] = '::ffff:203.0.113.7';
        assert_same('203.0.113.7', nr_rate_client(), 'IPv4-mapped = IPv4');
    } finally {
        $_SERVER['REMOTE_ADDR'] = $prev;
    }
});

test('sync accepts vault snapshots and key-change forwards only', function () {
    assert_same(['NRS1', 'NRF1'], NR_SYNC_MAGICS);
});
