<?php
declare(strict_types=1);

/**
 * Resolve any URL into a normalized list of entries.
 *
 * Order – from machine-readable to heuristic:
 *   0. Platform rule (src/feed-rules.php): known page URL → native feed URL, without fetching the page
 *      (avoids bot protection on profile pages); platforms without feeds stop here
 *   1. URL itself is RSS / Atom / RDF
 *   2. Feed declared in the HTML (<link rel="alternate">, visible feed links)
 *   3. Common feed paths (/feed, /rss.xml, …)
 *   4. sitemap.xml (filtered to the requested path) – only if most entries are dated;
 *      slug titles are replaced by real titles from the page where the URL appears there
 *   5. HTML listing as last resort (JSON-LD, <article>, links below the path)
 *
 * @return array{ok:true,payload:array}|array{ok:false,code:string,message:string}
 */
function nr_resolve(string $url): array
{
    $tried = [];

    // 0. Platform rule – falls through to the generic chain if its feeds fail
    $rule = nr_rule_match($url);
    if ($rule !== null) {
        if ($rule['none'] !== null) {
            return nr_err('PLATFORM_NO_FEED', $rule['none'], ['rule' => $rule['id']]);
        }
        $hit = nr_resolve_rule($url, $rule, $tried);
        if ($hit !== null) return $hit;
    }

    $page = nr_fetch($url);
    if (!$page['ok']) return $tried ? $page + ['tried' => $tried] : $page;

    $finalUrl = $page['finalUrl'];

    // 1. Direct feed
    $feed = nr_parse_feed($page['body'], $finalUrl);
    if ($feed !== null) {
        return nr_success($url, $finalUrl, $feed['type'], 'direct', $feed['title'], $finalUrl, $feed['entries']);
    }

    if (!nr_is_html($page['contentType'], $page['body'])) {
        return nr_err('NO_FEED_DETECTED', 'The URL returned neither a feed nor an HTML page.');
    }

    $dom = nr_load_html($page['body']);
    $pageTitle = nr_page_title($dom);

    // 2. Declared feeds  3. Guessed feed paths
    $declared = nr_discover_feed_links($dom, $finalUrl);
    $candidates = array_values(array_unique(array_merge($declared, nr_guess_feed_urls($finalUrl))));

    foreach ($candidates as $i => $feedUrl) {
        if ($i >= 12) break; // hard cap on probes
        $tried[] = $feedUrl;
        $res = nr_fetch($feedUrl);
        if (!$res['ok']) continue;
        $feed = nr_parse_feed($res['body'], $res['finalUrl']);
        if ($feed !== null && count($feed['entries']) > 0) {
            $strategy = in_array($feedUrl, $declared, true) ? 'discovered' : 'guessed';
            return nr_success($url, $finalUrl, $feed['type'], $strategy, $feed['title'] ?? $pageTitle, $res['finalUrl'], $feed['entries']);
        }
    }

    // 4. Sitemap – structured, but only a feed if it carries dates
    $sitemap = null; // first non-empty sitemap result, reused for date enrichment in step 5
    foreach (nr_sitemap_candidates($finalUrl) as $sitemapUrl) {
        $tried[] = $sitemapUrl;
        $res = nr_fetch($sitemapUrl);
        if (!$res['ok']) continue;
        $entries = nr_parse_sitemap($res['body'], $res['finalUrl'], $finalUrl);
        if (!$entries) continue;
        $sitemap ??= ['url' => $res['finalUrl'], 'entries' => $entries];
        $dated = count(array_filter($entries, fn($e) => ($e['publishedAt'] ?? $e['updatedAt']) !== null));
        if (count($entries) >= 3 && $dated >= count($entries) / 2) {
            $entries = nr_titles_from_page($entries, $dom, $finalUrl);
            return nr_success($url, $finalUrl, 'sitemap', 'sitemap', $pageTitle, $res['finalUrl'], $entries);
        }
    }

    // 5. HTML listing – last resort
    $listing = nr_parse_html_listing($dom, $finalUrl);
    if ($listing !== null) {
        $entries = $listing['entries'];

        // Enrich with sitemap dates if the page shows hardly any dates
        $dated = count(array_filter($entries, fn($e) => $e['publishedAt'] !== null));
        if ($sitemap !== null && $dated < count($entries) / 2) {
            $entries = nr_enrich_with_sitemap($entries, $sitemap['entries']);
        }

        return nr_success($url, $finalUrl, 'html', $listing['strategy'], $pageTitle, null, $entries);
    }

    return nr_err('NO_FEED_DETECTED', 'No RSS/Atom feed, article listing or matching sitemap entries were found.', ['tried' => $tried]);
}

