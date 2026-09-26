<?php
/** Feed / HTML / sitemap parsing (src/parsers.php) – pure functions, no network. */
declare(strict_types=1);

$B = 'https://fixture.test';

test('RSS 2.0: entries, order, dedupe, relative links, ids', function () use ($B) {
    $feed = nr_parse_feed(fixture('feeds/rss.xml'), "$B/feeds/rss.xml");
    assert_not_null($feed);
    assert_same('rss', $feed['type']);
    assert_same('Fixture Blog', $feed['title']);
    $titles = array_column($feed['entries'], 'title');
    // newest first, duplicate URL dropped, item without link skipped
    assert_same(['Newest post with full text', 'Second post', 'Relative link post', 'Oldest post'], $titles);
    assert_same("$B/article/relative.html", $feed['entries'][2]['url'], 'relative link resolved');
    assert_same(hash('sha256', 'fixture-rss-1'), $feed['entries'][0]['id'], 'id = sha256(guid)');
    assert_same(hash('sha256', nr_normalize_url("$B/article/oldest.html")), $feed['entries'][3]['id'], 'id = sha256(url) without guid');
    foreach ($feed['entries'] as $e) {
        assert_matches('/^[0-9a-f]{64}$/', $e['id']);
        assert_matches('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/', (string)$e['publishedAt'], 'ISO date');
        foreach (['id', 'url', 'title', 'publishedAt', 'updatedAt', 'summary', 'image'] as $k) {
            if (!array_key_exists($k, $e)) fail("entry misses key $k");
        }
    }
    assert_same('Teaser of the second post.', $feed['entries'][1]['summary'], 'summary is plain text');
});

test('RSS 2.0: full text kept (sanitized), teasers are not', function () use ($B) {
    $feed = nr_parse_feed(fixture('feeds/rss.xml'), "$B/feeds/rss.xml");
    $full = $feed['entries'][0]['content'] ?? null;
    assert_not_null($full, 'content:encoded ≥ NR_FULLTEXT_MIN_CHARS is kept');
    assert_contains('<h2>Full text</h2>', $full);
    assert_not_contains('<script', $full);
    assert_not_contains('onerror', $full);
    assert_false(isset($feed['entries'][1]['content']), 'short description is no full text');
});

test('Atom: entries, dates, summary/content', function () use ($B) {
    $feed = nr_parse_feed(fixture('feeds/atom.xml'), "$B/feeds/atom.xml");
    assert_same('atom', $feed['type']);
    assert_same('Fixture Atom', $feed['title']);
    assert_same("$B/guess/", $feed['siteUrl']);
    assert_same(3, count($feed['entries']));
    assert_same("$B/article/atom-1.html", $feed['entries'][0]['url']);
    assert_same('First Atom summary', $feed['entries'][0]['summary']);
    assert_not_null($feed['entries'][1]['publishedAt'], 'updated is used when published is missing');
});

test('RSS 1.0 (RDF)', function () use ($B) {
    $feed = nr_parse_feed(fixture('feeds/rdf.xml'), "$B/feeds/rdf.xml");
    assert_same('rdf', $feed['type']);
    assert_same(['RDF item one', 'RDF item two'], array_column($feed['entries'], 'title'));
});

test('broken XML, HTML and garbage are no feed', function () use ($B) {
    assert_null(nr_parse_feed(fixture('feeds/broken.xml'), $B));
    assert_null(nr_parse_feed(fixture('blog/index.html'), $B));
    assert_null(nr_parse_feed('', $B));
    assert_null(nr_parse_feed("\x00\x01binary", $B));
    assert_null(nr_parse_feed('{"json":true}', $B));
});

test('XML external entities are not resolved (XXE)', function () use ($B) {
    $feed = nr_parse_feed(fixture('feeds/xxe.xml'), $B);
    $dump = json_encode($feed);
    assert_not_contains('root:', (string)$dump);
});

test('feed discovery: <link rel=alternate> and visible feed links', function () use ($B) {
    $dom = nr_load_html(fixture('blog/index.html'));
    assert_same(["$B/feeds/rss.xml"], nr_discover_feed_links($dom, "$B/blog/"));
    $dom = nr_load_html('<html><body><a href="/rss.xml">RSS</a><a href="https://other.test/feed">x</a><a href="/about">About</a></body></html>');
    assert_same(["$B/rss.xml"], nr_discover_feed_links($dom, "$B/"), 'same host only');
});

