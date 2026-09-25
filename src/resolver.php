<?php
declare(strict_types=1);

/**
 * Resolve any URL into a normalized list of entries.
 *
 * Order:
 *   1. URL itself is RSS / Atom / RDF
 *   2. Feed declared in the HTML (<link rel="alternate">, visible feed links)
 *   3. Common feed paths (/feed, /rss.xml, …)
 *   4. HTML article listing (JSON-LD, <article>, links below the path)
 *   5. sitemap.xml (filtered to the requested path)
 *
 * @return array{ok:true,payload:array}|array{ok:false,code:string,message:string}
 */
function nr_resolve(string $url): array
{
    $page = nr_fetch($url);
    if (!$page['ok']) return $page;

    $finalUrl = $page['finalUrl'];
    $tried = [];

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

    // 4. HTML listing
    $listing = nr_parse_html_listing($dom, $finalUrl);
    if ($listing !== null) {
        $entries = $listing['entries'];

        // Enrich with sitemap dates if the page shows hardly any dates
        $dated = count(array_filter($entries, fn($e) => $e['publishedAt'] !== null));
        if ($dated < count($entries) / 2) {
            $entries = nr_enrich_with_sitemap($entries, $finalUrl);
        }

        return nr_success($url, $finalUrl, 'html', $listing['strategy'], $pageTitle, null, $entries);
    }

    // 5. Sitemap
    foreach (nr_sitemap_candidates($finalUrl) as $sitemapUrl) {
        $tried[] = $sitemapUrl;
        $res = nr_fetch($sitemapUrl);
        if (!$res['ok']) continue;
        $entries = nr_parse_sitemap($res['body'], $res['finalUrl'], $finalUrl);
        if (count($entries) >= 3) {
            return nr_success($url, $finalUrl, 'sitemap', 'sitemap', $pageTitle, $res['finalUrl'], $entries);
        }
    }

    return nr_err('NO_FEED_DETECTED', 'No RSS/Atom feed, article listing or matching sitemap entries were found.', ['tried' => $tried]);
}

function nr_enrich_with_sitemap(array $entries, string $pageUrl): array
{
    $dates = [];
    foreach (nr_sitemap_candidates($pageUrl) as $sitemapUrl) {
        $res = nr_fetch($sitemapUrl);
        if (!$res['ok']) continue;
        foreach (nr_parse_sitemap($res['body'], $res['finalUrl'], $pageUrl) as $e) {
            $dates[nr_normalize_url($e['url'])] = $e['publishedAt'] ?? $e['updatedAt'];
        }
        if ($dates) break;
    }
    if (!$dates) return $entries;

    foreach ($entries as &$e) {
        $key = nr_normalize_url($e['url']);
        if ($e['updatedAt'] === null && isset($dates[$key])) {
            $e['updatedAt'] = $dates[$key];
        }
    }
    return $entries;
}

function nr_success(string $inputUrl, string $finalUrl, string $type, string $strategy, ?string $title, ?string $feedUrl, array $entries): array
{
    $entries = array_slice($entries, 0, NR_MAX_ENTRIES);
    return [
        'ok' => true,
        'payload' => [
            'source' => [
                'inputUrl' => $inputUrl,
                'url'      => $finalUrl,
                'type'     => $type,       // rss | rdf | atom | html | sitemap
                'strategy' => $strategy,   // direct | discovered | guessed | html-jsonld | html-article | html-links | sitemap
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
