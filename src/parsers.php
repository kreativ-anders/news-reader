<?php
declare(strict_types=1);

// =====================================================================
//  Entry model
// =====================================================================

function ff_entry(string $url, string $title, ?string $publishedAt, ?string $updatedAt = null, ?string $summary = null, string $guid = ''): array
{
    return [
        'id'          => hash('sha256', $guid !== '' ? $guid : ff_normalize_url($url)),
        'url'         => $url,
        'title'       => ff_clean_text($title),
        'publishedAt' => $publishedAt,
        'updatedAt'   => $updatedAt,
        'summary'     => $summary !== null && $summary !== '' ? ff_summary($summary) : null,
    ];
}

/** Deduplicate by URL (first wins). Optionally sort newest first. */
function ff_finalize_entries(array $entries, bool $sortByDate): array
{
    $unique = [];
    foreach ($entries as $e) {
        $key = ff_normalize_url($e['url']);
        if (!isset($unique[$key])) $unique[$key] = $e;
    }
    $entries = array_values($unique);

    if ($sortByDate) {
        // stable sort: dated entries newest first, undated keep relative order at the end
        $indexed = [];
        foreach ($entries as $i => $e) $indexed[] = [$i, $e];
        usort($indexed, function ($a, $b) {
            $da = $a[1]['publishedAt'] ?? $a[1]['updatedAt'] ?? '';
            $db = $b[1]['publishedAt'] ?? $b[1]['updatedAt'] ?? '';
            return [$db === '' ? 0 : 1, $db, -$a[0]] <=> [$da === '' ? 0 : 1, $da, -$b[0]];
        });
        $entries = array_column($indexed, 1);
    }

    return array_slice($entries, 0, FF_MAX_ENTRIES);
}

function ff_clean_text(string $s): string
{
    $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return trim(preg_replace('/\s+/u', ' ', $s) ?? '');
}

function ff_summary(string $html): string
{
    $text = ff_clean_text(strip_tags(preg_replace('/<(script|style)\b.*?<\/\1>/is', '', $html) ?? ''));
    if (mb_strlen($text) > FF_SUMMARY_LENGTH) {
        $text = rtrim(mb_substr($text, 0, FF_SUMMARY_LENGTH - 1)) . '…';
    }
    return $text;
}

function ff_parse_date(?string $value): ?string
{
    $value = trim((string)$value);
    if ($value === '') return null;

    // German numeric format 18.09.2026
    if (preg_match('/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/', $value, $m)) {
        $value = sprintf('%04d-%02d-%02d', $m[3], $m[2], $m[1]);
    }
    $ts = strtotime($value);
    if ($ts === false || $ts < 0) return null;
    return gmdate('Y-m-d\TH:i:s\Z', $ts);
}

/** Finds a human-readable date inside arbitrary text. */
function ff_find_date_in_text(string $text): ?string
{
    $months = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
    $patterns = [
        '/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\b/',
        '/\b(?:' . $months . ')\.?\s+\d{1,2},?\s+\d{4}\b/i',
        '/\b\d{1,2}\.?\s+(?:' . $months . ')\.?\s+\d{4}\b/i',
        '/\b\d{1,2}\.\d{1,2}\.\d{4}\b/',
    ];
    foreach ($patterns as $p) {
        if (preg_match($p, $text, $m)) {
            $d = ff_parse_date(ff_normalize_date_token($m[0]));
            if ($d !== null) return $d;
        }
    }
    return null;
}

function ff_normalize_date_token(string $s): string
{
    if (preg_match('/^\d{1,2}\.\d{1,2}\.\d{4}$/', $s) || preg_match('/^\d{4}-/', $s)) return $s;
    return trim(preg_replace('/\s+/', ' ', str_replace(['Sept', '.'], ['Sep', ' '], $s)) ?? $s);
}

// =====================================================================
//  XML helpers
// =====================================================================

