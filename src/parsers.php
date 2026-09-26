<?php
declare(strict_types=1);

function nr_entry(string $url, string $title, ?string $publishedAt, ?string $updatedAt = null, ?string $summary = null, string $guid = '', ?string $image = null, ?string $content = null): array
{
    $entry = [
        'id'          => hash('sha256', $guid !== '' ? $guid : nr_normalize_url($url)),
        'url'         => $url,
        'title'       => nr_clean_text($title),
        'publishedAt' => $publishedAt,
        'updatedAt'   => $updatedAt,
        'summary'     => $summary !== null && $summary !== '' ? nr_summary($summary) : null,
        'image'       => $image,
    ];
    // INFO: raw feed HTML, turned into sanitized full text by nr_with_fulltext() after the entry list is final
    if ($content !== null && $content !== '') $entry['content'] = $content;
    return $entry;
}

// INFO: de-duplicates by URL (first wins) and drops non-http(s) links (javascript:, data: …);
//       with $sortByDate: dated entries newest first, undated ones keep their order at the end
function nr_finalize_entries(array $entries, bool $sortByDate): array
{
    $unique = [];
    foreach ($entries as $e) {
        if (!nr_is_http_url($e['url'])) continue;
        $key = nr_normalize_url($e['url']);
        if (!isset($unique[$key])) $unique[$key] = $e;
    }
    $entries = array_values($unique);

    if ($sortByDate) {
        $indexed = [];
        foreach ($entries as $i => $e) $indexed[] = [$i, $e];
        usort($indexed, function ($a, $b) {
            $da = $a[1]['publishedAt'] ?? $a[1]['updatedAt'] ?? '';
            $db = $b[1]['publishedAt'] ?? $b[1]['updatedAt'] ?? '';
            return [$db === '' ? 0 : 1, $db, -$a[0]] <=> [$da === '' ? 0 : 1, $da, -$b[0]];
        });
        $entries = array_column($indexed, 1);
    }

    return array_slice($entries, 0, NR_MAX_ENTRIES);
}

// INFO: full text is only kept in the server cache – /api/collect strips it, /api/article serves it
function nr_with_fulltext(array $entries): array
{
    foreach ($entries as &$e) {
        if (!isset($e['content'])) continue;
        $full = nr_fulltext($e['content'], $e['url']);
        if ($full === null) unset($e['content']);
        else $e['content'] = $full;
    }
    return $entries;
}

function nr_clean_text(string $s): string
{
    $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return trim(preg_replace('/\s+/u', ' ', $s) ?? '');
}

function nr_summary(string $html): string
{
    $html = preg_replace('/<(script|style|figcaption)\b.*?<\/\1>/is', '', $html) ?? '';
    // INFO: block boundaries become spaces, otherwise "Uses</h3><p>From" turns into "UsesFrom"
    $html = preg_replace('/<(?:br|hr|img)\b[^>]*>|<\/(?:p|div|h[1-6]|li|ul|ol|blockquote|figure|pre|tr|td|th|section|article)>/i', ' ', $html) ?? $html;
    $text = nr_clean_text(strip_tags($html));
    if (mb_strlen($text) > NR_SUMMARY_LENGTH) {
        $text = rtrim(mb_substr($text, 0, NR_SUMMARY_LENGTH - 1)) . '…';
    }
    return $text;
}

// INFO: media:thumbnail / media:content, image enclosure, itunes:image, then the first real <img> of the item HTML
function nr_item_image(DOMXPath $xp, DOMElement $item, string $html, string $baseUrl): ?string
{
    $queries = [
        './/*[local-name()="thumbnail"]/@url',
        './/*[local-name()="content" and (starts-with(@type,"image/") or @medium="image")]/@url',
        './*[local-name()="enclosure" and starts-with(@type,"image/")]/@url',
        './*[local-name()="image"]/@href',
    ];
    foreach ($queries as $q) {
        foreach ($xp->query($q, $item) ?: [] as $attr) {
            $url = nr_image_url($attr->nodeValue ?? '', $baseUrl);
            if ($url !== null) return $url;
        }
    }
    return nr_html_image($html, $baseUrl);
}

