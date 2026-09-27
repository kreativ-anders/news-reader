# News Reader

Self-hosted, local-first RSS reader. **News** (`app/`) is the PWA for phone and desktop: every entry gets one decision – *read now*, *later* or *not interested*. The server part is a PHP front controller (`api/index.php`) with three endpoints:

| Endpoint | Purpose |
|---|---|
| `/api/collect` | **Collector** – any website or feed URL → normalized JSON entries |
| `/api/article` | Readable offline copies for the *Later* list |
| `/api/sync` | End-to-end encrypted sync, no accounts, no database |

Project site: `index.html`, `privacy.html`, `imprint.html`, `thanks.html` + generated `de/ fr/ it/ es/` (https://news-reader.app), short API page `docs/api/` (English only). Shared site assets: `site.css`, `site.js`. MIT, white-label.

## Setup

- PHP 8.5+ with `dom`, `libxml`, `mbstring`; `curl` recommended (fallback: stream wrapper, needs `openssl` + `allow_url_fopen`). No database.
- `var/` (`cache/`, `sync/`, `rate/`) writable by PHP.
- nginx: `nginx.conf.example` (production) or `wharf.conf.example` (local). Both block `/src`, `/var`, `/tests`, `/tools`, dotfiles, config/doc files and `*.vault`.
- HTTPS required for install, service worker, share target and WebCrypto (except `localhost`). Windows: OS certificate store is used, else `NR_CA_BUNDLE` / `curl.cainfo`.
- Behind a reverse proxy: configure nginx `real_ip`, otherwise rate limits see the proxy.
- Settings: `src/config.php` (`NR_*` constants).

## Deploy

Run on every deploy and after changing `index.html` or `i18n/*.json`:

```
php tools/build-i18n.php --site=https://news-reader.app/
```

Writes the English text from `i18n/en.json` into the site pages (`PAGES`: index, privacy, imprint, thanks), generates `<lang>/<page>`, refreshes `hreflang`, canonical, FAQ structured data and `sitemap.xml` (index/privacy/imprint per language + `app/` + `docs/api/`, see `EXTRA_PAGES`; `thanks.html` is `noindex`). Links starting with `./` (e.g. `./privacy.html`) stay in the page's language, all other relative links are rewritten to the root. `--site` = public base URL (self-hosters: own domain). CLI only. Static hosting: run locally, commit the output. Never edit `de/ fr/ it/ es/` by hand.

## App (`app/`)

Plain ES modules, no build step.

- States: *Inbox* → *Read now* (opens original in a new tab, marks *Done*, undo toast) · *Later* · *Not interested*. *Read again* in *Done* → *Read now*. *Later* → *Mark all done* (respects feed filter).
- List: posts grouped by day (sticky header with count; *Inbox* by publication date, the other views by last change). Card actions appear on hover, focus and keyboard selection (always on touch); the main action keeps its label. Images a feed repeats on several posts (logos, placeholders) are hidden. Saved offline copies show the reading time. *Layout*: comfortable or compact (headlines only), per device (`localStorage` `news.density`, key `v`).
- Sources (sidebar, desktop): folders and feeds of the current view with counts; feeds with nothing in the view fold behind *+ n more*; hidden with a single feed. Filter = one feed or one folder (narrow screens: select with option groups). Favicon: Collector `source.icon`, else `/favicon.ico` of `source.siteUrl`, else a monogram. Feed titles drop platform wording (*Stories by X on Medium* → *X*).
- Folders: *Feeds* → folder button (free text, existing folders suggested; empty = none); synced as `g` in the feed record; OPML import reads the enclosing outline, export nests by folder.
- Feed context (filtered to one feed): posts per week (last 28 days) and read rate (*later/read now/done* vs. *not interested*, from 5 decisions on) with folder / rename / unfollow; also in the *Feeds* list.
- Inbox subtitle: first run explains the three choices, afterwards *n new · n sorted today*.
- Search and go to (`/`, Ctrl/Cmd+K, search button): views, folders and feeds; with a query also every known post title – jumps to the post's view and selects it (*Not interested* posts open the original).
- Storage: IndexedDB `news` – feeds + item states (synced), entries (per device), `articles` (offline copies, per device), `kv.swipe` (swipe config, per device), `kv.fetchState` (per feed: last check, strategy, icon, site – per device).
- Retention: new subscriptions show the last 14 days; unseen entries that left the feed are kept 30 days; offline copies of done/dismissed items are dropped after 1 day.
- Offline: service worker caches the app shell, changes are queued until the server is reachable. Entries moved to *Later* are saved once via `/api/article`; offline they open in a full-screen reader (scrolled to the end → *Done*).
- Adding feeds: URL field, Web Share Target, bookmarklet (`?add=<url>`), OPML import/export.
- Input: swipe (default right = Later, left = Not interested; configurable), keys `j`/`k`, `o`, `l`, `x`, `d`, `u`, `r`, `1`–`5`, `/`, `v`, `?` (overview).
- Server: defaults to the origin News is served from; changeable in *Settings*.

## Collector (`/api/collect`)

```
GET /api/collect?url=<url>[&refresh=1][&limit=1..100]
```

`url` – page, section or feed (scheme defaults to `https://`); `refresh=1` bypasses the cache if it is older than 15 min; `limit` default/max 100. Without `url`: `{"service":"collector","version":…,"sync":bool}`. `/api/?url=` is an alias.

Resolution order (`strategy`):

0. `rule` – platform rule maps known page URLs to the native feed without fetching the page (see *Platform rules*). Platforms without feeds (X, Meta, LinkedIn, TikTok, Spotify) → `PLATFORM_NO_FEED`.
1. `direct` – URL is RSS 2.0, RSS 1.0 (RDF) or Atom.
2. `discovered` – `<link rel="alternate">` or visible `…/rss.xml` links.
3. `guessed` – common paths (`/feed`, `/rss.xml`, `/feed.xml`, `/atom.xml`, `/index.xml`, …).
4. `sitemap` – `robots.txt` → `sitemap.xml` → `sitemap_index.xml`, filtered to the path; accepted if ≥ 50 % of entries are dated; slug titles replaced by link titles from the page.
5. `html-jsonld` · `html-article` · `html-links` – extracted from the page; missing dates filled from the sitemap.

```json
{
  "source":  { "inputUrl", "url", "type": "rss|rdf|atom|html|sitemap", "strategy", "rule", "feedUrl", "title", "siteUrl", "icon" },
  "entries": [ { "id": "sha256", "url", "title", "publishedAt", "updatedAt", "summary", "image", "author" } ],
  "meta":    { "count", "fetchedAt", "cached", "stale", "cachedAt", "nextRefreshAfter", "version" }
}
```

- `id` = sha256 of the GUID, else of the normalized URL. Feeds/sitemaps newest first; HTML keeps page order.
- `summary`: plain text, max. `NR_SUMMARY_LENGTH`; feed furniture is removed (*The post … appeared first on …*, *… Zum Beitrag: …*, *Continue reading*, `[…]`, a repeated title).
- `author`: Atom `<author><name>` (feed-level as fallback), `dc:creator` / `<author>` (e-mail form → name), JSON-LD `author`; `null` if unknown.
- `source.siteUrl`: the feed's site link, or the page for HTML strategies. `source.icon`: `<link rel="icon">` of a fetched page (apple-touch-icon as fallback), else Atom `<icon>` / RSS `<image>`; `null` if unknown.
- Header `X-Collector-Cache: HIT | MISS | STALE`.
- Errors: 4xx + `{"error":{"code","message"}}` – `INVALID_URL`, `UNSUPPORTED_URL`, `FORBIDDEN_HOST`, `DNS_FAILED`, `UPSTREAM_FETCH_FAILED`, `UPSTREAM_HTTP_ERROR`, `UPSTREAM_TOO_LARGE`, `TOO_MANY_REDIRECTS`, `NO_FEED_DETECTED`, `PLATFORM_NO_FEED`; `503 BUSY` (+ `Retry-After`) when another request fetches the same URL for longer than `NR_LOCK_WAIT`.
- Cached errors: `NO_FEED_DETECTED` / `PLATFORM_NO_FEED` for `NR_ERROR_TTL`, temporary upstream failures (`UPSTREAM_FETCH_FAILED`, HTTP 5xx/429) for `NR_TRANSIENT_ERROR_TTL`.

### Platform rules

`src/feed-rules.php`: curated snapshot (2026-09-25) of URL → native feed mappings for ~40 platforms (Medium, Substack, YouTube, Reddit, Mastodon, Bluesky, GitHub, arXiv, …). Native feeds only, no bridges; cross-checked against [get-rss-feed-url-extension](https://github.com/shevabam/get-rss-feed-url-extension) (MIT) and [RSSHub Radar](https://github.com/DIYgod/RSSHub-Radar) (AGPL-3.0, consulted only). Failed rules fall through to step 1.

- Own rules: `src/feed-rules.local.php` (same format, gitignored, checked first).
- After changes: `php tests/feed-rules-test.php` (runs each rule's `examples`).

## Articles (`/api/article`)

```
GET /api/article?url=<article>[&feed=<feed>&id=<entry id>]
```

1. `feed` + `id` and the cached feed carries full text (≥ `NR_FULLTEXT_MIN_CHARS`) → served from cache (`source: "feed"`, no upstream request). `/api/collect` strips full texts.
2. Otherwise the page is fetched and reduced to its main content (`src/readable.php`: JSON-LD/meta, Readability-style scoring, `articleBody` for script-rendered pages; description as last resort → `partial: true`).

Response `{ "article": { url, title, byline, siteName, lang, publishedAt, image, content, words, source, partial } }`. `content` is whitelisted HTML (text, headings, lists, quotes, code, tables, `a[href]`, `img[src|alt]`, absolute http(s) only); the app sanitizes again.

## Sync (`/api/sync`)

One encrypted blob per vault; the server has no schema and no merge logic.

```
vault key (32 random bytes, base64url; QR / app/#pair=<key>[&server=<url>])
  ├─ HKDF-SHA256 "newsreader-sync-v1 auth" → bearer token
  └─ HKDF-SHA256 "newsreader-sync-v1 enc"  → AES-256-GCM key (never leaves the device)
```

| Request | Semantics |
|---|---|
| `GET` | blob + `ETag`; `304` on `If-None-Match`; `404` if none |
| `PUT` | `If-Match: "<etag>"` (update) or `If-None-Match: *` (create); `412` conflict, `428` no precondition, `410 FORWARDED` if the location holds a forward |
| `DELETE` | remove vault (`204`); `410 FORWARDED` if the location holds a forward |

- Auth `Authorization: Bearer <token>`; file `var/sync/<2 hex>/<sha256(token)>.vault`; atomic writes under a global `flock`.
- Blob: `"NRS1"` · flags (bit 0 = gzip) · 12-byte IV · ciphertext (AAD `newsreader-sync-v1`). Plaintext `{v:1, at, records:[{kind,id,data,updatedAt}]}`; `feed` → `{url,title,since,d?,g?}` (`g` = folder), `item` → `{s,t,u,f,p}`, `device` → `{name,platform,since,seen,pub,r?}`. Forward after a key change: `"NRF1"` · flags · IV · ciphertext under the old key (AAD `newsreader-sync-v1 forward`), plaintext `{v:1, at, envelopes:[{id,epk,iv,ct}]}`.
- Client: GET → decrypt → merge (last write wins per record) → PUT full snapshot if newer; retry on `412` (max. 5). Deterministic pruning after 180 days.
- Server sees: token hash, blob size, timestamps, client IP (web server log).
- A pairing link is the key: joining a foreign link merges your data into that vault (and may switch the server). Only confirm links you created yourself.
- Paired devices (*Settings → Paired devices*): every device keeps one encrypted `device` record (random id, editable name, platform, paired since, last active – refreshed at most hourly) with its ECDH P-256 public key; the private key is non-extractable and never leaves the device.
- Removing a device (or *Change key*) rotates the vault key: full snapshot to the new location, then the old location is replaced (`If-Match`) by an `NRF1` forward holding the new key wrapped for every remaining device (ephemeral ECDH → HKDF-SHA256 → AES-GCM, device id bound in info and AAD). Remaining devices follow automatically; the removed device and stale pairing links find no envelope and unpair. The removed device keeps what it already downloaded. A forward is final: the server refuses to replace or delete it (`410`), so a removed device that still knows the old key cannot plant its own forward or push offline devices back to the old location. Forwards expire with the old vault (180 days after the last read).
- *Unpair this device* announces itself (`r:1`) before leaving.

## Configuration (`src/config.php`)

| Setting | Default |
|---|---|
| `NR_CACHE_TTL` / `NR_STALE_TTL` (served while source is down) / `NR_ERROR_TTL` | 24 h / 7 d / 1 h |
| `NR_TRANSIENT_ERROR_TTL` (timeouts, upstream 5xx/429) / `NR_LOCK_WAIT` | 2 min / 20 s |
| `NR_REFRESH_MIN_AGE` (`refresh=1`) | 15 min |
| `NR_ARTICLE_TTL` / `NR_ARTICLE_ERROR_TTL` | 7 d / 1 h |
| `NR_RATE_COLLECT_MISS` / `NR_RATE_ARTICLE_MISS` (upstream fetches; cache hits free) | 60 / 30 per 10 min |
| `NR_RATE_SYNC` / `NR_RATE_SYNC_CREATE` | 300 per 10 min / 5 per day |
| `NR_SYNC_MAX_BYTES` / `NR_SYNC_EXPIRE_DAYS` / `NR_SYNC_MAX_VAULTS` | 1 MB / 180 / 10 000 |
| `NR_SYNC_ENABLED` / `NR_SYNC_ALLOWED_NETS` | `true` / `[]` (everyone) |
| Fetch limits: connect / request / redirects / body (also decompressed) / child sitemaps | 5 s / 15 s / 5 / 5 MB / 3 |
| `NR_TIME_BUDGET` (wall clock for all upstream requests of one API call) | 60 s |
| `NR_MAX_PARSE_ITEMS` (feed items / listing elements inspected) | 1000 |
| `NR_ALLOWED_PORTS` (upstream) | 80, 443, 8080, 8443 |
| `NR_CACHE_GC_AGE` (cache files deleted after) | 14 d |

Cleanup needs no cron: every request checks the time of the last run (`var/{cache,sync,rate}/.gc`); once an hour, one request per directory deletes expired files after its response was sent. Expired vaults never count against `NR_SYNC_MAX_VAULTS`.

Rate limits: fixed windows per salted IP hash (`var/rate/`, IPv6 grouped per `/64`), `429` + `Retry-After`; a rate-limited Collector request gets the stale copy if one exists. A per-URL `flock` lets one request refresh a source; concurrent requests get the stale copy or wait at most `NR_LOCK_WAIT` (then `503 BUSY`). An article fetch that fails keeps and serves an existing copy.

## Security

- Only `http(s)` without credentials, only `NR_ALLOWED_PORTS`; every redirect hop re-validated.
- SSRF: loopback, private, link-local, CGNAT, benchmark, multicast, reserved, ULA and embedded IPv4 (mapped, compatible, NAT64, 6to4) rejected (`NR_ALLOW_PRIVATE_HOSTS = false`). Connections are pinned to the validated IPs (curl `CURLOPT_RESOLVE`, stream fallback via IP + `Host`/SNI) – no DNS rebinding; environment proxies are ignored.
- Upstream: body and gzip output capped, wall-clock budget per API call, parse work capped.
- XML: `LIBXML_NONET`, no `LIBXML_NOENT` / `LIBXML_PARSEHUGE` (entity-expansion protection stays on).
- Entries: only `http(s)` links and images leave the Collector; the app re-checks every URL before `href`, `src` or `window.open` and sanitizes article HTML again.
- App: Content Security Policy (`app/index.html`), `no-referrer`, external links `noopener noreferrer`. API: `Content-Security-Policy: default-src 'none'`, `nosniff`, no cookies (CORS `*` is intentional).
- Files in `var/` are never served (nginx `location` rules); the cache is garbage-collected.

## i18n

`en`, `de`, `fr`, `it`, `es` – loader `app/js/i18n.js`, shared by site and app.

- Files: `i18n/<lang>.json` (site), `app/i18n/<lang>.json` (app). Nested keys; `en.json` is complete and the source of all text; other languages fall back to English per key.
- `{name}` placeholders; plurals `key_one` / `key_other` via `Intl.PluralRules` when `n` is passed.
- Markup: `data-i18n="key"` (innerHTML), `data-i18n-attr="aria-label:key;title:key"`.
- Site: one static URL per language (`/` = `en`, `x-default`), no redirects – except `thanks.html` (Stripe return URL): saved choice → browser language, in the page script and in nginx (`Accept-Language` map; `?lang=en` = explicit English). App (`/app/`, indexed, one URL for all languages): saved choice (`localStorage` `nr.lang`) → browser languages → English.
- Voice: app and site user sections are friendly and plain (informal *du/tu*; French *vous*), no jargon; *Collector*/*Self-host* sections and this README are technical.
- New language: copy both `en.json` files to `xx.json`, add `xx` to `LANGS` in `app/js/i18n.js` and `tools/build-i18n.php`, add an `<option>` to the site switcher, run the build.

## White-label

- Colours, fonts, `--radius` (default `0`): `app/theme.css` (site + app). Palette 3b.1: `#FFA500` · `#000000` · `#FFFFFF` · `#292929`.
- Theme: follows the OS; override via site toggle / *Settings → Appearance* (`html[data-theme]`, `localStorage` `nr.theme`).
- Name and icons: `app/manifest.webmanifest`, `app/index.html`, `app/icons/`, `brand/` (`news-mark[-dark].svg`, `news-icon[-dark].svg`; inline `.nr-mark` follows the theme).
- Favicons: `favicon.svg` follows the OS colour scheme; PNG fallbacks `favicon-32.png` (light) / `favicon-32-dark.png` (dark) via `media` (root and `app/icons/`).
- Fonts (self-hosted, `app/fonts/`): Newsreader (titles), Source Sans 3 (text).
- Operator-specific parts of news-reader.app – remove or replace them on your own instance: Pirsch Analytics (`<script id="pianjs">` in every HTML page, `https://api.pirsch.io` in the CSP of `app/index.html`), the Stripe *pay what you want* link (`buy.stripe.com`, site footer + `final.support`), `privacy.html` / `imprint.html` / `thanks.html` (legal texts of kreativ-anders; `privacy.*`, `imprint.*`, `thanks.*` in `i18n/*.json`).

## Tests & CI

`.github/workflows/ci.yml` runs on every push and pull request – fully offline: `tests/fixtures/` plays "the internet" (feeds, sitemaps, article pages, redirects, errors); the API runs in a throw-away copy of the repo (`tests/support/servers.mjs`), so the working tree, `var/` and real vaults are never touched.

| Suite | Command | Covers |
|---|---|---|
| PHP unit | `php tests/php/run.php` | parsers, SSRF checks, URL helpers, sanitizer, article extraction, sync helpers (no Composer) |
| Platform rules | `php tests/feed-rules-test.php` | every rule's `examples` + URLs that must stay untouched |
| API | `npm run test:api` | `/api/collect` (all strategies, errors, cache), `/api/article`, `/api/sync` protocol, rate limits, SSRF with production config, blocked paths |
| JS | `npm run test:js` | syntax, `feedId()` stability (sync format), OPML, translations, service-worker shell, manifests |
| E2E | `npm run test:e2e` | Playwright/Chromium desktop + mobile: every view and language, item flow, keyboard, swipe, OPML, share target, two-device sync, offline reader, service worker, site pages and links – any JS exception or `console.error` fails |

CI runs on PHP 8.5, the minimum version (older versions get `SERVER_MISCONFIGURED` from the API), treats deprecations in the lint as errors, adds one run without ext-curl and fails if the site pages, `de/ fr/ it/ es/`, the canonicals of `app/` and `docs/api/` or `sitemap.xml` were not regenerated. Local: PHP 8.5+, Node 22+, `npm ci && npx playwright install chromium && npm test`. Known bugs are `todo` tests (reported, not failing).

## License

MIT – see `LICENSE`. `app/vendor/qrcode.js`: Kazuhiko Arase, MIT. Fonts: SIL OFL 1.1.
