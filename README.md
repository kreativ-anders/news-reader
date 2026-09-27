# News Reader

Self-hosted, local-first RSS reader. **News** (`app/`) is the PWA for phone and desktop: every new post gets one decision – *read now*, *later* or *not interested*. The server is a small PHP front controller with three endpoints and no database. MIT, white-label.

```
app/            PWA – plain ES modules, IndexedDB, service worker (no build step)
api/index.php   front controller → /api/collect · /api/article · /api/sync
src/            resolver, parsers, http (SSRF-safe fetch), cache, readable, sync, ratelimit, gc, rules
var/            cache/ · sync/ · rate/ – written by PHP, never served
index.html …    project site (+ generated de/ fr/ it/ es/), docs/api/, i18n/
```

| Endpoint | Purpose |
|---|---|
| `/api/collect` | **Collector** – any website or feed URL → normalized JSON entries |
| `/api/article` | Readable offline copies for the *Later* list |
| `/api/sync` | End-to-end encrypted sync – no accounts, one encrypted blob per group of devices |

## Quick start

1. Clone the repository into the web root; make `var/` (`cache/`, `sync/`, `rate/`) writable by PHP.
2. nginx: copy `nginx.conf.example` (production) or `wharf.conf.example` (local) and adjust domain and paths.
3. Enable HTTPS – needed for install, service worker, share target and WebCrypto (except on `localhost`).
4. Open `/app/` → *Settings → Advanced: server → Test*. The app uses the origin it is served from by default.

## Requirements

- PHP 8.5+ with `dom`, `libxml`, `mbstring`; `curl` recommended (fallback: stream wrapper with `openssl` + `allow_url_fopen`). Older PHP versions get `500 SERVER_MISCONFIGURED`.
- nginx (both example configs block `/src`, `/var`, `/tests`, `/tools`, dotfiles, config/doc files and `*.vault`). **Other web servers:** replicate these deny rules – `var/` must never be served.
- Behind a reverse proxy: configure nginx `real_ip`, otherwise rate limits see the proxy.
- TLS trust: `NR_CA_BUNDLE` if set; otherwise the Windows certificate store (unless `curl.cainfo` is set) or PHP's defaults.

## Configuration (`src/config.php`)

| Setting | Default |
|---|---|
| `NR_CACHE_TTL` / `NR_STALE_TTL` (served while the source is down) / `NR_ERROR_TTL` | 24 h / 7 d / 1 h |
| `NR_TRANSIENT_ERROR_TTL` (fetch failures, upstream 5xx/429) / `NR_LOCK_WAIT` | 2 min / 20 s |
| `NR_REFRESH_MIN_AGE` (`refresh=1`) | 15 min |
| `NR_CACHE_GC_AGE` / `NR_CACHE_MAX_BYTES` / `NR_CACHE_MIN_FREE` (below: nothing is cached) | 14 d / 1 GB / 256 MB |
| `NR_MAX_ENTRIES` / `NR_SUMMARY_LENGTH` / `NR_MAX_PARSE_ITEMS` | 100 / 300 chars / 1000 |
| `NR_FULLTEXT_MIN_CHARS` / `NR_FULLTEXT_MAX_BYTES` (per entry) / `NR_FULLTEXT_BUDGET` (per feed) | 1200 / 100 KB / 1 MB |
| `NR_ARTICLE_TTL` / `NR_ARTICLE_ERROR_TTL` / `NR_ARTICLE_MAX_BYTES` | 7 d / 1 h / 400 KB |
| `NR_CONNECT_TIMEOUT` / `NR_REQUEST_TIMEOUT` / `NR_MAX_REDIRECTS` / `NR_MAX_BODY_BYTES` (also decompressed) / `NR_MAX_CHILD_SITEMAPS` | 5 s / 15 s / 5 / 5 MB / 3 |
| `NR_LOW_SPEED_LIMIT` / `NR_LOW_SPEED_TIME` (slow sources are aborted) | 1 KB/s / 10 s |
| `NR_TIME_BUDGET` (wall clock for all upstream requests of one API call) | 60 s |
| `NR_UPSTREAM_SLOTS` (all clients) / `NR_UPSTREAM_PER_CLIENT` – upstream fetches at once, more → `503 BUSY` | 8 / 2 |
| `NR_RATE_COLLECT_MISS` / `NR_RATE_ARTICLE_MISS` (upstream fetches; cache hits are free) | 60 / 30 per 10 min |
| `NR_RATE_*_48` (IPv6 only, per /48) | collect 240 · article 120 per 10 min · sync create 20 per day |
| `NR_RATE_SYNC` / `NR_RATE_SYNC_CREATE` / `NR_RATE_SYNC_CREATE_ALL` (all clients) | 300 per 10 min / 5 per day / 500 per day |
| `NR_SYNC_MAX_BYTES` / `NR_SYNC_EXPIRE_DAYS` / `NR_SYNC_MAX_VAULTS` | 1 MB / 180 / 10 000 |
| `NR_SYNC_ENABLED` / `NR_SYNC_ALLOWED_NETS` | `true` / `[]` (everyone) |
| `NR_ALLOWED_PORTS` (upstream) | 80, 443, 8080, 8443 |
| `NR_ALLOW_PRIVATE_HOSTS` (also lifts the port check – local testing only) | `false` |
| `NR_CA_BUNDLE` / `NR_USER_AGENT` | `''` / `NewsReader-Collector/<version> (+https://news-reader.app)` |

