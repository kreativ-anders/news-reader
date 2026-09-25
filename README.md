# News Reader

**News** is a calm, local-first feed reader for phone and desktop (`app/`). Every entry gets one decision: *read now*, *later* or *not interested*.
It ships with two small server parts, both behind one PHP front controller (`api/index.php`):

- **Sync** (`/api/sync`) – end-to-end encrypted, account-free and database-free.
- **Collector** (`/api/collect`) – turns any website or feed URL into normalized JSON entries.

Project site: `index.html` (planned: https://newsreader.app). MIT-licensed, self-hostable and white-label.

## News (`app/`)

Plain ES modules, no build step.

- Flow per entry: **Inbox** → *Read now* (opens the article) → *Done* · *Later* (reading list) · *Not interested*.
- Data in IndexedDB (`news`): feed list + item states (synced), entries (per device, fetched from the Collector).
- New subscriptions show entries of the last 14 days; unseen entries that left the feed are kept 30 days.
- Offline: service worker caches the app shell; changes are queued (outbox) until the server is reachable.
- Add feeds via URL field, Android share sheet (Web Share Target), bookmarklet (`?add=<url>`) or OPML import; OPML export included.
- Swipe on touch (right: later · left: not interested); keyboard: `j`/`k`, `o` read now, `l` later, `x` not interested, `d` done, `u` undo, `r` refresh, `1`–`5` views.
- Server address: default is the server News is served from (`app/../`); changeable under *Settings*.
- **HTTPS is required** for install, service worker, share target and sync encryption (WebCrypto) – except on `localhost`.

## Sync (`/api/sync`)

One encrypted blob per vault. No database, no accounts, no schema, no merge logic on the server.

```
vault key (32 random bytes, base64url; QR code / pairing link app/#pair=<key>[&server=<url>])
  ├─ HKDF-SHA256 "newsreader-sync-v1 auth" → bearer token (43 chars)
  └─ HKDF-SHA256 "newsreader-sync-v1 enc"  → AES-256-GCM key (never leaves the device)
```

| Request | Meaning |
|---|---|
| `GET /api/sync` | Blob + `ETag`; `304` with `If-None-Match`; `404` if no vault yet |
| `PUT /api/sync` | Replace blob; requires `If-Match: "<etag>"` (update) or `If-None-Match: *` (create); `412` on conflict, `428` without precondition |
| `DELETE /api/sync` | Delete the vault (`204`) |

- Auth: `Authorization: Bearer <token>`. Stored at `var/sync/<2 hex>/<sha256(token)>.vault` – a leaked listing is useless as credentials.
- Blob: `"NRS1"` · flags (bit 0 = gzip) · 12-byte IV · AES-256-GCM ciphertext (AAD `newsreader-sync-v1`). Plaintext: `{v:1, at, records:[{kind,id,data,updatedAt}]}`.
- Client round: GET → decrypt → merge (last write wins per record) → if the device knows something newer: encrypt full snapshot → conditional PUT; on `412` repeat (max. 5).
- Records: `kind: "feed"` (`{url, title, since, d?}`), `kind: "item"` (`{s: later|reading|done|dismissed|new, t, u, f, p}`).
- Pruning (deterministic on all devices): done/dismissed/new items and unfollowed feeds older than 180 days.
- Server limits (`src/config.php`): `NR_SYNC_MAX_BYTES` 1 MB per vault, `NR_SYNC_EXPIRE_DAYS` 180 (mtime; refreshed on read once a day), `NR_SYNC_MAX_VAULTS` 10 000, `NR_SYNC_ALLOWED_NETS` (default `[]` = everyone), `NR_SYNC_ENABLED`.
- Writes are atomic (temp file + rename) under one global `flock`.
- What the server sees: token hash, blob size, timestamps – and, like any website, the client IP in the web server log.

## Collector (`/api/collect`)

```
GET /api/collect?url=<url-encoded URL>[&refresh=1][&limit=1..100]
```

`/api/?url=…` stays as alias. Without `url` the endpoint returns `{"service":"collector","version":…,"sync":true|false}` (used by News → *Settings* → *Test*).

| Parameter | Meaning |
|---|---|
| `url` | Website, section page or feed URL (scheme optional, defaults to `https://`) |
| `refresh=1` | Bypass the cache; only honoured if the cache is older than 15 min |
| `limit` | Max. entries returned (default/max 100) |

## Resolution order

1. URL is RSS 2.0 / RSS 1.0 (RDF) / Atom → `strategy: direct`
2. Feed declared in HTML (`<link rel="alternate">`, visible `…/rss.xml` links) → `discovered`
3. Common feed paths (`<path>/feed`, `/rss.xml`, `/feed.xml`, `/atom.xml`, `/index.xml`, …) → `guessed`
4. Sitemap (`robots.txt` → `/sitemap.xml` → `/sitemap_index.xml`), filtered to the requested path → `sitemap` – only accepted if at least half of the entries carry a date; slug titles are replaced by the real link titles from the requested page (no extra request)
5. HTML listing as last resort → `html-jsonld` (JSON-LD Article/ItemList), `html-article` (`<article>`), `html-links` (links below the requested path, e.g. `/news/<slug>`); missing dates are filled from the sitemap if one was found in step 4

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
- Response header `X-Collector-Cache: HIT | MISS | STALE`.

## Cache

| Setting (`src/config.php`) | Default |
|---|---|
| `NR_CACHE_TTL` | 24 h |
| `NR_STALE_TTL` – stale data served if the source is down | 7 d |
| `NR_ERROR_TTL` – "no feed found" cached | 1 h |
| `NR_REFRESH_MIN_AGE` – rate limit for `refresh=1` | 15 min |

A per-URL `flock` ensures only one request refreshes a source at a time; concurrent requests get the stale copy.

## Rate limits

File-based fixed windows per client IP (`var/rate/`, only a salted hash of the IP is stored):

| Setting | Default |
|---|---|
| `NR_RATE_COLLECT_MISS` – Collector upstream fetches (cache hits are free; when limited, a stale copy is served if available) | 60 / 10 min |
| `NR_RATE_SYNC` – all sync requests | 300 / 10 min |
| `NR_RATE_SYNC_CREATE` – new vaults | 5 / day |

Limited requests get `429` + `Retry-After`.

## White-label & brand

- Colours and fonts: `app/theme.css` (used by the site and the app). Palette „3b.1“: `#FFA500` · `#000000` · `#FFFFFF` · `#292929`.
- Shape: straight editorial lines – `--radius: 0` in `app/theme.css` (one token for site and app; e.g. `8px` for a rounder white-label look).
- Light/dark: follows the OS; the site toggle (header) and the app (*Settings → Appearance*) override it via `html[data-theme]`, stored in `localStorage` (`nr.theme`).
- Logo 3b.1 (`brand/`): `news-mark.svg` (light), `news-mark-dark.svg` (dark), `news-icon.svg` (orange app tile), `news-icon-dark.svg` (graphite tile). Inline copies use `.nr-mark` and follow the theme.
- Name and icons: `app/manifest.webmanifest`, `app/index.html`, `app/icons/`, `brand/`.
- Fonts are self-hosted (`app/fonts/`, SIL OFL 1.1): Newsreader (titles, wordmark), Source Sans 3 (text).

## Languages (i18n)

English (default), German, French, Italian, Spanish – shared loader `app/js/i18n.js`.

- One JSON file per language with nested keys: `i18n/<lang>.json` (site), `app/i18n/<lang>.json` (app).
- `en.json` is the source and must contain every key; other languages may be partial – missing keys fall back to English **per key**.
- Placeholders `{name}`; plurals via `key_one` / `key_other` (`Intl.PluralRules`) when `n` is passed.
- Static markup: `data-i18n="section.key"` (innerHTML) and `data-i18n-attr="aria-label:key;title:key"`. English stays in the HTML (works without JS, indexable).
- Language choice: saved choice (`localStorage` `nr.lang`, shared by site and app) → browser languages → English.
- Add a language: copy `en.json` to `xx.json` in both folders, translate, add `xx` to `LANGS` in `app/js/i18n.js` and to the site's language `<select>`.

## Swipe gestures (app)

*Settings → Swipe gestures*: action for swipe right / left – Later, Not interested, Done, Read now or nothing. Saved per device (IndexedDB `kv.swipe`, not synced); only actions the current view offers are used. Default: right = Later, left = Not interested.

## Setup

- PHP 8.1+ with `dom`, `libxml`, `mbstring`. `curl` recommended; without it the PHP stream wrapper is used (needs `openssl` and `allow_url_fopen = On`). **No database extension needed.**
- HTTPS on Windows: the OS certificate store is used automatically (PHP 8.2+). Alternatively `NR_CA_BUNDLE` or `curl.cainfo`.
- nginx: `nginx.conf.example` (production) or `wharf.conf.example` (local). Both block `/src`, `/var`, dotfiles, config/doc files and `*.vault`.
- `var/` (`cache/`, `sync/`, `rate/`) must be writable by PHP.
- Behind a reverse proxy: set nginx `real_ip` so rate limits see the client IP.

## Security

- Only `http`/`https`; every redirect hop is re-validated.
- SSRF: private, loopback and reserved IPs are blocked (`NR_ALLOW_PRIVATE_HOSTS = false`). Known gap: DNS rebinding between check and connect.
- Hard limits: 5 s connect, 15 s total, 5 redirects, 5 MB per response, max. 12 feed probes + 3 child sitemaps per resolve.
- XML parsed with `LIBXML_NONET` (no external entities).

## License

MIT – see `LICENSE`. `app/vendor/qrcode.js`: QR Code Generator by Kazuhiko Arase, MIT. Fonts in `app/fonts/`: SIL Open Font License 1.1.
