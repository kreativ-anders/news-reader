<?php
// Gherkin: gherkin/articles.feature
/** Offline copies: sanitizer and article extraction (src/readable.php) – no network. */
declare(strict_types=1);

test('sanitizer keeps structure, drops scripts, handlers and unsafe URLs', function () {
    $html = nr_sanitize_html(
        '<div class="x" style="color:red"><h2 id="h">Title</h2><p onclick="x()">Text <a href="/rel" target="_blank">link</a>'
        . ' <a href="javascript:alert(1)">bad</a> <img src="data:image/png;base64,AAA" alt="d"> <img src="/i.png" alt="ok" onerror="y()"></p>'
        . '<script>alert(1)</script><style>p{}</style><iframe src="https://evil.test"></iframe><form><input></form>'
        . '<svg><script>alert(2)</script></svg></div>',
        'https://ex.test/post'
    );
    assert_contains('<h2>Title</h2>', $html);
    assert_contains('<a href="https://ex.test/rel">link</a>', $html);
    assert_contains('src="https://ex.test/i.png"', $html);
    foreach (['<script', 'alert', 'onclick', 'onerror', 'style=', 'class=', 'id=', 'target=', 'javascript:', 'data:', '<iframe', '<form', '<svg', '<div'] as $bad) {
        assert_not_contains($bad, $html, "sanitized output");
    }
});

test('sanitizer caps huge articles at a paragraph boundary', function () {
    $html = nr_sanitize_html(str_repeat('<p>' . str_repeat('word ', 200) . '</p>', 500), 'https://ex.test/');
    assert_true(strlen($html) <= NR_ARTICLE_MAX_BYTES, 'max bytes');
    assert_true(str_ends_with($html, '</p>'), 'ends with </p>');
});

test('full text vs. teaser', function () {
    assert_null(nr_fulltext('<p>short teaser</p>', 'https://ex.test/'));
    $long = str_repeat("A long paragraph of plain text, repeated to exceed the limit.\n\n", 40);
    $full = nr_fulltext($long, 'https://ex.test/');
    assert_not_null($full, 'plain text feed content');
    assert_true(str_starts_with($full, '<p>'), 'plain text → paragraphs');
});

test('article extraction: metadata and main content without noise', function () {
    $a = nr_extract_article(fixture('article/full.html'), 'https://fixture.test/article/full.html');
    assert_same('A long read for offline reading', $a['title']);
    assert_same('Ada Lovelace', $a['byline']);
    assert_same('Fixture Times', $a['siteName']);
    assert_same('en-GB', $a['lang']);
    assert_same('2026-09-01T10:00:00Z', $a['publishedAt']);
    assert_same('https://fixture.test/img/cover.jpg', $a['image']);
    assert_false($a['partial']);
    assert_contains('Paragraph 8', $a['content']);
    foreach (['cookies', 'Related:', 'Footer text', 'Share on social', 'tracking', 'Home', '<h1'] as $noise) {
        assert_not_contains($noise, $a['content']);
    }
    assert_true(nr_word_count($a['content']) > 200, 'word count');
});

test('article extraction: paywall → partial with description', function () {
    $a = nr_extract_article(fixture('article/paywall.html'), 'https://fixture.test/article/paywall.html');
    assert_true($a['partial']);
    assert_same('Paywalled story', $a['title']);
    assert_contains('Only this description is readable', $a['content']);
});

test('article extraction: JSON-LD articleBody for script-rendered pages', function () {
    $body = str_repeat('This sentence comes from the JSON-LD articleBody only. ', 30);
    $html = '<html><head><script type="application/ld+json">' . json_encode(['@type' => 'NewsArticle', 'headline' => 'Rendered by JS', 'articleBody' => $body]) . '</script></head><body><div id="app"></div></body></html>';
    $a = nr_extract_article($html, 'https://ex.test/js');
    assert_same('Rendered by JS', $a['title']);
    assert_contains('JSON-LD articleBody', $a['content']);
    assert_false($a['partial']);
});

test('article extraction never crashes on garbage', function () {
    foreach (['', 'plain text', '<html', str_repeat('<div>', 5000), "\xff\xfe\x00"] as $html) {
        $a = nr_extract_article($html, 'https://ex.test/');
        assert_true(is_string($a['content']));
    }
});