Cleanup needs no cron: every request checks the time of the last run (`var/{cache,sync,rate}/.gc`); once an hour, one request per directory deletes expired files after its response was sent – for the cache also the oldest files beyond `NR_CACHE_MAX_BYTES`. Expired vaults never count against `NR_SYNC_MAX_VAULTS`.

## Deploy and update

The generated language pages are committed. Re-run the build only after changing `index.html`, `privacy.html`, `imprint.html`, `thanks.html` or `i18n/*.json`, or to build for your own domain:

```
php tools/build-i18n.php --site=https://news-reader.app/
```

It writes the English text from `i18n/en.json` into the site pages, generates `<lang>/<page>`, refreshes `hreflang`, canonical, FAQ structured data and `sitemap.xml` (index/privacy/imprint per language + `app/` + `docs/api/`; `thanks.html` is `noindex`). Links starting with `./` stay in the page's language, other relative links point to the root. CLI only. Never edit `de/ fr/ it/ es/` by hand.

- After changing an inline `<script>` of a site page: recompute the CSP hashes in `nginx.conf.example` / `wharf.conf.example` (command in the config comment). After changing the inline script of `app/index.html`: update the hash in its `<meta>` CSP.
- After changing app files: bump `VERSION` in `app/js/app.js` **and** `app/sw.js` (the service worker caches the shell).
- After changing the cache entry format: bump `NR_CACHE_SCHEMA`.

## App (`app/`)

Item flow: *Inbox* → *Read now* (opens the original in a new tab and files it under *Done*, undo toast) · *Later* · *Not interested*. *Read again* in *Done* → *Read now*. *Later* → *Mark all done* (respects the feed filter). *Done* links to the *Not interested* list, where a post can go back to the inbox. *Clear list* in *Done* hides posts (`h:1`) but keeps them *done*, so the feed's read rate stays correct.

**First run** – the empty inbox explains the three decisions, links to *Add your first feed* (focuses the address field), OPML import and pairing. On touch screens a one-time toast explains swiping (`localStorage` `news.tip.swipe`).

**List**
- Posts grouped by day, newest first (sticky header with count; *Inbox* by publication date, the other views by last change); 150 per page with *Show more*.
- Card actions appear on hover, focus and keyboard selection; always visible on touch, in forced colours / *more contrast* and with *Settings → Card actions → Always* (`news.acts`). The main action keeps its label.
- Teasers are clamped to two lines; a chevron (and a click on the teaser) expands them when text is cut off.
- Images a feed repeats on several posts (logos, placeholders) are hidden. Saved offline copies show the reading time.
- *Layout*: comfortable or compact (headlines only), per device (`news.density`, key `v`).

**Accessibility**
- DOM order title → meta → teaser → actions; the card is named by its title and described by its meta line; actions carry `aria-keyshortcuts`.
- `j`/`k` move the real focus; after an action focus goes to the card that takes the place. Redraws keep the focused control (or fall back to the view heading); background redraws never touch Feeds/Settings while you type.
- View changes focus the view heading, set the page title and add a history entry (Back works).
- Single-key shortcuts can be switched off (*Settings → Keyboard shortcuts*, `news.keys`); `Ctrl/⌘ K` always works.
- The undo toast stays 10 s, pauses on hover/focus; `u` undoes until the next action.
- The offline reader makes the page behind it `inert`.

