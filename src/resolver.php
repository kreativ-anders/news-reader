<?php
declare(strict_types=1);

const NR_MAX_FEED_PROBES = 12;

// INFO: resolution order, machine-readable first (README → Resolution order):
//       platform rule → direct feed → declared feed → guessed feed paths → dated sitemap → HTML listing
function nr_resolve(string $url): array
{
    $tried = [];

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

    $feed = nr_parse_feed($page['body'], $finalUrl);
    if ($feed !== null) {
        return nr_success($url, $finalUrl, $feed['type'], 'direct', $feed['title'], $finalUrl, $feed['entries'], null, $feed['siteUrl'], $feed['icon']);
    }

    if (!nr_is_html($page['contentType'], $page['body'])) {
        return nr_err('NO_FEED_DETECTED', 'The URL returned neither a feed nor an HTML page.');
    }

    $dom = nr_load_html($page['body']);
    $pageTitle = nr_page_title($dom);
    $pageIcon = nr_page_icon($dom, $finalUrl);

    $declared = nr_discover_feed_links($dom, $finalUrl);
    $candidates = array_slice(array_values(array_unique(array_merge($declared, nr_guess_feed_urls($finalUrl)))), 0, NR_MAX_FEED_PROBES);

    foreach ($candidates as $feedUrl) {
        $tried[] = $feedUrl;
        $res = nr_fetch($feedUrl);
        if (!$res['ok']) continue;
        $feed = nr_parse_feed($res['body'], $res['finalUrl']);
        if ($feed !== null && $feed['entries'] !== []) {
            $strategy = in_array($feedUrl, $declared, true) ? 'discovered' : 'guessed';
            return nr_success($url, $finalUrl, $feed['type'], $strategy, $feed['title'] ?? $pageTitle, $res['finalUrl'], $feed['entries'], null, $feed['siteUrl'] ?? $finalUrl, $pageIcon ?? $feed['icon']);
        }
    }

    // INFO: a sitemap only counts as feed if at least half of its entries are dated;
    //       the first non-empty one is kept to add dates to an HTML listing
    $sitemap = null;
    foreach (nr_sitemap_candidates($finalUrl) as $sitemapUrl) {
        $tried[] = $sitemapUrl;
        $res = nr_fetch($sitemapUrl);
        if (!$res['ok']) continue;
        $entries = nr_parse_sitemap($res['body'], $res['finalUrl'], $finalUrl);
        if (!$entries) continue;
        $sitemap ??= $entries;
        $dated = count(array_filter($entries, fn($e) => ($e['publishedAt'] ?? $e['updatedAt']) !== null));
        if (count($entries) >= 3 && $dated >= count($entries) / 2) {
            $entries = nr_titles_from_page($entries, $dom, $finalUrl);
            return nr_success($url, $finalUrl, 'sitemap', 'sitemap', $pageTitle, $res['finalUrl'], $entries, null, $finalUrl, $pageIcon);
        }
    }

    $listing = nr_parse_html_listing($dom, $finalUrl);
    if ($listing !== null) {
        $entries = $listing['entries'];
        $dated = count(array_filter($entries, fn($e) => $e['publishedAt'] !== null));
        if ($sitemap !== null && $dated < count($entries) / 2) {
            $entries = nr_enrich_with_sitemap($entries, $sitemap);
        }
        return nr_success($url, $finalUrl, 'html', $listing['strategy'], $pageTitle, null, $entries, null, $finalUrl, $pageIcon);
    }

    return nr_err('NO_FEED_DETECTED', 'No RSS/Atom feed, article listing or matching sitemap entries were found.', ['tried' => $tried]);
}

// INFO: addresses the user's browser may fetch when the source turns the Collector away (401/403): the order of
//       nr_resolve() (rule feeds, the URL itself), then the WordPress REST API, which often answers browsers (CORS)
//       where the feed does not – only for the site root or its /feed/, where "all posts" is what was asked for
function nr_client_try(string $url): array
{
    $rule = nr_rule_match($url);
    $try = [...($rule['feeds'] ?? []), $url];
    $p = parse_url($url);
    if (preg_match('#^/?(?:feed/?)?$#', (string)($p['path'] ?? '')) && ($p['query'] ?? '') === '') {
        $try[] = nr_origin($url) . '/wp-json/wp/v2/posts?per_page=' . NR_CLIENT_WP_POSTS
            . '&_fields=guid,link,title,excerpt,date_gmt,modified_gmt,jetpack_featured_media_url,author_name';
    }
    return array_values(array_unique(array_filter($try, 'nr_is_http_url')));
}

// INFO: parses a body the app fetched itself from one of nr_client_try() – no upstream request, no cache
function nr_resolve_client(string $url, string $from, string $body): array
{
    $rule = nr_rule_match($url);
    $feed = nr_parse_feed($body, $from) ?? nr_parse_wp_posts($body, $from);
    if ($feed === null) {
        return nr_err('NO_FEED_DETECTED', 'The body is neither a feed nor a WordPress post list.');
    }
    $isRuleFeed = in_array($from, $rule['feeds'] ?? [], true);
    return nr_success($url, $from, $feed['type'], 'client', $feed['title'], $from, $feed['entries'], $isRuleFeed ? $rule['id'] : null, $feed['siteUrl'], $feed['icon']);
}

// INFO: first feed with entries wins; a valid but empty feed is only used if no other has entries
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
        $hit = nr_success($url, $url, $feed['type'], 'rule', $feed['title'], $res['finalUrl'], $feed['entries'], $rule['id'], $feed['siteUrl'], $feed['icon']);
        if ($feed['entries'] !== []) return $hit;
        $empty ??= $hit;
    }
    return $empty;
}

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

// INFO: sitemaps rarely carry titles – replace slug titles with the link titles of the already loaded page
function nr_titles_from_page(array $entries, DOMDocument $dom, string $baseUrl): array
{
    $titles = [];
    foreach ([nr_listing_path_links($dom, $baseUrl), nr_listing_articles($dom, $baseUrl), nr_listing_jsonld($dom, $baseUrl)] as $list) {
        foreach ($list as $e) $titles[nr_normalize_url($e['url'])] = $e;
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

function nr_success(string $inputUrl, string $finalUrl, string $type, string $strategy, ?string $title, ?string $feedUrl, array $entries, ?string $rule = null, ?string $siteUrl = null, ?string $icon = null): array
{
    $entries = array_slice($entries, 0, NR_MAX_ENTRIES);
    return [
        'ok' => true,
        'payload' => [
            'source' => [
                'inputUrl' => $inputUrl,
                'url'      => $finalUrl,
                'type'     => $type,
                'strategy' => $strategy,
                'rule'     => $rule,
                'feedUrl'  => $feedUrl,
                'title'    => $title,
                'siteUrl'  => $siteUrl !== null && nr_is_http_url($siteUrl) ? $siteUrl : null,
                'icon'     => $icon,
            ],
            'entries' => $entries,
            'meta' => [
                'count'     => count($entries),
                'fetchedAt' => nr_iso(time()),
            ],
        ],
    ];
}
