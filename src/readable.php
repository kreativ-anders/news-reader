<?php
declare(strict_types=1);

/**
 * Readable article content – for offline copies of "Later" items.
 *
 *   nr_fulltext()          feed content (content:encoded / Atom content) → clean HTML, if it is full text
 *   nr_extract_article()   article page → readable main content (Readability-style scoring)
 *   nr_sanitize_node()     whitelist sanitizer used by both: only structural tags, no attributes
 *                          except a[href] and img[src|alt], absolute http(s) URLs only
 */

const NR_KEEP_TAGS = [
    'p' => 1, 'br' => 1, 'hr' => 1, 'h2' => 1, 'h3' => 1, 'h4' => 1, 'h5' => 1, 'h6' => 1,
    'ul' => 1, 'ol' => 1, 'li' => 1, 'dl' => 1, 'dt' => 1, 'dd' => 1,
    'blockquote' => 1, 'pre' => 1, 'code' => 1, 'em' => 1, 'strong' => 1, 'b' => 1, 'i' => 1,
    'u' => 1, 's' => 1, 'mark' => 1, 'small' => 1, 'sub' => 1, 'sup' => 1, 'q' => 1, 'cite' => 1, 'abbr' => 1,
    'a' => 1, 'img' => 1, 'figure' => 1, 'figcaption' => 1,
    'table' => 1, 'thead' => 1, 'tbody' => 1, 'tfoot' => 1, 'tr' => 1, 'th' => 1, 'td' => 1, 'caption' => 1,
];

/** Removed together with their content. Everything not listed here or in NR_KEEP_TAGS is unwrapped. */
const NR_DROP_TAGS = [
    'script' => 1, 'style' => 1, 'noscript' => 1, 'template' => 1, 'iframe' => 1, 'frame' => 1, 'frameset' => 1,
    'object' => 1, 'embed' => 1, 'applet' => 1, 'form' => 1, 'input' => 1, 'button' => 1, 'select' => 1,
    'textarea' => 1, 'option' => 1, 'label' => 1, 'svg' => 1, 'math' => 1, 'canvas' => 1, 'video' => 1,
    'audio' => 1, 'source' => 1, 'track' => 1, 'picture' => 0, 'map' => 1, 'link' => 1, 'meta' => 1,
    'base' => 1, 'head' => 1, 'title' => 1, 'nav' => 1, 'aside' => 1, 'dialog' => 1,
];

/** Visible text length of an HTML string / node. */
function nr_text_length(string $html): int
{
    return mb_strlen(nr_clean_text(strip_tags(preg_replace('/<(script|style)\b.*?<\/\1>/is', '', $html) ?? '')));
}

/** Feed item HTML → sanitized full text, or null if it is only a teaser. */
function nr_fulltext(string $html, string $baseUrl): ?string
{
    if (strlen($html) < NR_FULLTEXT_MIN_CHARS) return null;
    // plain text feeds: keep paragraphs
    if (!preg_match('/<[a-z][^>]*>/i', $html)) {
        $html = '<p>' . implode('</p><p>', array_map('htmlspecialchars', preg_split('/\n\s*\n/', trim($html)) ?: [])) . '</p>';
    }
    $clean = nr_sanitize_html($html, $baseUrl);
    return nr_text_length($clean) >= NR_FULLTEXT_MIN_CHARS ? $clean : null;
}

function nr_sanitize_html(string $html, string $baseUrl): string
{
    $dom = nr_load_html('<!DOCTYPE html><html><body><div id="nr-root">' . $html . '</div></body></html>');
    $root = $dom->getElementById('nr-root');
    return $root ? nr_sanitize_node($root, $baseUrl) : '';
}

/** Sanitized inner HTML of $root (the root element itself is not included). */
function nr_sanitize_node(DOMNode $root, string $baseUrl): string
{
    $out = new DOMDocument('1.0', 'UTF-8');
    $wrap = $out->appendChild($out->createElement('div'));
    foreach (iterator_to_array($root->childNodes) as $child) {
        nr_clean_into($child, $wrap, $out, $baseUrl, 0);
    }
    nr_prune_empty($wrap);

    $html = '';
    foreach ($wrap->childNodes as $c) $html .= $out->saveHTML($c);
    $html = trim(preg_replace('/(?:\s*<br>\s*){3,}/', '<br><br>', $html) ?? $html);

    if (strlen($html) > NR_ARTICLE_MAX_BYTES) {
        // cut at a block boundary, never inside a tag
        $cut = strrpos(substr($html, 0, NR_ARTICLE_MAX_BYTES), '</p>');
        $html = $cut !== false ? substr($html, 0, $cut + 4) : '';
        $html = nr_sanitize_html($html, $baseUrl); // re-balance tags
    }
    return $html;
}