**Sources** (sidebar, desktop)
- Folders and feeds of the current view with counts; feeds with nothing in the view fold behind *+ n more*; hidden with a single feed. Filter = one feed or one folder (narrow screens: a select with option groups).
- Favicon: Collector `source.icon`, else `/favicon.ico` of `source.siteUrl`, else a monogram. Feed titles drop platform wording (*Stories by X on Medium* → *X*). Names are sorted with the app language's collation.
- Folders: *Feeds* → folder button (free text, existing folders suggested); synced as `g` in the feed record; OPML import reads the enclosing outline, export nests by folder.
- Feed context (filtered to one feed, also in *Feeds*): posts per week (last 28 days) and read rate (*later/read now/done* vs. *not interested*, from 5 decisions on), folder / rename / unfollow.

**Feeds**
- Adding: address field (`https://` optional), Web Share Target (installed app on Android), bookmarklet (`?add=<url>`), OPML import/export. A page and its feed resolve to the same feed – following both is refused.
- OPML import adds feeds even when the server is busy or unreachable; the next refresh fills them.
- The Collector strategy is shown in plain words (*feed*, *sitemap*, *from the page*); the technical name is in the tooltip. Server errors are shown as friendly text in the app language (raw message in the tooltip).

**Refresh and sync timers** – feeds refresh automatically every 30 min while visible, skipping feeds whose server copy cannot have changed yet (`meta.nextRefreshAfter`); *Refresh* / `r` forces all and reports the number of new posts. Sync runs every 5 min while visible and 20 s after a local change (immediately when the tab is hidden or closed).

**Search and go to** (`/`, Ctrl/Cmd+K, search button): views, folders and feeds; with a query also every known post – title matches first, then newest. Picking a post jumps to its view and selects it.

**Storage**
- IndexedDB `news`: `records` (feeds, items, devices – synced), `outbox` (unsynced changes; none without a vault), `entries` (per device), `articles` (offline copies), `kv` (`vaultKey`, `deviceId`, `deviceKey`, `server`, `etag`, `lastSync`, `lastRefresh`, `swipe`, `fetchState`, `pubPins`, `revoked`, `lastMaintain`).
- `localStorage`: `nr.lang`, `nr.theme` (shared with the site), `news.density`, `news.acts`, `news.keys`, `news.feedNav`, `news.folders.closed`, `news.tip.swipe`.

**Retention**
- A new subscription shows the last 14 days, at least the 3 newest posts. For feeds followed longer than 30 days the inbox starts at most 30 days back.
- Entries you never sorted are removed once they left the feed and are older than 30 days.
- Offline copies of done/dismissed items are dropped after 1 day.
- Pruning (once a day, also without sync): dismissed and untouched items after 30 days; done items, unfollowed feeds and device records after 180 days; *Later* and *Read now* never.

**Offline** – the service worker caches the app shell; changes are queued until the server is reachable. Posts moved to *Later* are saved once via `/api/article`; offline they open in a full-screen reader (scrolled to the end → *Done*).

**Input** – swipe (default right = *Later*, left = *Not interested*; configurable), keys `j`/`k`, `↓`/`↑` (once a card is selected), `o`/`Enter`, `l`, `x`, `d`, `u`, `r`, `1`–`5`, `/`, Ctrl/⌘ K, `v`, `Esc`, `?` (overview).

## Collector (`/api/collect`)

```
GET /api/collect?url=<url>[&refresh=1][&limit=1..100]
```

`url` – page, section or feed (scheme defaults to `https://`); `refresh=1` bypasses the cache if it is older than 15 min; `limit` default/max 100. Without `url`: HTTP 400 with `{"name","service":"collector","version","sync":bool,"usage","example"}` (used by *Settings → Test*). `/api/?url=` is an alias.

Resolution order (`strategy`):