test('guessed feed paths: path-specific first, then origin', function () use ($B) {
    $g = nr_guess_feed_urls("$B/blog/");
    assert_same("$B/blog/feed", $g[0]);
    assert_true(in_array("$B/feed.xml", $g, true));
    assert_same(count($g), count(array_unique($g)));
});

test('HTML listing: <article> elements (nav ignored)', function () use ($B) {
    $l = nr_parse_html_listing(nr_load_html(fixture('magazine/index.html')), "$B/magazine/");
    assert_same('html-article', $l['strategy']);
    assert_same(['First magazine story', 'Second magazine story', 'Third magazine story'], array_column($l['entries'], 'title'));
    assert_same("$B/img/one.jpg", $l['entries'][0]['image']);
    assert_not_null($l['entries'][0]['publishedAt']);
});

test('HTML listing: JSON-LD', function () use ($B) {
    $l = nr_parse_html_listing(nr_load_html(fixture('jsonld/index.html')), "$B/jsonld/");
    assert_same('html-jsonld', $l['strategy']);
    $titles = array_column($l['entries'], 'title');
    sort($titles);
    assert_same(['JSON-LD post one', 'JSON-LD post three', 'JSON-LD post two'], $titles);
    assert_false(in_array('author is skipped', $titles, true), 'author/publisher subtrees are skipped');
});

test('HTML listing: links below the path (header, pagination, tags, short titles ignored)', function () use ($B) {
    $l = nr_parse_html_listing(nr_load_html(fixture('links/index.html')), "$B/links/");
    assert_same('html-links', $l['strategy']);
    assert_same(["$B/links/first-undated-story", "$B/links/second-story", "$B/links/third-story"], array_column($l['entries'], 'url'));
    assert_same('First undated story from the list', $l['entries'][0]['title']);
    assert_not_null($l['entries'][1]['publishedAt'], '<time> inside the link');
});

test('HTML listing: nothing found → null', function () use ($B) {
    assert_null(nr_parse_html_listing(nr_load_html(fixture('empty/index.html')), "$B/empty/"));
});

test('sitemap: filtered to the requested path, dated, slug titles', function () use ($B) {
    $e = nr_parse_sitemap(fixture('sitemap.xml'), "$B/sitemap.xml", "$B/news/");
    assert_same(4, count($e));
    assert_same('Company Opens New Office', $e[0]['title']);
    assert_not_null($e[0]['updatedAt']);
    assert_same([], nr_parse_sitemap('<html></html>', "$B/sitemap.xml", "$B/news/"));
});

test('article path heuristics', function () {
    assert_true(nr_is_article_path('/news/some-story', '/news'));
    assert_false(nr_is_article_path('/news', '/news'));
    assert_false(nr_is_article_path('/news/page/2', '/news'));
    assert_false(nr_is_article_path('/news/tag/php', '/news'));
    assert_false(nr_is_article_path('/news/image.jpg', '/news'));
    assert_false(nr_is_article_path('/other/story', '/news'));
    assert_true(nr_is_article_path('/2026/09/hello-world', ''));
    assert_true(nr_is_article_path('/blog/hello-world', ''));
    assert_false(nr_is_article_path('/imprint', ''));
});

test('date parsing', function () {
    assert_same('2026-09-01T10:00:00Z', nr_parse_date('2026-09-01T12:00:00+02:00'));
    assert_same('2026-09-01T10:00:00Z', nr_parse_date('Tue, 01 Sep 2026 10:00:00 GMT'));
    assert_null(nr_parse_date(''));
    assert_null(nr_parse_date(null));
    assert_null(nr_parse_date('not a date'));
});

test('text helpers', function () {
    assert_same('A & B', nr_clean_text("  A\n\t&amp;   B "));
    assert_same('Hello World', nr_title_from_slug('https://x.test/news/hello-world.html'));
    assert_true(nr_is_html('text/html; charset=utf-8', ''));
    assert_true(nr_is_html('', '<!doctype html><html>'));
    assert_false(nr_is_html('application/json', '{}'));
});

test('entries are capped at NR_MAX_ENTRIES', function () {
    $items = '';
    for ($i = 0; $i < NR_MAX_ENTRIES + 20; $i++) $items .= "<item><title>T$i</title><link>https://x.test/$i</link></item>";
    $feed = nr_parse_feed("<rss version=\"2.0\"><channel><title>x</title>$items</channel></rss>", 'https://x.test/');
    assert_same(NR_MAX_ENTRIES, count($feed['entries']));
});