function nr_clean_into(DOMNode $node, DOMNode $parent, DOMDocument $out, string $base, int $depth): void
{
    if ($node instanceof DOMText) {
        $parent->appendChild($out->createTextNode($node->nodeValue ?? ''));
        return;
    }
    if (!$node instanceof DOMElement || $depth > 60) return;

    $tag = strtolower($node->localName ?? '');
    if (!empty(NR_DROP_TAGS[$tag])) return;
    if (preg_match('/\b(?:hidden|sr-only|visually-hidden)\b/', $node->getAttribute('class')) || $node->hasAttribute('hidden') || $node->getAttribute('aria-hidden') === 'true') return;

    if ($tag === 'h1') $tag = 'h2';

    if ($tag === 'img') {
        $src = nr_img_source($node, $base);
        if ($src === null) return;
        $img = $out->createElement('img');
        $img->setAttribute('src', $src);
        $alt = trim($node->getAttribute('alt'));
        if ($alt !== '') $img->setAttribute('alt', mb_substr($alt, 0, 300));
        $parent->appendChild($img);
        return;
    }

    if ($tag === 'a') {
        $href = trim($node->getAttribute('href'));
        $abs = $href !== '' && !str_starts_with($href, '#') ? nr_absolute_url($href, $base) : '';
        if (!preg_match('#^(?:https?://|mailto:)#i', $abs)) {
            foreach (iterator_to_array($node->childNodes) as $c) nr_clean_into($c, $parent, $out, $base, $depth + 1);
            return;
        }
        $el = $out->createElement('a');
        $el->setAttribute('href', $abs);
    } elseif (isset(NR_KEEP_TAGS[$tag])) {
        $el = $out->createElement($tag);
    } else {
        // unknown / layout element (div, span, section, …): keep the content, drop the element;
        // block-level wrappers become a paragraph break so text does not run together
        $block = in_array($tag, ['div', 'section', 'article', 'main', 'header', 'footer', 'center'], true);
        foreach (iterator_to_array($node->childNodes) as $c) nr_clean_into($c, $parent, $out, $base, $depth + 1);
        if ($block && $parent->lastChild instanceof DOMText && trim($parent->lastChild->nodeValue ?? '') !== '') {
            $parent->appendChild($out->createElement('br'));
        }
        return;
    }

    $parent->appendChild($el);
    foreach (iterator_to_array($node->childNodes) as $c) nr_clean_into($c, $el, $out, $base, $depth + 1);
}

/** Best image URL of an <img> (lazy-loading attributes, srcset); null for pixels/trackers. */
function nr_img_source(DOMElement $img, string $base): ?string
{
    foreach (['width', 'height'] as $dim) {
        $v = $img->getAttribute($dim);
        if (is_numeric($v) && (int)$v < 40) return null;
    }
    $cands = [];
    foreach (['data-src', 'data-lazy-src', 'data-original', 'data-url', 'src'] as $a) {
        $v = trim($img->getAttribute($a));
        if ($v !== '' && !str_starts_with($v, 'data:')) $cands[] = $v;
    }
    foreach (['data-srcset', 'srcset'] as $a) {
        $set = trim($img->getAttribute($a));
        if ($set !== '') {
            // largest candidate of "url 400w, url 800w"
            $best = '';
            $bestW = -1;
            foreach (preg_split('/,\s+/', $set) ?: [] as $part) {
                $bits = preg_split('/\s+/', trim($part));
                $w = isset($bits[1]) ? (int)$bits[1] : 0;
                if ($bits[0] !== '' && $w > $bestW) { $best = $bits[0]; $bestW = $w; }
            }
            if ($best !== '') array_unshift($cands, $best);
        }
    }
    foreach ($cands as $c) {
        $url = nr_image_url($c, $base);
        if ($url !== null) return $url;
    }
    return null;
}