function ff_load_xml(string $body): ?DOMDocument
{
    if (str_starts_with($body, "\x1f\x8b")) {
        $decoded = @gzdecode($body);
        if ($decoded === false) return null;
        $body = $decoded;
    }
    $body = ltrim(preg_replace('/^\xEF\xBB\xBF/', '', $body) ?? $body);
    if ($body === '' || $body[0] !== '<') return null;

    $prev = libxml_use_internal_errors(true);
    $dom = new DOMDocument();
    $ok = $dom->loadXML($body, LIBXML_NONET | LIBXML_NOCDATA | LIBXML_COMPACT | LIBXML_PARSEHUGE);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);

    return $ok && $dom->documentElement ? $dom : null;
}

/** First direct child element (any namespace) whose local name is in $names; returns its text. */
function ff_child_text(DOMElement $el, array $names): string
{
    foreach ($names as $name) {
        foreach ($el->childNodes as $c) {
            if ($c instanceof DOMElement && strtolower($c->localName) === $name) {
                $t = trim($c->textContent);
                if ($t !== '') return $t;
            }
        }
    }
    return '';
}

function ff_child_elements(DOMElement $el, string $name): array
{
    $out = [];
    foreach ($el->childNodes as $c) {
        if ($c instanceof DOMElement && strtolower($c->localName) === $name) $out[] = $c;
    }
    return $out;
}

// =====================================================================
//  RSS 2.0 / RSS 1.0 (RDF) / Atom
// =====================================================================

/** @return array{type:string,title:?string,siteUrl:?string,entries:array}|null */
function ff_parse_feed(string $body, string $baseUrl): ?array
{
    $dom = ff_load_xml($body);
    if ($dom === null) return null;

    $root = $dom->documentElement;
    $rootName = strtolower($root->localName);
    $xp = new DOMXPath($dom);
    $entries = [];

    if ($rootName === 'rss' || $rootName === 'rdf') {
        $channel = $xp->query('//*[local-name()="channel"]')->item(0);
        $title = $channel instanceof DOMElement ? ff_child_text($channel, ['title']) : '';
        $site  = $channel instanceof DOMElement ? ff_child_text($channel, ['link']) : '';

        foreach ($xp->query('//*[local-name()="item"]') as $item) {
            /** @var DOMElement $item */
            $guid = ff_child_text($item, ['guid']);
            $link = ff_child_text($item, ['link']);
            if ($link === '' && preg_match('#^https?://#i', $guid)) $link = $guid;
            if ($link === '') continue;

            $entries[] = ff_entry(
                ff_absolute_url($link, $baseUrl),
                ff_child_text($item, ['title']),
                ff_parse_date(ff_child_text($item, ['pubdate', 'date', 'published'])),
                ff_parse_date(ff_child_text($item, ['updated', 'modified'])),
                ff_child_text($item, ['description', 'encoded', 'summary']),
                $guid
            );
        }

        return [
            'type'    => $rootName === 'rss' ? 'rss' : 'rdf',
            'title'   => $title !== '' ? ff_clean_text($title) : null,
            'siteUrl' => $site !== '' ? $site : null,
            'entries' => ff_finalize_entries($entries, true),
        ];
    }

    if ($rootName === 'feed') {
        $title = ff_child_text($root, ['title']);
        $site = null;
        foreach (ff_child_elements($root, 'link') as $l) {
            $rel = $l->getAttribute('rel') ?: 'alternate';
            if ($rel === 'alternate') { $site = $l->getAttribute('href'); break; }
        }

        foreach (ff_child_elements($root, 'entry') as $item) {
            $link = '';
            foreach (ff_child_elements($item, 'link') as $l) {
                $rel = $l->getAttribute('rel') ?: 'alternate';
                if ($rel === 'alternate' && $l->getAttribute('href') !== '') {
                    $link = $l->getAttribute('href');
                    break;
                }
            }
            $id = ff_child_text($item, ['id']);
            if ($link === '' && preg_match('#^https?://#i', $id)) $link = $id;
            if ($link === '') continue;

            $published = ff_parse_date(ff_child_text($item, ['published', 'issued', 'created']));
            $updated   = ff_parse_date(ff_child_text($item, ['updated', 'modified']));

            $entries[] = ff_entry(
                ff_absolute_url($link, $baseUrl),
                ff_child_text($item, ['title']),
                $published ?? $updated,
                $updated,
                ff_child_text($item, ['summary', 'content']),
                $id
            );
        }

        return [
            'type'    => 'atom',
            'title'   => $title !== '' ? ff_clean_text($title) : null,
            'siteUrl' => $site ? ff_absolute_url($site, $baseUrl) : null,
            'entries' => ff_finalize_entries($entries, true),
        ];
    }

    return null;
}

