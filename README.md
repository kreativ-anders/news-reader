# FeedForge

Stateless PHP resolver: turns any website or feed URL into normalized JSON entries.
Personal state (read/saved) stays in the client; the server only caches per source URL (shared across all clients).

Ships with **Flint** (`app/`), a local-first reader PWA, and an optional, account-free sync store (`/api/sync`).

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

## Flint (`app/`)

Local-first reader for phone and desktop browser – plain ES modules, no build step.

- Flow per entry: **Inbox** → *Read now* (opens the article) → *Done* · *Later* (reading list) · *Not interested*.
- Data in IndexedDB: feed list + item states (synced), entries (per device, fetched from `/api/`).
- New subscriptions show entries of the last 14 days; unseen entries that left the feed are kept 30 days.
- Offline: service worker caches the app shell; changes queue in an outbox until the server is reachable.
- Add feeds via URL field, Android share sheet (Web Share Target, installed PWA), bookmarklet (`?add=<url>`) or OPML import. OPML export included.
- Swipe on touch (right: later · left: not interested), keyboard on desktop: `j`/`k`, `o` read now, `l` later, `x` not interested, `d` done, `u` undo, `r` refresh, `1`–`5` views.
- Server address: default is the Feedforge instance Flint is served from (`app/../`); changeable under *Settings*.
- **HTTPS is required** for install, service worker and share target (except `localhost`). For LAN-only use, e.g. a subdomain pointing to the private IP with a Let's Encrypt certificate via DNS-01.

## Flint sync (`/api/sync`)

Dumb key/value log, no accounts, no business logic. Records are `{kind, id, data, updatedAt}`; the server keeps the record with the highest client timestamp (last write wins) and assigns an increasing sequence number to every accepted write.

| Request | Meaning |
|---|---|
| `GET /api/sync?since=<cursor>[&limit=1..1000]` | Changes after `cursor` → `{ records, cursor, more, epoch, serverTime }` |
| `POST /api/sync` `{"records":[…]}` | Merge (max. 1000 per request) → `{ ok, applied, ignored, epoch, serverTime }` |
| `DELETE /api/sync` | Delete the vault on the server |

- Auth: `Authorization: Bearer <vault key>` (32–128 chars base64url). The first device generates the key; others join via QR code / pairing link (`app/#pair=<key>[&server=<url>]`). The server stores only `sha256(key)`.
- Flint uses `kind: "feed"` (`{url, title, since, d?}`) and `kind: "item"` (`{s: later|reading|done|dismissed|new, t, u, f, p}` – title/URL snapshot so the reading list survives the feed window).
- `epoch` changes when the database is replaced → clients reset their cursor and re-upload.
- Client timestamps more than 5 min in the future are clamped to server time.
- Default: only loopback and private networks may sync (`FF_SYNC_ALLOWED_NETS`, checked against `REMOTE_ADDR`; behind a reverse proxy adjust accordingly). `FF_SYNC_ENABLED = false` turns the endpoint off.
- Storage: `var/sync/flint.sqlite` (needs `pdo_sqlite`; `var/` is blocked by the nginx configs).

## Setup (Wharf / nginx)

- Requires PHP 8.1+ with `dom`, `libxml`, `mbstring`. `curl` is recommended; without it the PHP stream wrapper is used (needs `openssl` for HTTPS and `allow_url_fopen = On`).
- HTTPS on Windows: the OS certificate store is used automatically (PHP 8.2+). Alternatively set `FF_CA_BUNDLE` in `src/config.php` or `curl.cainfo` in php.ini to a `cacert.pem`.
- Wharf: paste `wharf.conf.example` into the project's nginx config. Plain nginx: `nginx.conf.example`. Both block `/src`, `/var`, dotfiles and config/doc files.
- `var/` (`cache/`, `sync/`) must be writable by PHP. `pdo_sqlite` is only needed for Flint sync.
- No extra nginx rule for Flint or sync: `/app/` is static, `/api/sync` is routed through `api/index.php`.

## Security

- Only `http`/`https`; every redirect hop is re-validated.
- SSRF: private, loopback and reserved IPs are blocked (`FF_ALLOW_PRIVATE_HOSTS = false`). Known gap: DNS rebinding between check and connect.
- Hard limits: 5 s connect, 15 s total, 5 redirects, 5 MB per response, max. 12 feed probes + 3 child sitemaps per resolve.
- XML parsed with `LIBXML_NONET` (no external entities).

## License

MIT – see `LICENSE`. `app/vendor/qrcode.js`: QR Code Generator by Kazuhiko Arase, MIT.