function nr_html_image(string $html, string $baseUrl): ?string
{
    if ($html === '' || stripos($html, '<img') === false) return null;
    if (!preg_match_all('/<img\b[^>]*>/i', $html, $tags)) return null;
    foreach (array_slice($tags[0], 0, 10) as $tag) {
        $attrs = [];
        preg_match_all('/([a-z-]+)\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)/i', $tag, $m, PREG_SET_ORDER);
        foreach ($m as $a) $attrs[strtolower($a[1])] ??= trim($a[2], '"\'');
        foreach (['width', 'height'] as $dim) {
            if (isset($attrs[$dim]) && is_numeric($attrs[$dim]) && (int)$attrs[$dim] < 40) continue 2;
        }
        $src = $attrs['src'] ?? '';
        if ($src === '' || str_starts_with($src, 'data:')) $src = $attrs['data-src'] ?? $attrs['data-lazy-src'] ?? '';
        $url = nr_image_url($src, $baseUrl);
        if ($url !== null) return $url;
    }
    return null;
}

// INFO: absolute http(s) image URL, or null for junk, pixels and trackers
function nr_image_url(string $src, string $baseUrl): ?string
{
    $src = trim(html_entity_decode($src, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    if ($src === '' || str_starts_with($src, 'data:')) return null;
    $url = nr_absolute_url($src, $baseUrl);
    if (!nr_is_http_url($url)) return null;
    if (preg_match('#/_/stat\?|/pixel|[/._-](?:beacon|tracker|tracking|spacer|blank)[/._?-]|feedburner\.com|feedblitz|doubleclick\.net|/wp-includes/images/smilies/|s\.w\.org/images/core/emoji|gravatar\.com/avatar|\.svg(?:$|\?)#i', $url)) return null;
    return $url;
}

function nr_children_text(DOMElement $el, array $names): string
{
    $out = '';
    foreach ($el->childNodes as $c) {
        if ($c instanceof DOMElement && in_array(strtolower($c->localName), $names, true)) $out .= $c->textContent . ' ';
    }
    return $out;
}

function nr_parse_date(?string $value): ?string
{
    $value = trim((string)$value);
    if ($value === '') return null;

    if (preg_match('/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/', $value, $m)) {
        $value = sprintf('%04d-%02d-%02d', $m[3], $m[2], $m[1]);
    }
    $ts = strtotime($value);
    if ($ts === false || $ts < 0) return null;
    return gmdate('Y-m-d\TH:i:s\Z', $ts);
}

function nr_find_date_in_text(string $text): ?string
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
            $d = nr_parse_date(nr_normalize_date_token($m[0]));
            if ($d !== null) return $d;
        }
    }
    return null;
}

function nr_normalize_date_token(string $s): string
{
    if (preg_match('/^\d{1,2}\.\d{1,2}\.\d{4}$/', $s) || preg_match('/^\d{4}-/', $s)) return $s;
    return trim(preg_replace('/\s+/', ' ', str_replace(['Sept', '.'], ['Sep', ' '], $s)) ?? $s);
}

// WARNING: no LIBXML_PARSEHUGE and no LIBXML_NOENT – libxml's limits are the protection against entity expansion ("billion laughs")
function nr_load_xml(string $body): ?DOMDocument
{
    if (str_starts_with($body, "\x1f\x8b")) {
        $body = nr_gunzip($body);
        if ($body === null) return null;
    }
    $body = ltrim(preg_replace('/^\xEF\xBB\xBF/', '', $body) ?? $body);
    if ($body === '' || $body[0] !== '<') return null;

    $prev = libxml_use_internal_errors(true);
    $dom = new DOMDocument();
    $ok = $dom->loadXML($body, LIBXML_NONET | LIBXML_NOCDATA | LIBXML_COMPACT);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);

    return $ok && $dom->documentElement ? $dom : null;
}

// INFO: text of the first non-empty direct child (any namespace) whose local name is in $names
function nr_child_text(DOMElement $el, array $names): string
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