/**
 * Probe the feeds of a matched platform rule. First feed with entries wins;
 * a valid but empty feed (e.g. a repo without releases) is only used if no other has entries.
 */
function nr_resolve_rule(string $url, array $rule, array &$tried): ?array
{
    $feeds = $rule['feeds'];
    if ($rule['lookup'] !== null) {
        $tried[] = $rule['lookup']['url'];
        $found = nr_rule_lookup($rule['lookup']);
        if ($found !== null) $feeds[] = $found;
    }

    $empty = null;
    foreach ($feeds as $feedUrl) {
        $tried[] = $feedUrl;
        $res = nr_fetch($feedUrl);
        if (!$res['ok']) continue;
        $feed = nr_parse_feed($res['body'], $res['finalUrl']);
        if ($feed === null) continue;
        $hit = nr_success($url, $url, $feed['type'], 'rule', $feed['title'], $res['finalUrl'], $feed['entries'], $rule['id']);
        if (count($feed['entries']) > 0) return $hit;
        $empty ??= $hit;
    }
    return $empty;
}

/** Add sitemap dates to HTML entries that have none. */
function nr_enrich_with_sitemap(array $entries, array $sitemapEntries): array
{
    $dates = [];
    foreach ($sitemapEntries as $e) {
        $dates[nr_normalize_url($e['url'])] = $e['publishedAt'] ?? $e['updatedAt'];
    }
    foreach ($entries as &$e) {
        $key = nr_normalize_url($e['url']);
        if ($e['updatedAt'] === null && isset($dates[$key])) {
            $e['updatedAt'] = $dates[$key];
        }
    }
    return $entries;
}

/**
 * Sitemaps rarely carry titles (only Google News sitemaps do), so entries get a title
 * derived from the URL slug. If the requested page links the same URL, use its real title.
 * No extra request: the page is already loaded.
 */
function nr_titles_from_page(array $entries, DOMDocument $dom, string $baseUrl): array
{
    $titles = [];
    foreach ([nr_listing_path_links($dom, $baseUrl), nr_listing_articles($dom, $baseUrl), nr_listing_jsonld($dom, $baseUrl)] as $list) {
        foreach ($list as $e) $titles[nr_normalize_url($e['url'])] = $e; // later lists (more reliable) win
    }
    if (!$titles) return $entries;
    foreach ($entries as &$e) {
        $hit = $titles[nr_normalize_url($e['url'])] ?? null;
        if ($hit === null) continue;
        if ($e['title'] === nr_clean_text(nr_title_from_slug($e['url']))) $e['title'] = $hit['title'];
        $e['summary'] ??= $hit['summary'];
    }
    return $entries;
}

function nr_success(string $inputUrl, string $finalUrl, string $type, string $strategy, ?string $title, ?string $feedUrl, array $entries, ?string $rule = null): array
{
    $entries = array_slice($entries, 0, NR_MAX_ENTRIES);
    return [
        'ok' => true,
        'payload' => [
            'source' => [
                'inputUrl' => $inputUrl,
                'url'      => $finalUrl,
                'type'     => $type,       // rss | rdf | atom | html | sitemap
                'strategy' => $strategy,   // rule | direct | discovered | guessed | sitemap | html-jsonld | html-article | html-links
                'rule'     => $rule,       // id from src/feed-rules.php (strategy "rule" only)
                'feedUrl'  => $feedUrl,
                'title'    => $title,
            ],
            'entries' => $entries,
            'meta' => [
                'count'     => count($entries),
                'fetchedAt' => gmdate('Y-m-d\TH:i:s\Z'),
            ],
        ],
    ];
}