// =====================================================================
//  HTML helpers
// =====================================================================

function ff_load_html(string $html): DOMDocument
{
    $prev = libxml_use_internal_errors(true);
    $dom = new DOMDocument();
    // Force UTF-8 interpretation
    $dom->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_NONET | LIBXML_NOWARNING | LIBXML_NOERROR | LIBXML_COMPACT | LIBXML_PARSEHUGE);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    return $dom;
}

function ff_is_html(string $contentType, string $body): bool
{
    return str_contains($contentType, 'html')
        || preg_match('/<html\b|<!doctype\s+html/i', substr($body, 0, 4096)) === 1;
}

function ff_page_title(DOMDocument $dom): ?string
{
    $xp = new DOMXPath($dom);
    $og = $xp->query('//meta[@property="og:site_name"]/@content')->item(0);
    $t = $dom->getElementsByTagName('title')->item(0);
    $title = $t ? ff_clean_text($t->textContent) : '';
    if ($title === '' && $og) $title = ff_clean_text($og->nodeValue ?? '');
    return $title !== '' ? $title : null;
}

/** Explicit <link rel="alternate" type="application/rss+xml"> plus visible feed links. */
function ff_discover_feed_links(DOMDocument $dom, string $baseUrl): array
{
    $xp = new DOMXPath($dom);
    $found = [];

    foreach ($xp->query('//link[@href]') as $link) {
        /** @var DOMElement $link */
        $rel  = ' ' . strtolower($link->getAttribute('rel')) . ' ';
        $type = strtolower(trim($link->getAttribute('type')));
        if (str_contains($rel, ' alternate ') && in_array($type, ['application/rss+xml', 'application/atom+xml', 'application/rdf+xml', 'application/feed+json', 'application/xml', 'text/xml'], true)) {
            if ($type === 'application/feed+json') continue; // JSON Feed not supported yet
            $found[] = ff_absolute_url($link->getAttribute('href'), $baseUrl);
        }
    }

    // <a href="...rss.xml"> / ".../feed" in page body (same host only)
    $host = parse_url($baseUrl, PHP_URL_HOST);
    foreach ($xp->query('//a[@href]') as $a) {
        /** @var DOMElement $a */
        $href = ff_absolute_url($a->getAttribute('href'), $baseUrl);
        $path = strtolower((string)parse_url($href, PHP_URL_PATH));
        if (parse_url($href, PHP_URL_HOST) !== $host) continue;
        if (preg_match('#(/(rss|atom|feed)(/)?|\.(rss|atom)|/(rss|atom|feed|index)\.xml)$#', $path)) {
            $found[] = $href;
        }
    }

    return array_values(array_unique($found));
}