// INFO: RSS titles are often escaped HTML, Atom titles are HTML when type="html"/"xhtml" (type="text" stays literal).
//       Only well-formed tags are removed, so "I <3 feeds" survives.
function nr_feed_title(DOMElement $el, bool $atom): string
{
    $node = nr_child_elements($el, 'title')[0] ?? null;
    if ($node === null) return '';
    $text = $node->textContent;
    if ($atom && !in_array(strtolower($node->getAttribute('type')), ['html', 'xhtml'], true)) {
        return htmlspecialchars(trim($text), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }
    return trim(preg_replace('#<!--.*?-->|</?[a-z][a-z0-9-]*(?:\s[^<>]*)?/?>#is', '', $text) ?? $text);
}

function nr_child_elements(DOMElement $el, string $name): array
{
    $out = [];
    foreach ($el->childNodes as $c) {
        if ($c instanceof DOMElement && strtolower($c->localName) === $name) $out[] = $c;
    }
    return $out;
}

// INFO: RSS 2.0, RSS 1.0 (RDF) and Atom
function nr_parse_feed(string $body, string $baseUrl): ?array
{
    $dom = nr_load_xml($body);
    if ($dom === null) return null;

    $root = $dom->documentElement;
    $rootName = strtolower($root->localName);
    $xp = new DOMXPath($dom);
    $entries = [];

    if ($rootName === 'rss' || $rootName === 'rdf') {
        $channel = $xp->query('//*[local-name()="channel"]')->item(0);
        $title = $channel instanceof DOMElement ? nr_feed_title($channel, false) : '';
        $site  = $channel instanceof DOMElement ? nr_child_text($channel, ['link']) : '';

        foreach ($xp->query('//*[local-name()="item"]') as $i => $item) {
            if ($i >= NR_MAX_PARSE_ITEMS) break;
            $guid = nr_child_text($item, ['guid']);
            $link = nr_child_text($item, ['link']);
            if ($link === '' && preg_match('#^https?://#i', $guid)) $link = $guid;
            if ($link === '') continue;

            $url = nr_absolute_url($link, $baseUrl);
            $entries[] = nr_entry(
                $url,
                nr_feed_title($item, false),
                nr_parse_date(nr_child_text($item, ['pubdate', 'date', 'published'])),
                nr_parse_date(nr_child_text($item, ['updated', 'modified'])),
                nr_child_text($item, ['description', 'encoded', 'summary']),
                $guid,
                nr_item_image($xp, $item, nr_children_text($item, ['description', 'encoded']), $url),
                nr_child_text($item, ['encoded', 'description'])
            );
        }

        return [
            'type'    => $rootName === 'rss' ? 'rss' : 'rdf',
            'title'   => $title !== '' ? nr_clean_text($title) : null,
            'siteUrl' => $site !== '' ? $site : null,
            'entries' => nr_with_fulltext(nr_finalize_entries($entries, true)),
        ];
    }

    if ($rootName === 'feed') {
        $title = nr_feed_title($root, true);
        $site = null;
        foreach (nr_child_elements($root, 'link') as $l) {
            $rel = $l->getAttribute('rel') ?: 'alternate';
            if ($rel === 'alternate') { $site = $l->getAttribute('href'); break; }
        }

        foreach (array_slice(nr_child_elements($root, 'entry'), 0, NR_MAX_PARSE_ITEMS) as $item) {
            $link = '';
            foreach (nr_child_elements($item, 'link') as $l) {
                $rel = $l->getAttribute('rel') ?: 'alternate';
                if ($rel === 'alternate' && $l->getAttribute('href') !== '') {
                    $link = $l->getAttribute('href');
                    break;
                }
            }
            $id = nr_child_text($item, ['id']);
            if ($link === '' && preg_match('#^https?://#i', $id)) $link = $id;
            if ($link === '') continue;

            $published = nr_parse_date(nr_child_text($item, ['published', 'issued', 'created']));
            $updated   = nr_parse_date(nr_child_text($item, ['updated', 'modified']));

            $url = nr_absolute_url($link, $baseUrl);
            $entries[] = nr_entry(
                $url,
                nr_feed_title($item, true),
                $published ?? $updated,
                $updated,
                nr_child_text($item, ['summary', 'content']),
                $id,
                nr_item_image($xp, $item, nr_children_text($item, ['summary', 'content']), $url),
                nr_child_text($item, ['content', 'summary'])
            );
        }

        return [
            'type'    => 'atom',
            'title'   => $title !== '' ? nr_clean_text($title) : null,
            'siteUrl' => $site ? nr_absolute_url($site, $baseUrl) : null,
            'entries' => nr_with_fulltext(nr_finalize_entries($entries, true)),
        ];
    }

    return null;
}

function nr_load_html(string $html): DOMDocument
{
    $prev = libxml_use_internal_errors(true);
    $dom = new DOMDocument();
    // INFO: the XML prolog forces UTF-8 interpretation
    $dom->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_NONET | LIBXML_NOWARNING | LIBXML_NOERROR | LIBXML_COMPACT | LIBXML_PARSEHUGE);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    return $dom;
}