/** Remove elements without text and without images (empty <p>, leftover wrappers). */
function nr_prune_empty(DOMNode $node): void
{
    foreach (iterator_to_array($node->childNodes) as $c) {
        if (!$c instanceof DOMElement) continue;
        nr_prune_empty($c);
        $tag = $c->localName;
        if (in_array($tag, ['br', 'hr', 'img', 'td', 'th'], true)) continue;
        if (trim($c->textContent) === '' && $c->getElementsByTagName('img')->length === 0) {
            $node->removeChild($c);
        }
    }
    // no leading / trailing <br>
    while ($node->firstChild instanceof DOMElement && $node->firstChild->localName === 'br') $node->removeChild($node->firstChild);
    while ($node->lastChild instanceof DOMElement && $node->lastChild->localName === 'br') $node->removeChild($node->lastChild);
}

// =====================================================================
//  Article page → readable content
// =====================================================================

const NR_NOISE = '/(?:^|[\s_-])(?:comment|comments|disqus|share|sharing|social|related|recommend|promo|newsletter|advert|ads?|sponsor|cookie|consent|subscribe|paywall-?prompt|sidebar|breadcrumbs?|popup|modal|overlay|footer|masthead|menu|navigation|navbar|toolbar|tags?|author-?bio|signup|outbrain|taboola)(?:$|[\s_-])/i';

/**
 * @return array{title:?string, byline:?string, siteName:?string, lang:?string, publishedAt:?string,
 *               image:?string, excerpt:?string, content:string, partial:bool}
 */