0. `rule` – platform rule maps known page URLs to the native feed without fetching the page (see *Platform rules*). Platforms without feeds (X, Meta, LinkedIn, TikTok, Spotify) → `PLATFORM_NO_FEED`.
1. `direct` – URL is RSS 2.0, RSS 1.0 (RDF) or Atom.
2. `discovered` – `<link rel="alternate">` or visible `…/rss.xml` links.
3. `guessed` – common paths (`/feed`, `/rss.xml`, `/feed.xml`, `/atom.xml`, `/index.xml`, …; at most 12 probes).
4. `sitemap` – `robots.txt` → `sitemap.xml` → `sitemap_index.xml` (at most 4 candidates, 3 child sitemaps), filtered to the path; accepted with ≥ 3 entries of which ≥ 50 % are dated; slug titles replaced by link titles from the page.
5. `html-jsonld` · `html-article` · `html-links` – extracted from the page (≥ 3 hits); missing dates filled from the sitemap.

```json
{
  "source":  { "inputUrl", "url", "type": "rss|rdf|atom|html|sitemap", "strategy", "rule", "feedUrl", "title", "siteUrl", "icon" },
  "entries": [ { "id": "sha256", "url", "title", "publishedAt", "updatedAt", "summary", "image", "author" } ],
  "meta":    { "count", "fetchedAt", "cached", "stale", "cachedAt", "nextRefreshAfter", "version", "lastError?" }
}
```

- `id` = sha256 of the GUID, else of the normalized URL. Feeds/sitemaps newest first; HTML keeps page order. `feedUrl` is the feed or sitemap used (`null` for HTML strategies).
- `summary`: plain text, max. `NR_SUMMARY_LENGTH`; feed furniture is removed (*The post … appeared first on …*, *Continue reading*, `[…]`, a repeated title). Titles are capped at 500 characters.
- `author`: Atom `<author><name>` (feed-level as fallback), `dc:creator` / `<author>` (e-mail form → name), JSON-LD `author`; `null` if unknown.
- `source.siteUrl`: the feed's site link, or the page for HTML strategies. `source.icon`: `<link rel="icon">` of a fetched page (apple-touch-icon as fallback), else Atom `<icon>` / RSS `<image>`; `null` if unknown.
- `meta.lastError`: set when a refresh failed and the stale copy is served.
- Headers: `X-Collector-Cache: HIT | MISS | STALE | REVALIDATED` (the source answered `304` to a conditional refresh), weak `ETag` on cached answers – `If-None-Match` → `304`.

| Status | Codes |
|---|---|
| 400 | `INVALID_URL`, `UNSUPPORTED_URL`, `FORBIDDEN_HOST`, `DNS_FAILED` |
| 422 | `NO_FEED_DETECTED`, `PLATFORM_NO_FEED` (+ `rule`), `UPSTREAM_FETCH_FAILED`, `UPSTREAM_HTTP_ERROR` (+ `upstreamStatus`), `UPSTREAM_TOO_LARGE`, `TOO_MANY_REDIRECTS` – body may carry `tried[]` |
| 429 | `RATE_LIMITED` + `Retry-After` (a stale copy is served instead if one exists) |
| 503 | `BUSY` + `Retry-After` – another request fetches the same URL for longer than `NR_LOCK_WAIT`, or all upstream slots are taken |
| 404 / 405 / 500 | `NOT_FOUND` (unknown endpoint) / `METHOD_NOT_ALLOWED` / `SERVER_MISCONFIGURED` |

Errors are JSON `{"error":{"code","message",…}}`. Cached errors: `NO_FEED_DETECTED` / `PLATFORM_NO_FEED` for `NR_ERROR_TTL`, temporary upstream failures for `NR_TRANSIENT_ERROR_TTL`.

### Platform rules

