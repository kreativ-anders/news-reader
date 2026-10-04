<?php
// Gherkin: gherkin/server_protection.feature
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

test('SSRF: SIIT, local-use NAT64, site-local, documentation and SRv6 ranges are blocked', function () {
    foreach (['64:ff9b:1::1', '64:ff9b:1:ffff::808:808', '::ffff:0:7f00:1', '::ffff:0:a00:1', 'fec0::1', 'feff::1', '3fff::1', '3fff:fff::1', '5f00::1', '5f00:ffff::1'] as $ip) {
        assert_false(nr_is_public_ip($ip), "$ip must be blocked");
    }
    foreach (['::ffff:0:808:808', '64:ff9b::808:808', '3fff:1000::1', '5f01::1', '2606:4700:4700::1111'] as $ip) {
        assert_true(nr_is_public_ip($ip), "$ip is public");
    }
});

test('rate limit: IPv6 /48 grouping for the wide buckets', function () {
    $prev = $_SERVER['REMOTE_ADDR'] ?? null;
    try {
        $_SERVER['REMOTE_ADDR'] = '2001:db8:1:2::1';
        $a = nr_rate_client(6);
        assert_matches('#/48$#', $a);
        $_SERVER['REMOTE_ADDR'] = '2001:db8:1:ffff::1';
        assert_same($a, nr_rate_client(6), 'same /48');
        assert_true(nr_rate_client() !== nr_rate_client(6), '/64 and /48 keys differ');
        $_SERVER['REMOTE_ADDR'] = '2001:db8:2::1';
        assert_true($a !== nr_rate_client(6), 'other /48');
        $_SERVER['REMOTE_ADDR'] = '203.0.113.7';
        assert_same('203.0.113.7', nr_rate_client(6), 'IPv4 stays a single address');
    } finally {
        $_SERVER['REMOTE_ADDR'] = $prev;
    }
    foreach (['NR_RATE_COLLECT_MISS', 'NR_RATE_ARTICLE_MISS', 'NR_RATE_SYNC_CREATE'] as $c) {
        assert_true(constant($c . '_48')[0] > constant($c)[0], "$c: /48 allows more than /64");
    }
    assert_true(NR_RATE_SYNC_CREATE_ALL[0] > NR_RATE_SYNC_CREATE_48[0]);
});

test('redirect targets and robots.txt lines are not HTML-decoded', function () {
    assert_same('https://ex.test/a?x=1&amp;y=2', nr_absolute_url('/a?x=1&amp;y=2', 'https://ex.test/', false));
    assert_same('https://ex.test/a?x=1&y=2', nr_absolute_url('/a?x=1&amp;y=2', 'https://ex.test/'));
});

test('deeply nested HTML is extracted quickly (no LIBXML_PARSEHUGE, linear text lengths)', function () {
    $text = str_repeat('<p>Lorem ipsum, dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.</p>', 3000);
    foreach ([['<div class="share x">', '</div>'], ['<blockquote>', '</blockquote>'], ['<article><h2><a href="/a">T</a></h2>', '</article>'], ['<div><p>Nested text, long enough to vote for its parent.</p>', '</div>']] as [$open, $close]) {
        $html = '<html><body>' . str_repeat($open, 2000) . $text . str_repeat($close, 2000) . '</body></html>';
        $t = microtime(true);
        nr_extract_article($html, 'https://example.org/a');
        nr_listing_articles(nr_load_html($html), 'https://example.org/');
        assert_true(microtime(true) - $t < 2, "$open: took " . round(microtime(true) - $t, 2) . ' s');
    }
});

test('feed full text is capped per entry and per feed (cache size)', function () {
    $para = '<p>' . str_repeat('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ', 20) . '</p>';
    $big = str_repeat($para, 120);   // ~140 KB
    $mid = str_repeat($para, 70);    // ~80 KB
    $entries = [nr_entry('https://example.org/big', 'Big', null, null, null, '', null, $big)];
    for ($i = 0; $i < 20; $i++) $entries[] = nr_entry('https://example.org/m' . $i, 'M' . $i, null, null, null, '', null, $mid);
    $out = nr_with_fulltext($entries);
    assert_false(isset($out[0]['content']), 'over NR_FULLTEXT_MAX_BYTES');
    $kept = array_filter($out, fn($e) => isset($e['content']));
    assert_true(count($kept) >= 10 && count($kept) < 20, 'budget stops after ~1 MB, kept ' . count($kept));
    assert_true(array_sum(array_map(fn($e) => strlen($e['content']), $kept)) <= NR_FULLTEXT_BUDGET);
    assert_same(500, mb_strlen(nr_entry('https://example.org/t', str_repeat('x', 5000), null)['title']), 'titles are capped');
});

test('large sitemaps: only the newest entries are built, same order as before', function () {
    $x = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
    for ($i = 0; $i < 20000; $i++) {
        $x .= '<url><loc>https://e.org/blog/p' . $i . '</loc>' . ($i % 4 ? '<lastmod>' . gmdate('Y-m-d', 1600000000 + ($i % 500) * 86400) . '</lastmod>' : '') . '</url>';
    }
    $x .= '</urlset>';
    $t = microtime(true);
    $e = nr_parse_sitemap($x, 'https://e.org/sitemap.xml', 'https://e.org/blog');
    assert_true(microtime(true) - $t < 2, 'fast');
    assert_same(NR_MAX_ENTRIES, count($e));
    $dates = array_map(fn($x) => $x['updatedAt'], $e);
    $sorted = $dates;
    rsort($sorted);
    assert_same($sorted, $dates, 'newest first');
    assert_same('https://e.org/blog/p19999', $e[0]['url'], 'ties: later sitemap position first (as nr_finalize_entries)');
});

test('ETag matching for cached API responses', function () {
    assert_true(nr_etag_matches('W/"abc"', 'W/"abc"'));
    assert_true(nr_etag_matches('"abc"', 'W/"abc"'));
    assert_true(nr_etag_matches('"x", W/"abc"', 'W/"abc"'));
    assert_false(nr_etag_matches('"abd"', 'W/"abc"'));
    assert_false(nr_etag_matches('', 'W/"abc"'));
});