function nr_extract_article(string $html, string $url): array
{
    $dom = nr_load_html($html);
    $xp = new DOMXPath($dom);
    $meta = function (array $names) use ($xp): ?string {
        foreach ($names as $n) {
            $v = $xp->query('//meta[@property="' . $n . '" or @name="' . $n . '"]/@content')->item(0);
            if ($v && trim($v->nodeValue ?? '') !== '') return nr_clean_text($v->nodeValue);
        }
        return null;
    };

    // ---- metadata (meta tags, JSON-LD)
    $ld = nr_article_jsonld($xp);
    $h1 = $xp->query('//h1')->item(0);
    $docTitle = $dom->getElementsByTagName('title')->item(0);
    $title = $meta(['og:title', 'twitter:title']) ?? ($ld['headline'] ?? null)
        ?? ($h1 ? nr_clean_text($h1->textContent) : null) ?? ($docTitle ? nr_clean_text($docTitle->textContent) : null);
    $byline = $meta(['author', 'article:author', 'parsely-author', 'sailthru.author']) ?? ($ld['author'] ?? null);
    if ($byline !== null && preg_match('#^https?://#', $byline)) $byline = null;
    $published = nr_parse_date($meta(['article:published_time', 'datePublished', 'pubdate', 'date', 'dc.date']) ?? ($ld['datePublished'] ?? null));
    $imageRaw = $meta(['og:image', 'twitter:image']) ?? ($ld['image'] ?? null);
    $image = $imageRaw !== null ? nr_image_url($imageRaw, $url) : null;
    $excerpt = $meta(['og:description', 'description', 'twitter:description']);
    $htmlEl = $dom->getElementsByTagName('html')->item(0);
    $lang = $htmlEl instanceof DOMElement && preg_match('/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/', $htmlEl->getAttribute('lang')) ? $htmlEl->getAttribute('lang') : null;

    // ---- remove noise before scoring
    foreach (iterator_to_array($xp->query('//script|//style|//noscript|//template|//iframe|//form|//nav|//aside|//footer|//svg|//button|//dialog|//*[@role="navigation" or @role="banner" or @role="contentinfo" or @role="complementary" or @role="dialog" or @aria-hidden="true" or @hidden]')) as $n) {
        $n->parentNode?->removeChild($n);
    }
    // class/id noise ("related-posts", "share-bar", "comments" …) – but never a wrapper that holds
    // most of the page text (e.g. "site-content has-sidebar")
    $bodyEl = $dom->getElementsByTagName('body')->item(0);
    $bodyLen = max(1, $bodyEl ? mb_strlen(trim($bodyEl->textContent)) : 1);
    foreach (iterator_to_array($xp->query('//*[@class or @id]')) as $n) {
        /** @var DOMElement $n */
        if (!$n->parentNode || in_array($n->localName, ['html', 'body', 'article', 'main'], true)) continue;
        $sig = $n->getAttribute('class') . ' ' . $n->getAttribute('id');
        if (preg_match(NR_NOISE, $sig) && mb_strlen(trim($n->textContent)) < 0.5 * $bodyLen) {
            $n->parentNode->removeChild($n);
        }
    }

    // ---- pick the main content node
    $best = null;
    foreach (['//*[@itemprop="articleBody"]', '//article[.//p]', '//main[.//p]', '//*[@role="main"][.//p]'] as $q) {
        foreach ($xp->query($q) as $n) {
            if (mb_strlen(trim($n->textContent)) > 500 && ($best === null || mb_strlen($n->textContent) > mb_strlen($best->textContent) * 1.3)) $best = $n;
        }
        if ($best !== null) break;
    }
    $scored = nr_best_scored_node($xp);
    // an <article>/<main> that is much larger than the densest text block usually contains teasers
    if ($scored !== null && ($best === null || !nr_contains($best, $scored) || mb_strlen($best->textContent) > 3 * mb_strlen($scored->textContent))) {
        if ($best === null || mb_strlen(trim($scored->textContent)) > 300) $best = $scored;
    }

    $content = '';
    if ($best !== null) {
        // the headline is shown separately
        foreach (iterator_to_array($xp->query('.//h1', $best)) as $n) $n->parentNode?->removeChild($n);
        $content = nr_sanitize_node($best, $url);
    }

    // JSON-LD articleBody helps on script-rendered pages (text only, but complete)
    $partial = false;
    $len = nr_text_length($content);
    if (!empty($ld['articleBody']) && mb_strlen($ld['articleBody']) > max(400, (int)($len * 1.5))) {
        $paras = preg_split('/\n\s*\n|\r\n\s*\r\n|(?<=[.!?])\n/', trim($ld['articleBody'])) ?: [];
        $content = '<p>' . implode('</p><p>', array_map(fn($p) => htmlspecialchars(trim($p), ENT_QUOTES | ENT_HTML5, 'UTF-8'), array_filter($paras, fn($p) => trim($p) !== ''))) . '</p>';
        $len = nr_text_length($content);
    }
    if ($len < 400) {
        // paywall, script-only page or teaser: whatever there is, plus the description
        $partial = true;
        if ($len < 80) $content = $excerpt !== null ? '<p>' . htmlspecialchars($excerpt, ENT_QUOTES | ENT_HTML5, 'UTF-8') . '</p>' : '';
    }

    return [
        'title'       => $title,
        'byline'      => $byline !== null ? mb_substr($byline, 0, 200) : null,
        'siteName'    => $meta(['og:site_name', 'application-name']),
        'lang'        => $lang,
        'publishedAt' => $published,
        'image'       => $image,
        'excerpt'     => $excerpt !== null ? mb_substr($excerpt, 0, 500) : null,
        'content'     => $content,
        'partial'     => $partial,
    ];
}

/** Readability-style scoring: paragraphs vote for their parent (full) and grandparent (half). */
function nr_best_scored_node(DOMXPath $xp): ?DOMElement
{
    $scores = new SplObjectStorage();
    foreach ($xp->query('//p|//pre|//td|//blockquote') as $p) {
        $text = nr_clean_text($p->textContent);
        $len = mb_strlen($text);
        if ($len < 25) continue;
        $score = 1 + substr_count($text, ',') + min(3, intdiv($len, 100));
        $parent = $p->parentNode;
        $grand = $parent?->parentNode;
        foreach ([[$parent, 1.0], [$grand, 0.5]] as [$node, $w]) {
            if (!$node instanceof DOMElement || in_array($node->localName, ['html', 'body'], true)) continue;
            $scores[$node] = ($scores->contains($node) ? $scores[$node] : 0) + $score * $w;
        }
    }
    $best = null;
    $bestScore = 0.0;
    foreach ($scores as $node) {
        // link-heavy blocks (teaser lists, tag clouds) lose
        $text = mb_strlen($node->textContent) ?: 1;
        $links = 0;
        foreach ($node->getElementsByTagName('a') as $a) $links += mb_strlen($a->textContent);
        $s = $scores[$node] * (1 - min(0.9, $links / $text));
        if ($s > $bestScore) { $bestScore = $s; $best = $node; }
    }
    return $best;
}