function nr_is_html(string $contentType, string $body): bool
{
    return str_contains($contentType, 'html')
        || preg_match('/<html\b|<!doctype\s+html/i', substr($body, 0, 4096)) === 1;
}

function nr_page_title(DOMDocument $dom): ?string
{
    $xp = new DOMXPath($dom);
    $og = $xp->query('//meta[@property="og:site_name"]/@content')->item(0);
    $t = $dom->getElementsByTagName('title')->item(0);
    $title = $t ? nr_clean_text($t->textContent) : '';
    if ($title === '' && $og) $title = nr_clean_text($og->nodeValue ?? '');
    return $title !== '' ? $title : null;
}

// INFO: <link rel="alternate"> feeds plus visible same-host links to feed-like paths
function nr_discover_feed_links(DOMDocument $dom, string $baseUrl): array
{
    $xp = new DOMXPath($dom);
    $found = [];

    foreach ($xp->query('//link[@href]') as $link) {
        $rel  = ' ' . strtolower($link->getAttribute('rel')) . ' ';
        $type = strtolower(trim($link->getAttribute('type')));
        if (str_contains($rel, ' alternate ') && in_array($type, ['application/rss+xml', 'application/atom+xml', 'application/rdf+xml', 'application/xml', 'text/xml'], true)) {
            $found[] = nr_absolute_url($link->getAttribute('href'), $baseUrl);
        }
    }

    $host = parse_url($baseUrl, PHP_URL_HOST);
    foreach ($xp->query('//a[@href]') as $i => $a) {
        if ($i >= NR_MAX_PARSE_ITEMS) break;
        $href = nr_absolute_url($a->getAttribute('href'), $baseUrl);
        $path = strtolower((string)parse_url($href, PHP_URL_PATH));
        if (parse_url($href, PHP_URL_HOST) !== $host) continue;
        if (preg_match('#(/(rss|atom|feed)(/)?|\.(rss|atom)|/(rss|atom|feed|index)\.xml)$#', $path)) {
            $found[] = $href;
        }
    }

    return array_values(array_unique($found));
}