`src/feed-rules.php`: curated snapshot (2026-09-25) of 65 URL → native feed rules for ~30 platforms (Medium, Substack, YouTube, Reddit, Mastodon, Bluesky, GitHub, arXiv, …) plus 5 platforms without feeds. Native feeds only, no bridges; cross-checked against [get-rss-feed-url-extension](https://github.com/shevabam/get-rss-feed-url-extension) (MIT) and [RSSHub Radar](https://github.com/DIYgod/RSSHub-Radar) (AGPL-3.0, consulted only). Failed rules fall through to step 1.

- Own rules: `src/feed-rules.local.php` (same format, gitignored, checked first).
- After changes: `php tests/feed-rules-test.php` (runs each rule's `examples`).

## Articles (`/api/article`)

```
GET /api/article?url=<article>[&feed=<feed>&id=<entry id>]
```

1. `feed` given and the cached feed carries full text (≥ `NR_FULLTEXT_MIN_CHARS`) for `id` or the same URL → served from cache (`source: "feed"`, no upstream request). `/api/collect` strips full texts.
2. Otherwise the page is fetched and reduced to its main content (`src/readable.php`: JSON-LD/meta, Readability-style scoring, `articleBody` for script-rendered pages; description as last resort).

Response `{ "article": { url, title, byline, siteName, lang, publishedAt, image, content, words, source, partial }, "meta": { cached, cachedAt, version } }`. `partial: true` when less than 400 characters of text were found. `content` is whitelisted HTML (text, headings, lists, quotes, code, tables, `a[href]` with http/https/mailto, `img[src|alt]` absolute http(s)); the app sanitizes again. The URL needs a scheme.

Headers `X-Article-Source: feed|page`, `X-Collector-Cache`, weak `ETag` (`304` on `If-None-Match`). Errors as for the Collector, plus `422 NOT_AN_ARTICLE` / `NO_CONTENT`. A failed fetch keeps and serves an existing copy; while another request fetches the same page, the stale copy is served at once. Failures are cached for `NR_ARTICLE_ERROR_TTL` (transient ones for `NR_TRANSIENT_ERROR_TTL`).

## Sync (`/api/sync`)

One encrypted blob per vault (one group of paired devices); the server has no schema and no merge logic.

```
vault key (32 random bytes, base64url; QR / app/#pair=<key>[&server=<url>])
  ├─ HKDF-SHA256 "newsreader-sync-v1 auth" → bearer token
  └─ HKDF-SHA256 "newsreader-sync-v1 enc"  → AES-256-GCM key (never leaves the device)
```

| Request | Semantics |
|---|---|
| `GET` | blob + `ETag`; `304` on `If-None-Match`; `404 NOT_FOUND` if none. Refreshes the expiry at most once a day |
| `PUT` | `If-Match: "<etag>"` (update → `200`) or `If-None-Match: *` (create → `201`), answer `{ok,etag,bytes}`; `412 CONFLICT`, `428 PRECONDITION_REQUIRED`, `410 FORWARDED` if the location holds a forward |
| `DELETE` | remove vault (`204`), optional `If-Match` (`412`); `404` if none; `410 FORWARDED` for a forward |

Other answers: `401 UNAUTHORIZED` (token must be 43 chars base64url), `400 INVALID_BODY` (magic `NRS1`/`NRF1`, ≥ 33 bytes), `413 PAYLOAD_TOO_LARGE`, `429 RATE_LIMITED`, `403 FORBIDDEN_NETWORK` (`NR_SYNC_ALLOWED_NETS`), `404 SYNC_DISABLED`, `507 SERVER_FULL`, `500 SYNC_WRITE_FAILED` / `SERVER_MISCONFIGURED`.

- Auth `Authorization: Bearer <token>`; file `var/sync/<2 hex>/<sha256(token)>.vault`; atomic writes under a per-vault stripe lock (global lock only when a vault is created).
- Blob: `"NRS1"` · flags (bit 0 = gzip) · 12-byte IV · ciphertext (AAD `newsreader-sync-v1`). Plaintext `{v:1, at, records:[{kind,id,data,updatedAt}]}`:
  - `feed` → `{url,title,since,added,d?,g?}` (`d:1` = unfollowed, `g` = folder)
  - `item` → `{s,t,u,f,p,i?,h?}` (state, title, url, feed, published, image, `h:1` = cleared from *Done*); in the vault dismissed items carry only `{s,f,t,u}`, untouched ones only `{s}`
  - `device` → `{name,platform,since,seen,pub,r?}`
- Forward after a key change: `"NRF1"` · flags · IV · ciphertext under the old key (AAD `newsreader-sync-v1 forward`), plaintext `{v:1, at, envelopes:[{id,epk,iv,ct}]}`.
- Client: GET → decrypt (decompression capped at 32 MB) → validate every record (shape per kind, `updatedAt` at most 1 day in the future – invalid records are dropped) → merge (last write wins per record) → PUT full snapshot if newer; retry on `412` (max. 5). On `413` the oldest finished items are pruned and the upload is retried once.
- Server receives: the bearer token (stored only as its SHA-256 file name), the encrypted blob and its size, timestamps; the client IP in the web-server log and as a salted hash for rate limiting.
- A pairing link is the key: joining a foreign link merges your data into that vault (and may switch the server). Only confirm links you created yourself. The app moves `#pair=…` out of the address bar before anything else runs.
- Paired devices (*Settings → Paired devices*): every device keeps one encrypted `device` record (random id, editable name, platform, paired since, last active – refreshed at most hourly) with its ECDH P-256 public key; the private key is non-extractable. Public keys are pinned on first sight (`pubPins`); a device whose key changes is flagged and gets no new key.
- Removing a device (or *Change key*) rotates the vault key: full snapshot to the new location, then the old location is replaced (`If-Match`) by an `NRF1` forward holding the new key wrapped for every remaining device (ephemeral ECDH → HKDF-SHA256 → AES-GCM, device id bound in info and AAD). Removed devices (`revoked`) and their public keys are excluded, whatever a merge says. Remaining devices follow automatically; the removed device and stale pairing links find no envelope and unpair. A forward is final: the server refuses to replace or delete it (`410`). Forwards expire with the old vault (180 days after the last read).
- *Unpair this device* announces itself (`r:1`) before leaving.

## Security

- Only `http(s)` without credentials, only `NR_ALLOWED_PORTS`; every redirect hop re-validated (`Location` is used as sent).
- SSRF: loopback, private, link-local, site-local, CGNAT, benchmark, multicast, reserved, ULA, documentation (`3fff::/20`), SRv6 (`5f00::/16`) and embedded IPv4 (mapped, SIIT, compatible, NAT64 incl. `64:ff9b:1::/48`, 6to4) rejected (`NR_ALLOW_PRIVATE_HOSTS = false`). Connections are pinned to the validated IPs (curl `CURLOPT_RESOLVE`, stream fallback via IP + `Host`/SNI) – no DNS rebinding; environment proxies are ignored.
- Upstream: body and gzip output capped, slow transfers aborted, wall-clock budget per API call, global and per-client fetch slots, parse work capped; HTML is parsed without `LIBXML_PARSEHUGE` (depth limit ~256).
- Disk: cache size budget and a free-space floor; per-feed full-text budget.
- XML: `LIBXML_NONET`, no `LIBXML_NOENT` / `LIBXML_PARSEHUGE` (entity-expansion protection stays on).
- Rate limits: fixed windows per salted IP hash (`var/rate/`, IPv6 per /64 and additionally per /48), `429` + `Retry-After`.
- Entries: only `http(s)` links and images leave the Collector; the app re-checks every URL before `href`, `src` or `window.open` and sanitizes article HTML again.
- App: no third-party scripts (no analytics), Content Security Policy (`app/index.html`), `no-referrer`, external links `noopener noreferrer`. Site pages: CSP header from the nginx config (hashed inline scripts). API: `Content-Security-Policy: default-src 'none'`, `nosniff`, no cookies (CORS `*` is intentional).
- Logs: the example configs log `/api/` requests without the query string – feed and article URLs are never stored next to an IP.
- Files in `var/` are never served (nginx `location` rules).

## Site and i18n

`en`, `de`, `fr`, `it`, `es` – loader `app/js/i18n.js`, shared by site and app.

- Files: `i18n/<lang>.json` (site), `app/i18n/<lang>.json` (app). Nested keys; `en.json` is complete and the source of all text; other languages fall back to English per key.
- `{name}` placeholders (numbers are formatted for the language); plurals `key_one` / `key_other` via `Intl.PluralRules` when `n` is passed.
- Markup: `data-i18n="key"` (innerHTML), `data-i18n-attr="aria-label:key;title:key"`.
- Site: one static URL per language (`/` = `en`, `x-default`), no redirects – except `thanks.html` (Stripe return URL): saved choice → browser language, in the page script and in nginx (`Accept-Language` map; `?lang=en` = explicit English). *Open News* on a language page carries that language into the app. App (`/app/`, one URL for all languages): saved choice (`localStorage` `nr.lang`) → browser languages → English.
- The site header shows all section links (second, scrollable row on narrow screens); animations stop by themselves and can be paused (footer).
- Site events (`track.js`, one delegated listener; values are fixed and language-neutral, never visitor input): *Open app*, *Self-host*, *GitHub*, *Support*, *API docs* `{position, lang}` · *Install app* `{position, way}` (`prompt` = the browser’s own dialog, else the steps shown: `ios`, `mac`, `android`, `chrome`) · *FAQ* `{question}` · *Collector strategy* `{strategy}` · *Language* `{from, to}` · *Theme* `{mode}` · *Animations* `{state}` · *Not found* (404 page, via `<body data-track-view>`).
- Voice: app and site user sections are friendly and plain (informal *du/tu*; French *vous*), no jargon; *Collector*/*Self-host* sections and this README are technical.
- New language: copy both `en.json` files to `xx.json`; add `xx` to `LANGS` in `app/js/i18n.js`, `LANGS`/`LOCALES` in `tools/build-i18n.php`, the inline list in `thanks.html`, the language map in `nginx.conf.example` / `wharf.conf.example` and `LANGS` in `tests/e2e/site.spec.mjs`; add an `<option>` to the site switcher; run the build.

## White-label

- Colours, fonts, `--radius` (default `0`): `app/theme.css` (site + app). Palette 3b.1: `#FFA500` · `#000000` · `#FFFFFF` · `#292929`.
- Theme: follows the OS; override via site toggle / *Settings → Appearance* (`html[data-theme]`, `localStorage` `nr.theme`).
- Name and icons: `app/manifest.webmanifest`, `app/index.html`, `app/icons/`, `brand/` (`news-mark[-dark].svg`, `news-icon[-dark].svg`; inline `.nr-mark` follows the theme).
- Favicons: `favicon.svg` follows the OS colour scheme; PNG fallbacks `favicon-32.png` (light) / `favicon-32-dark.png` (dark) via `media` (root and `app/icons/`).
- Fonts (self-hosted, `app/fonts/`): Newsreader (titles), Source Sans 3 (text).
- Operator-specific parts of news-reader.app – remove or replace them on your own instance:
  - Pirsch Analytics – site pages only, the app loads no analytics: `<script id="pianjs" … data-disable-query data-strip-anchor data-disable-outbound-links>` in every site page, `https://api.pirsch.io` in the nginx CSP, and `track.js` (site events, see below). Keep those attributes if you keep Pirsch.
  - The Stripe *pay what you want* link (`buy.stripe.com`, site footer + `final.support`).
  - `privacy.html` / `imprint.html` / `thanks.html` (legal texts of kreativ-anders; `privacy.*`, `imprint.*`, `thanks.*` in `i18n/*.json`).
  - Domain references: `--site` of the build, `robots.txt` (sitemap URL), `llms.txt`, og:image / JSON-LD URLs in `index.html`, `NR_USER_AGENT`.

## Development and tests

`.github/workflows/ci.yml` runs on every push and pull request – fully offline: `tests/fixtures/` plays "the internet" (feeds, sitemaps, article pages, redirects, errors); the API runs in a throw-away copy of the repo (`tests/support/servers.mjs`), so the working tree, `var/` and real vaults are never touched.

| Suite | Command | Covers |
|---|---|---|
| PHP unit + rules | `npm run test:php` | parsers, SSRF checks, URL helpers, sanitizer, article extraction, sync helpers, DoS limits; every platform rule's `examples` |
| API | `npm run test:api` | `/api/collect` (all strategies, errors, cache, 304), `/api/article`, `/api/sync` protocol, rate limits, fetch slots, SSRF with production config, blocked paths |
| JS | `npm run test:js` | syntax, `feedId()` stability (sync format), OPML, translations, record validation, pruning, service-worker shell, manifests |
| E2E | `npm run test:e2e` | Playwright/Chromium desktop + mobile: every view and language, onboarding, item flow, keyboard, swipe, OPML, share target, two-device sync incl. hardening, offline reader, service worker, site pages – any JS exception or `console.error` fails |

CI runs on PHP 8.5 (the minimum), treats deprecations in the lint as errors, adds one run without ext-curl and fails if the site pages, `de/ fr/ it/ es/`, the canonicals of `app/` and `docs/api/` or `sitemap.xml` were not regenerated. Local: PHP 8.5+, Node 22+, `npm ci && npx playwright install chromium && npm test`. Known bugs are added as `{ todo: true }` tests (reported, not failing).

## Contributing

Keep the suites green, add a test for every fix, regenerate the language pages when site texts change, keep `README.md`, `docs/api/`, `llms.txt` and the site texts in line with the code. Conventions for code and texts: [`CLAUDE.md`](CLAUDE.md).

## License

MIT – see `LICENSE`. `app/vendor/qrcode.js`: Kazuhiko Arase, MIT. Fonts: SIL OFL 1.1.