function nr_contains(DOMNode $outer, DOMNode $inner): bool
{
    for ($n = $inner; $n !== null; $n = $n->parentNode) if ($n->isSameNode($outer)) return true;
    return false;
}

/** headline, author, datePublished, image, articleBody of the first Article-like JSON-LD object. */
function nr_article_jsonld(DOMXPath $xp): array
{
    foreach ($xp->query('//script[@type="application/ld+json"]') as $s) {
        $data = json_decode(trim($s->textContent), true);
        if (!is_array($data)) continue;
        $stack = [$data];
        while ($stack) {
            $o = array_pop($stack);
            if (!is_array($o)) continue;
            if (isset($o['@graph']) && is_array($o['@graph'])) array_push($stack, ...$o['@graph']);
            if (array_is_list($o)) { array_push($stack, ...$o); continue; }
            $type = implode(' ', (array)($o['@type'] ?? []));
            if (!preg_match('/Article|BlogPosting|Report|NewsArticle/i', $type)) continue;
            $author = $o['author'] ?? null;
            if (is_array($author)) $author = array_is_list($author) ? ($author[0]['name'] ?? $author[0] ?? null) : ($author['name'] ?? null);
            $img = $o['image'] ?? null;
            if (is_array($img)) $img = array_is_list($img) ? ($img[0]['url'] ?? $img[0] ?? null) : ($img['url'] ?? null);
            return array_filter([
                'headline'      => is_string($o['headline'] ?? null) ? nr_clean_text($o['headline']) : null,
                'author'        => is_string($author) ? nr_clean_text($author) : null,
                'datePublished' => is_string($o['datePublished'] ?? null) ? $o['datePublished'] : null,
                'image'         => is_string($img) ? $img : null,
                'articleBody'   => is_string($o['articleBody'] ?? null) ? html_entity_decode($o['articleBody'], ENT_QUOTES | ENT_HTML5, 'UTF-8') : null,
            ], fn($v) => $v !== null && $v !== '');
        }
    }
    return [];
}

// =====================================================================
//  GET /api/article?url=<article url>[&feed=<feed url>&id=<entry id>]
// =====================================================================

/**
 * 1. feed + id given and the cached feed carries the full text → served from there
 *    (no upstream request at all, no rate limit)
 * 2. otherwise the article page is fetched once (SSRF-checked, rate limited),
 *    reduced to its readable content and cached for NR_ARTICLE_TTL
 */