// INFO: common feed locations, path-specific first
function nr_guess_feed_urls(string $url): array
{
    $origin = nr_origin($url);
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

// INFO: first strategy with >= 3 hits wins: JSON-LD, <article> elements, links below the listing path
function nr_parse_html_listing(DOMDocument $dom, string $baseUrl): ?array
{
    $entries = nr_listing_jsonld($dom, $baseUrl);
    if (count($entries) >= 3) return ['strategy' => 'html-jsonld', 'entries' => $entries];

    $entries = nr_listing_articles($dom, $baseUrl);
    if (count($entries) >= 3) return ['strategy' => 'html-article', 'entries' => $entries];

    $entries = nr_listing_path_links($dom, $baseUrl);
    if (count($entries) >= 3) return ['strategy' => 'html-links', 'entries' => $entries];

    return null;
}

function nr_listing_jsonld(DOMDocument $dom, string $baseUrl): array
{
    $xp = new DOMXPath($dom);
    $entries = [];

    foreach ($xp->query('//script[@type="application/ld+json"]') as $script) {
        $data = json_decode(trim($script->textContent), true);
        if (!is_array($data)) continue;

        $stack = [$data];
        $visited = 0;
        while ($stack && ++$visited <= NR_MAX_PARSE_ITEMS * 10) {
            $node = array_pop($stack);
            if (!is_array($node)) continue;

            $type = $node['@type'] ?? null;
            $types = array_map('strtolower', (array)$type);

            if (array_intersect($types, ['article', 'blogposting', 'newsarticle', 'techarticle', 'report', 'pressrelease'])) {
                $url = $node['url'] ?? ($node['mainEntityOfPage']['@id'] ?? $node['mainEntityOfPage'] ?? null);
                $title = $node['headline'] ?? $node['name'] ?? '';
                if (is_string($url) && $url !== '' && is_string($title) && $title !== '') {
                    $absolute = nr_absolute_url($url, $baseUrl);
                    if (nr_normalize_url($absolute) !== nr_normalize_url($baseUrl)) {
                        $entries[] = nr_entry(
                            $absolute,
                            $title,
                            nr_parse_date(is_string($node['datePublished'] ?? null) ? $node['datePublished'] : null),
                            nr_parse_date(is_string($node['dateModified'] ?? null) ? $node['dateModified'] : null),
                            is_string($node['description'] ?? null) ? $node['description'] : null,
                            '',
                            nr_jsonld_image($node['image'] ?? null, $absolute)
                        );
                    }
                }
            } elseif (in_array('listitem', $types, true) && !isset($node['item']['@type'])) {
                $url = is_string($node['url'] ?? null) ? $node['url'] : (is_string($node['item'] ?? null) ? $node['item'] : ($node['item']['@id'] ?? null));
                $title = $node['name'] ?? ($node['item']['name'] ?? '');
                if (is_string($url) && is_string($title) && $title !== '') {
                    $entries[] = nr_entry(nr_absolute_url($url, $baseUrl), $title, null);
                }
            }

            // INFO: children are pushed in reverse, so the depth-first walk keeps the page order
            foreach (array_reverse($node, true) as $k => $v) {
                if (is_array($v) && $k !== 'author' && $k !== 'publisher') $stack[] = $v;
            }
        }
    }

    return nr_finalize_entries($entries, false);
}

// INFO: JSON-LD "image" is a string, an ImageObject or a list of either
function nr_jsonld_image(mixed $img, string $baseUrl): ?string
{
    if (is_array($img) && array_is_list($img)) $img = $img[0] ?? null;
    if (is_array($img)) $img = $img['url'] ?? $img['contentUrl'] ?? null;
    return is_string($img) ? nr_image_url($img, $baseUrl) : null;
}

function nr_listing_articles(DOMDocument $dom, string $baseUrl): array
{
    $xp = new DOMXPath($dom);
    $entries = [];

    foreach ($xp->query('//article[not(ancestor::nav) and not(ancestor::footer)]') as $n => $article) {
        if ($n >= NR_MAX_PARSE_ITEMS) break;
        $heading = $xp->query('.//*[self::h1 or self::h2 or self::h3 or self::h4]', $article)->item(0);
        $link = $heading ? $xp->query('.//a[@href] | ancestor::a[@href]', $heading)->item(0) : null;
        $link ??= $xp->query('.//a[@href]', $article)->item(0);
        if (!$link instanceof DOMElement) continue;

        $url = nr_absolute_url($link->getAttribute('href'), $baseUrl);
        $title = nr_clean_text($heading ? $heading->textContent : $link->textContent);
        if ($title === '' || nr_normalize_url($url) === nr_normalize_url($baseUrl)) continue;

        $date = null;
        $time = $xp->query('.//time', $article)->item(0);
        if ($time instanceof DOMElement) {
            $date = nr_parse_date($time->getAttribute('datetime') ?: $time->textContent);
        }
        $date ??= nr_find_date_in_text($article->textContent);

        $p = $xp->query('.//p', $article)->item(0);
        $image = null;
        foreach ($xp->query('.//img', $article) as $i => $img) {
            if ($i >= 3) break;
            $image = nr_html_image($dom->saveHTML($img) ?: '', $baseUrl);
            if ($image !== null) break;
        }
        $entries[] = nr_entry($url, $title, $date, null, $p ? $p->textContent : null, '', $image);
    }

    return nr_finalize_entries($entries, false);
}

// INFO: links below the listing path (/news → /news/<slug>); for a root URL only typical article paths qualify
function nr_listing_path_links(DOMDocument $dom, string $baseUrl): array
{
    $xp = new DOMXPath($dom);
    $base = parse_url($baseUrl);
    $host = strtolower((string)($base['host'] ?? ''));
    $basePath = rtrim((string)($base['path'] ?? ''), '/');

    $entries = [];

    foreach ($xp->query('//a[@href][not(ancestor::nav) and not(ancestor::header) and not(ancestor::footer)]') as $n => $a) {
        if ($n >= NR_MAX_PARSE_ITEMS) break;
        $url = nr_absolute_url($a->getAttribute('href'), $baseUrl);
        $u = parse_url($url);
        if (strtolower((string)($u['host'] ?? '')) !== $host) continue;

        $path = rtrim((string)($u['path'] ?? ''), '/');
        if (!nr_is_article_path($path, $basePath)) continue;

        [$title, $date] = nr_title_and_date_from_link($a, $xp);
        if ($title === '' || mb_strlen($title) < 8) continue;

        $url = preg_replace('/#.*$/', '', $url) ?? $url;
        $entries[] = nr_entry($url, $title, $date);
    }

    return nr_finalize_entries($entries, false);
}

function nr_is_article_path(string $path, string $basePath): bool
{
    if ($path === '' || $path === $basePath) return false;

    if (preg_match('#/(page|tag|tags|category|categories|author|authors|topic|topics|search|feed|rss)(/|$)#i', $path)) return false;
    if (preg_match('#\.(xml|json|jpg|jpeg|png|gif|svg|webp|pdf|zip|css|js)$#i', $path)) return false;

    if ($basePath !== '') {
        if (!str_starts_with($path, $basePath . '/')) return false;
        $rest = substr($path, strlen($basePath) + 1);
        return $rest !== '' && preg_match('/[a-z0-9]/i', $rest) === 1;
    }

    return preg_match('#/(19|20)\d{2}/\d{1,2}/#', $path) === 1
        || preg_match('#^/(news|blog|posts?|articles?|stories|press|updates|insights|magazin|aktuelles|neuigkeiten)/[^/]+#i', $path) === 1;
}

// INFO: date from a <time> in the link or its card; title from a heading, a *title* class or the longest text segment
function nr_title_and_date_from_link(DOMElement $a, DOMXPath $xp): array
{
    $date = null;
    $card = $a;
    for ($i = 0; $i < 2 && $card->parentNode instanceof DOMElement; $i++) {
        $parent = $card->parentNode;
        if ($xp->query('.//a[@href]', $parent)->length > 3) break;
        $card = $parent;
    }
    $time = $xp->query('.//time', $a)->item(0) ?? $xp->query('.//time', $card)->item(0);
    if ($time instanceof DOMElement) {
        $date = nr_parse_date($time->getAttribute('datetime') ?: $time->textContent);
    }

    $h = $xp->query('.//*[self::h1 or self::h2 or self::h3 or self::h4 or self::h5]', $a)->item(0);
    if ($h === null) {
        $h = $xp->query('.//*[contains(translate(@class,"TITLE","title"),"title") or contains(translate(@class,"HEADLINE","headline"),"headline")]', $a)->item(0);
    }

    $segments = [];
    foreach ($xp->query('.//text()', $a) as $t) {
        $s = nr_clean_text($t->nodeValue ?? '');
        if ($s !== '') $segments[] = $s;
    }
    $date ??= nr_find_date_in_text(implode(' | ', $segments));

    if ($h !== null) {
        $title = nr_clean_text($h->textContent);
    } else {
        $candidates = array_filter($segments, fn($s) => nr_find_date_in_text($s) === null || mb_strlen($s) > 40);
        usort($candidates, fn($x, $y) => mb_strlen($y) <=> mb_strlen($x));
        $title = $candidates[0] ?? '';
        if ($title === '') $title = nr_clean_text($a->getAttribute('title') ?: $a->getAttribute('aria-label'));
    }

    if (mb_strlen($title) > 250) $title = rtrim(mb_substr($title, 0, 249)) . '…';

    return [$title, $date];
}

// INFO: robots.txt declarations first, then the default locations
function nr_sitemap_candidates(string $url): array
{
    $origin = nr_origin($url);
    $candidates = [];

    $robots = nr_fetch($origin . '/robots.txt');
    if ($robots['ok']) {
        foreach (preg_split('/\R/', $robots['body']) ?: [] as $line) {
            if (preg_match('/^\s*sitemap:\s*(\S+)/i', $line, $m)) {
                $candidates[] = nr_absolute_url($m[1], $origin);
            }
        }
    }
    $candidates[] = $origin . '/sitemap.xml';
    $candidates[] = $origin . '/sitemap_index.xml';

    return array_slice(array_values(array_unique($candidates)), 0, 4);
}

// INFO: sitemap or sitemap index → entries below the requested path, newest first
function nr_parse_sitemap(string $body, string $sitemapUrl, string $requestedUrl, int $depth = 0): array
{
    $dom = nr_load_xml($body);
    if ($dom === null) return [];

    $root = $dom->documentElement;
    $name = strtolower($root->localName);
    $basePath = rtrim((string)parse_url($requestedUrl, PHP_URL_PATH), '/');
    $hint = strtolower(trim(basename($basePath)));

    if ($name === 'sitemapindex' && $depth === 0) {
        $children = [];
        foreach (nr_child_elements($root, 'sitemap') as $sm) {
            $loc = nr_child_text($sm, ['loc']);
            if ($loc === '') continue;
            $children[] = [
                'loc'     => nr_absolute_url($loc, $sitemapUrl),
                'lastmod' => nr_parse_date(nr_child_text($sm, ['lastmod'])) ?? '',
            ];
        }

        // INFO: child sitemaps named like the section (or news/blog/post) first, then newest lastmod
        $pattern = '/' . ($hint !== '' ? preg_quote($hint, '/') . '|' : '') . 'news|blog|post|article/i';
        foreach ($children as &$child) $child['match'] = preg_match($pattern, $child['loc']);
        unset($child);
        usort($children, fn($a, $b) => [$b['match'], $b['lastmod']] <=> [$a['match'], $a['lastmod']]);

        $entries = [];
        foreach (array_slice($children, 0, NR_MAX_CHILD_SITEMAPS) as $child) {
            $res = nr_fetch($child['loc']);
            if ($res['ok']) {
                $entries = array_merge($entries, nr_parse_sitemap($res['body'], $res['finalUrl'], $requestedUrl, 1));
            }
        }
        return nr_finalize_entries($entries, true);
    }

    if ($name !== 'urlset') return [];

    $entries = [];
    foreach (nr_child_elements($root, 'url') as $node) {
        $loc = nr_child_text($node, ['loc']);
        if ($loc === '') continue;

        $path = rtrim((string)parse_url($loc, PHP_URL_PATH), '/');
        if (!nr_is_article_path($path, $basePath)) continue;

        $newsTitle = '';
        $newsDate = null;
        foreach (nr_child_elements($node, 'news') as $news) {
            $newsTitle = nr_child_text($news, ['title']);
            $newsDate = nr_parse_date(nr_child_text($news, ['publication_date']));
        }

        $lastmod = nr_parse_date(nr_child_text($node, ['lastmod']));
        $image = null;
        foreach (nr_child_elements($node, 'image') as $img) {
            $image = nr_image_url(nr_child_text($img, ['loc']), $loc);
            if ($image !== null) break;
        }
        $entries[] = nr_entry(
            $loc,
            $newsTitle !== '' ? $newsTitle : nr_title_from_slug($loc),
            $newsDate,
            $lastmod,
            null,
            '',
            $image
        );
    }

    return nr_finalize_entries($entries, true);
}

function nr_title_from_slug(string $url): string
{
    $slug = basename(rtrim((string)parse_url($url, PHP_URL_PATH), '/'));
    $slug = preg_replace('/\.(html?|php|aspx?)$/i', '', $slug) ?? $slug;
    $slug = urldecode(str_replace(['-', '_'], ' ', $slug));
    return mb_convert_case(trim($slug), MB_CASE_TITLE, 'UTF-8');
}
