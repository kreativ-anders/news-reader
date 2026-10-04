<?php
// Gherkin: gherkin/collector.feature
// INFO: feed titles with markup and JSON-LD order (formerly known issues in tests/api/collector.test.mjs)
declare(strict_types=1);

$atom = fn(string $title) => '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>'
    . "<entry>$title<link href=\"https://example.org/a\"/><id>urn:a</id></entry></feed>";
$rss = fn(string $title) => '<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>'
    . "<item><title>$title</title><link>https://example.org/a</link></item></channel></rss>";
$first = fn(?array $feed) => $feed['entries'][0]['title'] ?? null;

test('Atom titles follow their type', function () use ($atom, $first) {
    assert_same('Entry two', $first(nr_parse_feed($atom('<title type="html">Entry &lt;em&gt;two&lt;/em&gt;</title>'), 'https://example.org/')));
    assert_same('Entry two', $first(nr_parse_feed($atom('<title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Entry <em>two</em></div></title>'), 'https://example.org/')));
    assert_same('Use <em> for emphasis', $first(nr_parse_feed($atom('<title>Use &lt;em&gt; for emphasis</title>'), 'https://example.org/')), 'type="text" is literal');
    assert_same('Tom & Jerry', $first(nr_parse_feed($atom('<title type="html">Tom &amp;amp; Jerry</title>'), 'https://example.org/')));
});

test('RSS titles: escaped markup is removed, plain "<" survives', function () use ($rss, $first) {
    assert_same('Bold news', $first(nr_parse_feed($rss('&lt;b&gt;Bold&lt;/b&gt; news'), 'https://example.org/')));
    assert_same('I <3 feeds', $first(nr_parse_feed($rss('I &lt;3 feeds'), 'https://example.org/')));
    assert_same('a < b', $first(nr_parse_feed($rss('a &lt; b'), 'https://example.org/')));
});

test('JSON-LD listings keep the page order', function () {
    $html = '<html><head><script type="application/ld+json">{"@graph":['
        . '{"@type":"BlogPosting","headline":"one","url":"/one"},'
        . '{"@type":"BlogPosting","headline":"two","url":"/two"},'
        . '{"@type":"ItemList","itemListElement":[{"@type":"ListItem","url":"/three","name":"three"},{"@type":"ListItem","url":"/four","name":"four"}]}'
        . ']}</script></head><body></body></html>';
    $entries = nr_listing_jsonld(nr_load_html($html), 'https://example.org/');
    assert_same(['one', 'two', 'three', 'four'], array_column($entries, 'title'));
});

test('article extraction uses the first Article in the JSON-LD graph', function () {
    $html = '<html><head><script type="application/ld+json">{"@graph":['
        . '{"@type":"NewsArticle","headline":"Main story"},{"@type":"NewsArticle","headline":"Related story"}'
        . ']}</script></head><body><p>x</p></body></html>';
    assert_same('Main story', nr_extract_article($html, 'https://example.org/a')['title']);
});
