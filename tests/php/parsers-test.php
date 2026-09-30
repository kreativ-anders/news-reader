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
        foreach (['id', 'url', 'title', 'publishedAt', 'updatedAt', 'summary', 'image', 'author'] as $k) {
            if (!array_key_exists($k, $e)) fail("entry misses key $k");
        }
    }
    assert_same('Teaser of the second post.', $feed['entries'][1]['summary'], 'summary is plain text');
    assert_same('Jane Doe', $feed['entries'][1]['author'], 'dc:creator');
    assert_null($feed['entries'][0]['author']);
    assert_same("$B/blog/", $feed['siteUrl']);
    assert_same("$B/blog/icon.png", $feed['icon'], 'channel <image>');
});

test('authors: RSS e-mail form, Atom person, feed-level fallback, junk', function () use ($B) {
    assert_same('Jane Doe', nr_author('jane@example.com (Jane Doe)'));
    assert_same('', nr_author('jane@example.com'));
    assert_same('', nr_author('https://example.com/about'));
    assert_same('Ada &', nr_author(' Ada  &amp; '));
    $feed = nr_parse_feed(fixture('feeds/atom.xml'), "$B/feeds/atom.xml");
    assert_same('Max Mustermann', $feed['entries'][0]['author'], 'entry <author><name>');
    assert_same('Atom Desk', $feed['entries'][1]['author'], 'feed <author> as fallback');
    assert_same("$B/favicon.svg", $feed['icon'], 'Atom <icon>, SVG allowed');
    assert_same('Kim', nr_jsonld_author([['@type' => 'Person', 'name' => 'Kim'], 'Lee']));
    assert_null(nr_jsonld_author(['@type' => 'Person']));
});

test('summaries: feed boilerplate is removed', function () {
    $cases = [
        ['Laut einer Prognose sollen die...Zum Beitrag: Foldable-Markt soll sich verdoppeln', 'Laut einer Prognose sollen die…'],
        ['A great teaser. The post Great title appeared first on Example Blog.', 'A great teaser.'],
        ['Some teaser text [&#8230;]', 'Some teaser text…'],
        ['Some teaser text […] Continue reading →', 'Some teaser text…'],
        ['Ein Teaser. Weiterlesen', 'Ein Teaser.'],
        ['Thread more pages here', 'Thread more pages here'],
        ['Read more about it: this stays because it is the whole teaser and not at the end of anything else.', 'Read more about it: this stays because it is the whole teaser and not at the end of anything else.'],
    ];
    foreach ($cases as [$in, $out]) assert_same($out, nr_summary($in), $in);
    assert_same('The actual teaser starts here and goes on.', nr_summary('My Title: The actual teaser starts here and goes on.', 'My Title'), 'repeated title');
    assert_same('My Title', nr_summary('My Title', 'My Title'), 'a teaser that is only the title stays');
});

