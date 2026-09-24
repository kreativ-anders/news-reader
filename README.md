# FeedForge

Stateless PHP resolver: turns any website or feed URL into normalized JSON entries.
Personal state (read/saved) stays in the client; the server only caches per source URL (shared across all clients).

## Endpoint

```
GET /api/?url=<url-encoded URL>[&refresh=1][&limit=1..100]
```

Example: `http://feedforge.localhost/api/?url=https%3A%2F%2Fwww.anthropic.com%2Fnews`

| Parameter | Meaning |
|---|---|
| `url` | Website, section page or feed URL (scheme optional, defaults to `https://`) |
| `refresh=1` | Bypass the cache; only honoured if the cache is older than 15 min |
| `limit` | Max. entries returned (default/max 100) |

## Resolution order

1. URL is RSS 2.0 / RSS 1.0 (RDF) / Atom → `strategy: direct`
2. Feed declared in HTML (`<link rel="alternate">`, visible `…/rss.xml` links) → `discovered`
3. Common feed paths (`<path>/feed`, `/rss.xml`, `/feed.xml`, `/atom.xml`, `/index.xml`, …) → `guessed`
4. HTML listing → `html-jsonld` (JSON-LD Article/ItemList), `html-article` (`<article>`), `html-links` (links below the requested path, e.g. `/news/<slug>`)
5. Sitemap (`robots.txt` → `/sitemap.xml` → `/sitemap_index.xml`), filtered to the requested path → `sitemap`

## Response

```json
{
  "source":  { "inputUrl": "...", "url": "...", "type": "rss|rdf|atom|html|sitemap",
               "strategy": "...", "feedUrl": "...|null", "title": "..." },
  "entries": [ { "id": "sha256", "url": "...", "title": "...",
                 "publishedAt": "ISO-8601|null", "updatedAt": "ISO-8601|null", "summary": "...|null" } ],
  "meta":    { "count": 42, "fetchedAt": "...", "cached": true, "stale": false,
               "cachedAt": "...", "nextRefreshAfter": "...", "version": "0.2.0" }
}
```

- `id` = sha256 of the feed GUID, otherwise of the normalized article URL → stable key for the client's `processed` / saved index.
- HTML sources keep the page order; feeds and sitemaps are sorted newest first.
- Errors: HTTP 4xx with `{ "error": { "code", "message" } }`. Codes: `INVALID_URL`, `UNSUPPORTED_URL`, `FORBIDDEN_HOST`, `DNS_FAILED`, `UPSTREAM_FETCH_FAILED`, `UPSTREAM_HTTP_ERROR`, `UPSTREAM_TOO_LARGE`, `TOO_MANY_REDIRECTS`, `NO_FEED_DETECTED`.
- Response header `X-FeedForge-Cache: HIT | MISS | STALE`.

## Cache

| Setting (`src/config.php`) | Default |
|---|---|
| `FF_CACHE_TTL` | 24 h |
| `FF_STALE_TTL` – stale data served if the source is down | 7 d |
| `FF_ERROR_TTL` – "no feed found" cached | 1 h |
| `FF_REFRESH_MIN_AGE` – rate limit for `refresh=1` | 15 min |

A per-URL `flock` ensures only one request refreshes a source at a time; concurrent requests get the stale copy.

## Setup (Wharf / nginx)

- Requires PHP 8.1+ with `dom`, `libxml`, `mbstring`. `curl` is recommended; without it the PHP stream wrapper is used (needs `openssl` for HTTPS and `allow_url_fopen = On`).
- HTTPS on Windows: the OS certificate store is used automatically (PHP 8.2+). Alternatively set `FF_CA_BUNDLE` in `src/config.php` or `curl.cainfo` in php.ini to a `cacert.pem`.
- Paste `wharf-nginx.conf` into the project's nginx config in Wharf. It blocks `/src`, `/var`, dotfiles, `*.conf`, `*.md`.
- `var/cache/` must be writable by PHP.

## Security

- Only `http`/`https`; every redirect hop is re-validated.
- SSRF: private, loopback and reserved IPs are blocked (`FF_ALLOW_PRIVATE_HOSTS = false`). Known gap: DNS rebinding between check and connect.
- Hard limits: 5 s connect, 15 s total, 5 redirects, 5 MB per response, max. 12 feed probes + 3 child sitemaps per resolve.
- XML parsed with `LIBXML_NONET` (no external entities).