function nr_article_handle(): never
{
    header('Content-Type: application/json; charset=utf-8');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('X-Content-Type-Options: nosniff');
    header('X-Robots-Tag: noindex');

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'OPTIONS') { http_response_code(204); exit; }
    if ($method !== 'GET') nr_respond(['error' => ['code' => 'METHOD_NOT_ALLOWED', 'message' => 'Use GET.']], 405);

    $url = trim((string)($_GET['url'] ?? ''));
    if ($url === '') {
        nr_respond(['service' => 'article', 'version' => NR_VERSION,
            'usage' => 'GET /api/article?url=<article url>[&feed=<feed url>&id=<entry id>]'], 400);
    }
    if (strlen($url) > 2048 || !filter_var($url, FILTER_VALIDATE_URL) || !preg_match('#^https?://#i', $url)) {
        nr_respond(['error' => ['code' => 'INVALID_URL', 'message' => 'Provide a valid HTTP(S) URL in the "url" parameter.']], 400);
    }

    // ---- 1. full text from the cached feed
    $feed = trim((string)($_GET['feed'] ?? ''));
    $id = strtolower(trim((string)($_GET['id'] ?? '')));
    if ($feed !== '' && strlen($feed) <= 2048 && filter_var($feed, FILTER_VALIDATE_URL)) {
        $cachedFeed = nr_cache_read($feed);
        $norm = nr_normalize_url($url);
        foreach ($cachedFeed['data']['entries'] ?? [] as $e) {
            if (empty($e['content'])) continue;
            if (($id !== '' && hash_equals((string)$e['id'], $id)) || nr_normalize_url((string)$e['url']) === $norm) {
                header('X-Article-Source: feed');
                header('Cache-Control: public, max-age=3600');
                nr_respond(['article' => [
                    'url' => $e['url'], 'title' => $e['title'] ?: null, 'byline' => null, 'siteName' => $cachedFeed['data']['source']['title'] ?? null,
                    'lang' => null, 'publishedAt' => $e['publishedAt'] ?? null, 'image' => $e['image'] ?? null,
                    'content' => $e['content'], 'words' => nr_word_count($e['content']), 'source' => 'feed', 'partial' => false,
                ], 'meta' => ['cached' => true, 'version' => NR_VERSION]]);
            }
        }
    }

    // ---- 2. extracted article page
    if (($invalid = nr_validate_target($url)) !== null) {
        nr_respond(['error' => ['code' => $invalid['code'], 'message' => $invalid['message']]], 400);
    }

    $serve = function (array $cached, string $state): never {
        $data = $cached['data'];
        header('X-Article-Source: page');
        header('X-Collector-Cache: ' . $state);
        if (isset($data['error'])) {
            nr_respond(['error' => $data['error'], 'meta' => ['cached' => true]], 422);
        }
        header('Cache-Control: public, max-age=' . max(0, NR_ARTICLE_TTL - $cached['age']));
        nr_respond(['article' => $data['article'], 'meta' => [
            'cached' => $state !== 'MISS', 'cachedAt' => gmdate('Y-m-d\TH:i:s\Z', (int)$data['cachedAt']), 'version' => NR_VERSION,
        ]]);
    };

    $cached = nr_cache_read($url, 'article');
    if ($cached !== null && $cached['age'] < (isset($cached['data']['error']) ? NR_ARTICLE_ERROR_TTL : NR_ARTICLE_TTL)) {
        $serve($cached, 'HIT');
    }

    if ($wait = nr_rate_hit('article', NR_RATE_ARTICLE_MISS)) {
        if ($cached !== null && !isset($cached['data']['error'])) $serve($cached, 'STALE');
        nr_rate_reject($wait);
    }

    $lock = nr_lock($url, true, 'article'); // one fetch per URL; others wait and read the cache
    $fresh = nr_cache_read($url, 'article');
    if ($fresh !== null && $fresh['age'] < 60) {
        nr_unlock($lock);
        $serve($fresh, 'HIT');
    }

    $page = nr_fetch($url, NR_ACCEPT_HTML);
    if ($page['ok'] && !nr_is_html($page['contentType'], $page['body'])) {
        $page = nr_err('NOT_AN_ARTICLE', 'The URL does not point to an HTML page.');
    }
    if (!$page['ok']) {
        $error = ['code' => $page['code'], 'message' => $page['message']];
        if (isset($page['status'])) $error['upstreamStatus'] = $page['status'];
        if ($cached !== null && !isset($cached['data']['error'])) {
            nr_unlock($lock);
            $serve($cached, 'STALE');
        }
        nr_cache_write($url, ['error' => $error], 'article');
        nr_unlock($lock);
        nr_respond(['error' => $error, 'meta' => ['cached' => false]], 422);
    }

    $a = nr_extract_article($page['body'], $page['finalUrl']);
    if ($a['content'] === '') {
        $error = ['code' => 'NO_CONTENT', 'message' => 'No readable content found on the page.'];
        nr_cache_write($url, ['error' => $error], 'article');
        nr_unlock($lock);
        nr_respond(['error' => $error, 'meta' => ['cached' => false]], 422);
    }

    $article = [
        'url' => $page['finalUrl'], 'title' => $a['title'], 'byline' => $a['byline'], 'siteName' => $a['siteName'],
        'lang' => $a['lang'], 'publishedAt' => $a['publishedAt'], 'image' => $a['image'],
        'content' => $a['content'], 'words' => nr_word_count($a['content']), 'source' => 'page', 'partial' => $a['partial'],
    ];
    nr_cache_write($url, ['article' => $article], 'article');
    nr_unlock($lock);
    $serve(nr_cache_read($url, 'article') ?? ['data' => ['article' => $article, 'cachedAt' => time()], 'age' => 0], 'MISS');
}

function nr_word_count(string $html): int
{
    return count(preg_split('/\s+/u', nr_clean_text(strip_tags(str_replace('<', ' <', $html))), -1, PREG_SPLIT_NO_EMPTY) ?: []);
}