/** Common feed locations to probe when nothing is declared. Path-specific first. */
function ff_guess_feed_urls(string $url): array
{
    $origin = ff_origin($url);
    $path = rtrim((string)parse_url($url, PHP_URL_PATH), '/');
    $guesses = [];

    if ($path !== '') {
        foreach (['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'] as $s) {
            $guesses[] = $origin . $path . $s;
        }
    }
    foreach (['/feed', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'] as $s) {
        $guesses[] = $origin . $s;
    }
    return array_values(array_unique($guesses));
}

// =====================================================================
//  HTML article listings
// =====================================================================

/**
 * Extract articles from an HTML listing page. Strategies (first with >= 3 hits wins):
 *   1. JSON-LD (ItemList / Article / BlogPosting / NewsArticle)
 *   2. <article> elements
 *   3. Links below the listing path, e.g. /news -> /news/<slug>
 *
 * @return array{strategy:string, entries:array}|null
 */
function ff_parse_html_listing(DOMDocument $dom, string $baseUrl): ?array
{
    $entries = ff_listing_jsonld($dom, $baseUrl);
    if (count($entries) >= 3) return ['strategy' => 'html-jsonld', 'entries' => $entries];

    $entries = ff_listing_articles($dom, $baseUrl);
    if (count($entries) >= 3) return ['strategy' => 'html-article', 'entries' => $entries];

    $entries = ff_listing_path_links($dom, $baseUrl);
    if (count($entries) >= 3) return ['strategy' => 'html-links', 'entries' => $entries];

    return null;
}

function ff_listing_jsonld(DOMDocument $dom, string $baseUrl): array
{
    $xp = new DOMXPath($dom);
    $entries = [];

    foreach ($xp->query('//script[@type="application/ld+json"]') as $script) {
        $data = json_decode(trim($script->textContent), true);
        if (!is_array($data)) continue;

        $stack = [$data];
        while ($stack) {
            $node = array_pop($stack);
            if (!is_array($node)) continue;

            $type = $node['@type'] ?? null;
            $types = array_map('strtolower', (array)$type);

            if (array_intersect($types, ['article', 'blogposting', 'newsarticle', 'techarticle', 'report', 'pressrelease'])) {
                $url = $node['url'] ?? ($node['mainEntityOfPage']['@id'] ?? $node['mainEntityOfPage'] ?? null);
                $title = $node['headline'] ?? $node['name'] ?? '';
                if (is_string($url) && $url !== '' && is_string($title) && $title !== '') {
                    $absolute = ff_absolute_url($url, $baseUrl);
                    if (ff_normalize_url($absolute) !== ff_normalize_url($baseUrl)) {
                        $entries[] = ff_entry(
                            $absolute,
                            $title,
                            ff_parse_date(is_string($node['datePublished'] ?? null) ? $node['datePublished'] : null),
                            ff_parse_date(is_string($node['dateModified'] ?? null) ? $node['dateModified'] : null),
                            is_string($node['description'] ?? null) ? $node['description'] : null
                        );
                    }
                }
            } elseif (in_array('listitem', $types, true) && !isset($node['item']['@type'])) {
                $url = is_string($node['url'] ?? null) ? $node['url'] : (is_string($node['item'] ?? null) ? $node['item'] : ($node['item']['@id'] ?? null));
                $title = $node['name'] ?? ($node['item']['name'] ?? '');
                if (is_string($url) && is_string($title) && $title !== '') {
                    $entries[] = ff_entry(ff_absolute_url($url, $baseUrl), $title, null);
                }
            }

            foreach ($node as $k => $v) {
                if (is_array($v) && $k !== 'author' && $k !== 'publisher') $stack[] = $v;
            }
        }
    }

    return ff_finalize_entries($entries, false);
}

function ff_listing_articles(DOMDocument $dom, string $baseUrl): array
{
    $xp = new DOMXPath($dom);
    $entries = [];

    foreach ($xp->query('//article[not(ancestor::nav) and not(ancestor::footer)]') as $article) {
        /** @var DOMElement $article */
        $heading = $xp->query('.//*[self::h1 or self::h2 or self::h3 or self::h4]', $article)->item(0);
        $link = $heading ? $xp->query('.//a[@href] | ancestor::a[@href]', $heading)->item(0) : null;
        $link ??= $xp->query('.//a[@href]', $article)->item(0);
        if (!$link instanceof DOMElement) continue;

        $url = ff_absolute_url($link->getAttribute('href'), $baseUrl);
        $title = ff_clean_text($heading ? $heading->textContent : $link->textContent);
        if ($title === '' || ff_normalize_url($url) === ff_normalize_url($baseUrl)) continue;

        $date = null;
        $time = $xp->query('.//time', $article)->item(0);
        if ($time instanceof DOMElement) {
            $date = ff_parse_date($time->getAttribute('datetime') ?: $time->textContent);
        }
        $date ??= ff_find_date_in_text($article->textContent);

        $p = $xp->query('.//p', $article)->item(0);
        $entries[] = ff_entry($url, $title, $date, null, $p ? $p->textContent : null);
    }

    return ff_finalize_entries($entries, false);
}

/**
 * Links whose path is *below* the listing path. For https://example.com/news
 * this collects /news/<slug>; for a root URL only typical article paths qualify.
 */
function ff_listing_path_links(DOMDocument $dom, string $baseUrl): array
{
    $xp = new DOMXPath($dom);
    $base = parse_url($baseUrl);
    $host = strtolower((string)($base['host'] ?? ''));
    $basePath = rtrim((string)($base['path'] ?? ''), '/');

    $entries = [];

    foreach ($xp->query('//a[@href][not(ancestor::nav) and not(ancestor::header) and not(ancestor::footer)]') as $a) {
        /** @var DOMElement $a */
        $url = ff_absolute_url($a->getAttribute('href'), $baseUrl);
        $u = parse_url($url);
        if (strtolower((string)($u['host'] ?? '')) !== $host) continue;

        $path = rtrim((string)($u['path'] ?? ''), '/');
        if (!ff_is_article_path($path, $basePath)) continue;

        [$title, $date] = ff_title_and_date_from_link($a, $xp);
        if ($title === '' || mb_strlen($title) < 8) continue;

        $url = preg_replace('/#.*$/', '', $url) ?? $url;
        $entries[] = ff_entry($url, $title, $date);
    }

    return ff_finalize_entries($entries, false);
}

function ff_is_article_path(string $path, string $basePath): bool
{
    if ($path === '' || $path === $basePath) return false;

    // pagination, taxonomy, feeds, assets
    if (preg_match('#/(page|tag|tags|category|categories|author|authors|topic|topics|search|feed|rss)(/|$)#i', $path)) return false;
    if (preg_match('#\.(xml|json|jpg|jpeg|png|gif|svg|webp|pdf|zip|css|js)$#i', $path)) return false;

    if ($basePath !== '') {
        if (!str_starts_with($path, $basePath . '/')) return false;
        $rest = substr($path, strlen($basePath) + 1);
        return $rest !== '' && preg_match('/[a-z0-9]/i', $rest) === 1;
    }

    // Root listing: accept only typical article URL shapes
    return preg_match('#/(19|20)\d{2}/\d{1,2}/#', $path) === 1
        || preg_match('#^/(news|blog|posts?|articles?|stories|press|updates|insights|magazin|aktuelles|neuigkeiten)/[^/]+#i', $path) === 1;
}

/** @return array{0:string,1:?string} */
function ff_title_and_date_from_link(DOMElement $a, DOMXPath $xp): array
{
    // Date: <time> inside the link or its card
    $date = null;
    $card = $a;
    for ($i = 0; $i < 2 && $card->parentNode instanceof DOMElement; $i++) {
        $parent = $card->parentNode;
        if ($xp->query('.//a[@href]', $parent)->length > 3) break;
        $card = $parent;
    }
    $time = $xp->query('.//time', $a)->item(0) ?? $xp->query('.//time', $card)->item(0);
    if ($time instanceof DOMElement) {
        $date = ff_parse_date($time->getAttribute('datetime') ?: $time->textContent);
    }

    // Title: heading inside link > [class*=title] > longest text segment
    $h = $xp->query('.//*[self::h1 or self::h2 or self::h3 or self::h4 or self::h5]', $a)->item(0);
    if ($h === null) {
        $h = $xp->query('.//*[contains(translate(@class,"TITLE","title"),"title") or contains(translate(@class,"HEADLINE","headline"),"headline")]', $a)->item(0);
    }

    $segments = [];
    foreach ($xp->query('.//text()', $a) as $t) {
        $s = ff_clean_text($t->nodeValue ?? '');
        if ($s !== '') $segments[] = $s;
    }
    $date ??= ff_find_date_in_text(implode(' | ', $segments));

    if ($h !== null) {
        $title = ff_clean_text($h->textContent);
    } else {
        $candidates = array_filter($segments, fn($s) => ff_find_date_in_text($s) === null || mb_strlen($s) > 40);
        usort($candidates, fn($x, $y) => mb_strlen($y) <=> mb_strlen($x));
        $title = $candidates[0] ?? '';
        if ($title === '') $title = ff_clean_text($a->getAttribute('title') ?: $a->getAttribute('aria-label'));
    }

    if (mb_strlen($title) > 250) $title = rtrim(mb_substr($title, 0, 249)) . '…';

    return [$title, $date];
}

// =====================================================================
//  Sitemaps
// =====================================================================

/** Candidate sitemap URLs: robots.txt declarations first, then defaults. */
function ff_sitemap_candidates(string $url): array
{
    $origin = ff_origin($url);
    $candidates = [];

    $robots = ff_fetch($origin . '/robots.txt');
    if ($robots['ok']) {
        foreach (preg_split('/\R/', $robots['body']) ?: [] as $line) {
            if (preg_match('/^\s*sitemap:\s*(\S+)/i', $line, $m)) {
                $candidates[] = ff_absolute_url($m[1], $origin);
            }
        }
    }
    $candidates[] = $origin . '/sitemap.xml';
    $candidates[] = $origin . '/sitemap_index.xml';

    return array_slice(array_values(array_unique($candidates)), 0, 4);
}

/**
 * Parse a sitemap (or sitemap index), keep URLs below the requested path.
 * Returns entries sorted by lastmod / news publication date.
 */
function ff_parse_sitemap(string $body, string $sitemapUrl, string $requestedUrl, int $depth = 0): array
{
    $dom = ff_load_xml($body);
    if ($dom === null) return [];

    $root = $dom->documentElement;
    $name = strtolower($root->localName);
    $basePath = rtrim((string)parse_url($requestedUrl, PHP_URL_PATH), '/');
    $hint = strtolower(trim(basename($basePath)));

    if ($name === 'sitemapindex' && $depth === 0) {
        $children = [];
        foreach (ff_child_elements($root, 'sitemap') as $sm) {
            $loc = ff_child_text($sm, ['loc']);
            if ($loc === '') continue;
            $children[] = [
                'loc'     => ff_absolute_url($loc, $sitemapUrl),
                'lastmod' => ff_parse_date(ff_child_text($sm, ['lastmod'])) ?? '',
            ];
        }

        // Prefer child sitemaps named like the section (news, blog, post) and newest lastmod
        $wanted = $hint !== '' ? $hint : 'news|blog|post|article';
        usort($children, function ($a, $b) use ($wanted) {
            $ma = preg_match('/' . preg_quote($wanted, '/') . '|news|blog|post|article/i', $a['loc']) ? 1 : 0;
            $mb = preg_match('/' . preg_quote($wanted, '/') . '|news|blog|post|article/i', $b['loc']) ? 1 : 0;
            return [$mb, $b['lastmod']] <=> [$ma, $a['lastmod']];
        });

        $entries = [];
        foreach (array_slice($children, 0, FF_MAX_CHILD_SITEMAPS) as $child) {
            $res = ff_fetch($child['loc']);
            if ($res['ok']) {
                $entries = array_merge($entries, ff_parse_sitemap($res['body'], $res['finalUrl'], $requestedUrl, 1));
            }
        }
        return ff_finalize_entries($entries, true);
    }

    if ($name !== 'urlset') return [];

    $entries = [];
    foreach (ff_child_elements($root, 'url') as $node) {
        $loc = ff_child_text($node, ['loc']);
        if ($loc === '') continue;

        $path = rtrim((string)parse_url($loc, PHP_URL_PATH), '/');
        if (!ff_is_article_path($path, $basePath)) continue;

        // Google News sitemap extension
        $newsTitle = '';
        $newsDate = null;
        foreach (ff_child_elements($node, 'news') as $news) {
            $newsTitle = ff_child_text($news, ['title']);
            $newsDate = ff_parse_date(ff_child_text($news, ['publication_date']));
        }

        $lastmod = ff_parse_date(ff_child_text($node, ['lastmod']));
        $entries[] = ff_entry(
            $loc,
            $newsTitle !== '' ? $newsTitle : ff_title_from_slug($loc),
            $newsDate,
            $lastmod
        );
    }

    return ff_finalize_entries($entries, true);
}

function ff_title_from_slug(string $url): string
{
    $slug = basename(rtrim((string)parse_url($url, PHP_URL_PATH), '/'));
    $slug = preg_replace('/\.(html?|php|aspx?)$/i', '', $slug) ?? $slug;
    $slug = urldecode(str_replace(['-', '_'], ' ', $slug));
    return mb_convert_case(trim($slug), MB_CASE_TITLE, 'UTF-8');
}