test('page icon: rel=icon first, apple-touch-icon as fallback, only http(s)', function () use ($B) {
    $dom = nr_load_html('<html><head><link rel="apple-touch-icon" href="/touch.png"><link rel="shortcut icon" href="/fav.ico"></head></html>');
    assert_same("$B/fav.ico", nr_page_icon($dom, "$B/blog/"));
    $dom = nr_load_html('<html><head><link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="javascript:alert(1)"></head></html>');
    assert_same("$B/touch.png", nr_page_icon($dom, "$B/blog/"));
    assert_null(nr_page_icon(nr_load_html('<html><head><link rel="mask-icon" href="/m.svg"></head></html>'), $B));
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

test('HTML listing: sibling pages of a listing file (/essays/articles.html → /essays/first.html)', function () use ($B) {
    $l = nr_parse_html_listing(nr_load_html(fixture('essays/articles.html')), "$B/essays/articles.html");
    assert_same('html-links', $l['strategy']);
    assert_same(["$B/essays/second.html", "$B/essays/first.html", "$B/essays/third.html"], array_column($l['entries'], 'url'));
    assert_same('The First Essay Title', $l['entries'][1]['title']);
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
    assert_true(nr_is_article_path('/essay.html', '/articles.html'));
    assert_false(nr_is_article_path('/articles.html', '/articles.html'));
    assert_false(nr_is_article_path('/index.html', '/articles.html'));
    assert_false(nr_is_article_path('/essay.php', '/articles.html'));
    assert_false(nr_is_article_path('/sub/essay.html', '/articles.html'));
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

test('WordPress REST API: entries, dates, ids match the RSS feed of the same site', function () use ($B) {
    $wp = nr_parse_wp_posts(fixture('wp/posts.json'), "$B/wp-json/wp/v2/posts");
    assert_not_null($wp);
    assert_same('wordpress', $wp['type']);
    assert_same("$B/", $wp['siteUrl']);
    assert_same(['WordPress – newest post', 'Second WordPress post', 'Oldest WordPress post'], array_column($wp['entries'], 'title'), 'entities decoded, tags stripped, javascript: link dropped');
    assert_same('Teaser of the newest post …', $wp['entries'][0]['summary']);
    assert_same('https://images.example.org/wp-101.jpg', $wp['entries'][0]['image']);
    assert_same('Jane Doe', $wp['entries'][0]['author']);
    $rss = nr_parse_feed(fixture('wp/feed.xml'), "$B/feed/");
    assert_same(array_column($rss['entries'], 'id'), array_column($wp['entries'], 'id'), 'guid.rendered = RSS <guid>');

    $plain = nr_parse_wp_posts('[{"link":"https://x.test/a","title":{"rendered":"A"},"date_gmt":"2026-09-25T09:23:00"}]', 'https://x.test/wp-json/wp/v2/posts');
    assert_same('2026-09-25T09:23:00Z', $plain['entries'][0]['publishedAt'], 'date_gmt without zone is UTC');
    assert_same(hash('sha256', 'https://x.test/a'), $plain['entries'][0]['id'], 'no guid → id of the URL');
    assert_same([], nr_parse_wp_posts('[]', 'https://x.test/')['entries']);
    foreach (['{"code":"rest_no_route"}', '[1,2]', '[{"title":"x"}]', 'not json', '<rss/>'] as $junk) {
        assert_null(nr_parse_wp_posts($junk, 'https://x.test/'), $junk);
    }
});

test('clientTry: rule feeds, the URL, WordPress API only for the site root', function () {
    $try = nr_client_try('https://www.cio.de/');
    assert_same('https://www.cio.de/feed/', $try[0], 'rule first');
    assert_same('https://www.cio.de/', $try[1]);
    assert_matches('#^https://www\.cio\.de/wp-json/wp/v2/posts\?per_page=\d+&_fields=guid,link,#', $try[2]);
    assert_matches('#^https://example\.com/wp-json/#', nr_client_try('https://example.com/feed/')[1], 'site feed → its WordPress API');
    assert_same(['https://example.com/category/news/'], nr_client_try('https://example.com/category/news/'));
    assert_same(['https://example.com/?s=x'], nr_client_try('https://example.com/?s=x'));
});

test('client body: parsed as feed or WordPress list, strategy "client"', function () use ($B) {
    $r = nr_resolve_client("$B/", "$B/feed/", fixture('wp/feed.xml'));
    assert_true($r['ok']);
    assert_same('client', $r['payload']['source']['strategy']);
    assert_same('rss', $r['payload']['source']['type']);
    assert_same('rss', nr_resolve_client('https://www.cio.de/', 'https://www.cio.de/feed/', fixture('wp/feed.xml'))['payload']['source']['type']);
    assert_same('cio-de', nr_resolve_client('https://www.cio.de/', 'https://www.cio.de/feed/', fixture('wp/feed.xml'))['payload']['source']['rule']);
    assert_same('wordpress', nr_resolve_client("$B/", "$B/wp-json/wp/v2/posts", fixture('wp/posts.json'))['payload']['source']['type']);
    assert_same('NO_FEED_DETECTED', nr_resolve_client("$B/", "$B/", '<!doctype html><p>bot wall</p>')['code']);
});
