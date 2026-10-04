# Behaviour spec (Gherkin)

What News Reader does, written as [Gherkin](https://cucumber.io/docs/gherkin/) scenarios and kept next to the code that does it. `tests/js/gherkin.test.mjs` runs in `npm test` and fails as soon as spec, code and tests drift apart. Its failure message names the broken link.

## Two kinds of features

- **Descriptive** (`gherkin/*.feature`) – behaviour of the app, the API and the site in plain words. The existing unit, API and E2E tests back them; each covering test names its features in a header line `// Gherkin: gherkin/<x>.feature` (comma-separated for several).
- **Executable** (`gherkin/executable/*.feature`, tag `@executable`) – run step by step by `tests/support/gherkin.mjs` (about 100 lines, no dependency) inside `node --test`. Each has one `*.bdd.test.mjs` whose `s.step(…)` definitions call the real code (JS modules directly, the PHP server over HTTP). Steps take `{string}`, `{int}`, `{word}` or a regex; every step needs exactly one definition, and every definition must be used. The runner supports Background, Rule, Scenario Outline + Examples, but no doc strings and no step tables. Write cases as Outline rows instead.

Put new pure rules (sync format, limits, validation) in an executable feature. That way the spec is the test.

## Headers

Every feature starts with:

```
# Source: <every file that implements it, comma-separated>
# Implementation: <the one file that mainly implements it – also listed in Source>
# Executable: <the *.bdd.test.mjs that runs it – executable features only>
```

Every module in `app/js/`, `app/sw.js`, `src/` and `api/index.php` must appear in some `# Source:`. New code therefore needs a home in the spec.

## Working with it

- **Change behaviour:** find the feature here, update its scenarios in the same change as the code, then the tests that name it (`grep -rn "Gherkin: gherkin/<x>.feature" tests`).
- **New behaviour:** write the scenario first, at the latest in the same change. Then add it to an existing feature or start a new one with headers, a row in the table below, and a test with the marker.
- **No test possible:** add the feature to `FEATURES_WITHOUT_TEST` in `tests/js/gherkin.test.mjs`. Only do this deliberately.

## Features

| Feature | Covers | Tests |
|---|---|---|
| `item_flow.feature` | First run, Read now / Later / Not interested, Done, undo, clear, swipe | E2E `flow`, `ux` |
| `reading_list.feature` | Day groups, paging, teasers, repeated images, card actions, compact layout | E2E `ui` |
| `sources.feature` | Sources sidebar and drawer, folders, filter, feed and folder context numbers | E2E `ui`, `stats` |
| `feeds.feature` | Follow by address, errors, device fallback, share target, OPML, rename/unfollow, retries | E2E `feeds`, `ux`; JS `feeds` |
| `refresh.feature` | Refresh on open, manual refresh and pause, sync timers | E2E `feeds` |
| `offline.feature` | Service worker, offline changes, saved copies and reader, new version | E2E `offline`, `app`; JS `assets` |
| `sync.feature` | Pairing, sync key and link, merge, checks, size limit, local-only | E2E `sync`, `sync-hardening`; JS `sync` |
| `devices.feature` | Paired devices, removal with key change, unpair | E2E `devices`, `sync-hardening` |
| `retention.feature` | Initial window, unsorted posts, daily pruning | E2E `sync-hardening` |
| `keyboard_accessibility.feature` | Views, focus, shortcuts and switching them off, screen readers, labels | E2E `ux`, `ui`, `app` |
| `search.feature` | Search and go to | E2E `ui` |
| `app_badge.feature` | Inbox count on the app icon, permission hint, background check | E2E `badge` |
| `settings.feature` | Language, theme, server test, every view renders | E2E `app`; JS `i18n` |
| `privacy.feature` | Address bar cleanup, CSP, URL guard, logs without queries | E2E `ux`, `site`; JS `security` |
| `collector.feature` | `/api/collect` strategies, device fallback, entry shape | API `collector`; PHP `parsers`, `titles`, rules |
| `collector_cache.feature` | Shared cache per source, stale copies, errors, locks, ETag, budget | API `cache`, `revalidate`, `gc` |
| `articles.feature` | `/api/article` extraction, sanitising, errors | API `article`; PHP `readable` |
| `sync_server.feature` | Sync data storage, races, CORS, expiry, limits | API `sync`, `gc`; PHP `sync` |
| `server_protection.feature` | SSRF, bounds, fetch slots, rate limits, blocked paths, API headers | API `security`, `ratelimit`, `slots`, `nginx`; PHP `http`, `security` |
| `site.feature` | Language pages, thanks redirect, 404 page per language, theme, install, events, preview | E2E `site`; API `nginx`, `security`; JS `og-image`, `i18n` |
| `executable/feed_identity.feature` | `normalizeUrl`, `extractUrl`, pinned `feedId`, `cleanTitle` | **runs** `tests/js/feed-identity.bdd.test.mjs` |
| `executable/vault_records.feature` | `validRecord` – which records from other devices are taken | **runs** `tests/js/vault-records.bdd.test.mjs` |
| `executable/pruning.feature` | `prunable` periods, `slim` sync records | **runs** `tests/js/pruning.bdd.test.mjs` |
| `executable/safe_output.feature` | `esc`, `httpUrl`, `hostOf` | **runs** `tests/js/safe-output.bdd.test.mjs` |
| `executable/sync_protocol.feature` | `/api/sync` create/read/update/delete, auth, preconditions, forwards | **runs** `tests/api/sync-protocol.bdd.test.mjs` |
