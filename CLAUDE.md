# CLAUDE.md – rules for working on News Reader

Local-first RSS reader: PWA in `app/`, PHP front controller `api/index.php` + `src/`, static site with generated language copies. `README.md` is the technical reference, `gherkin/` the behaviour spec (index: `gherkin/README.md`); read the relevant section and feature before changing behaviour.

## Principles

- **Local-first, private by default.** Reading data lives on the device; the server only fetches sources and stores sealed sync blobs. Never send feed contents, reading states, keys or shared URLs anywhere else. The app loads no analytics or other third-party scripts; the site counts visits and a few named events with Pirsch (`track.js`, fixed values only, no visitor input). Every new data flow or event must be reflected in `privacy.*` texts.
- **Small and dependency-free.** Plain ES modules, plain PHP 8.5, no build step, no framework, no runtime dependencies, no database. Tooling (`package.json`) is for tests only.
- **Simple rules, no algorithm.** Posts arrive newest first and move only by the user's decision. No ranking, no AI, no tracking of behaviour.
- **Stay backward compatible with data on devices.** Sync format `v:1`, record shapes, `feedId()` and IndexedDB stores are shared by devices running different versions. Extend with optional fields, never repurpose or remove them; old clients must still read new blobs.

## Code

- Match the surrounding style: terse functions, early returns, no classes where a function does. Comments only as `// INFO:`, `// WARNING:` or `// TODO:` and only for the *why*.
- Every value that reaches HTML goes through `esc()`; every URL through `httpUrl()`. Translation files are trusted first-party content (`data-i18n` sets innerHTML) – never put user or feed data into them.
- PHP: `declare(strict_types=1)`, all limits as `NR_*` constants in `src/config.php`, errors via `nr_error()` with an UPPER_SNAKE code. Anything that fetches, parses or writes must be bounded (size, time, count, disk) – assume hostile input.
- Upstream requests only through `src/http.php` (SSRF checks, IP pinning, caps). Never call curl/file_get_contents on user URLs directly.
- App rendering: `render()` builds the view from state `S`; derived lists go through `memoized()`. Background redraws use `renderSoft()` so input is never lost. Keep work per render linear in the number of entries.
- New server error codes need a friendly text (`ERRC` in `app/js/app.js` → `errc.*` keys).

## Behaviour spec (Gherkin)

- **Spec moves with the code, in the same change.** Any change to user-visible or API behaviour updates the matching `gherkin/*.feature`; code without its scenario is incomplete. New behaviour is a scenario first – never "later".
- **Find the slice:** feature → its `# Source:` files → its tests (`grep -rn "Gherkin: gherkin/<x>.feature" tests`). Edit only that set.
- **Pure rules go executable:** new logic without UI (sync format, validation, limits, URL handling) gets scenarios in `gherkin/executable/*.feature` and thin `s.step(…)` definitions in its `*.bdd.test.mjs` – the spec is the test. Do not add a Gherkin package; the runner is `tests/support/gherkin.mjs`.
- `tests/js/gherkin.test.mjs` fails when spec, code and tests drift apart and names the broken link – read its message before hunting. Rules for headers and markers: `gherkin/README.md`.

## UX and accessibility

- Voice: plain and friendly, informal *du/tu* (French *vous*); no jargon in the app or on the site's user sections. Technical terms belong in README, API docs and the Collector/Self-host sections.
- Terminology is fixed across app, site and docs: *Inbox, Read now, Later, Not interested, Done, Feeds, Sources, Folder, Sync, Pair*. Say "sync data" to users, not "vault".
- WCAG 2.2 AA is the floor: real focus management after every redraw and view change, visible focus in forced colours, labelled controls, errors tied to their field (`aria-invalid`), no hover-only or swipe-only functions, reduced motion respected, single-key shortcuts switchable.
- Order matters: DOM order = reading order; lists newest first; settings from most to least relevant; nav, keys `1`–`5` and view order stay aligned.

## Texts and languages

- `en.json` is the source for every string (`i18n/` site, `app/i18n/` app); add every key to all five languages (`en de fr it es`) in the same change, with `_one`/`_other` for counts. No hard-coded user-visible text in JS or HTML.
- Never edit `de/ fr/ it/ es/` or `sitemap.xml` by hand – run `php tools/build-i18n.php --site=https://news-reader.app/`.

## Keep in sync when you change …

| Change | Also update |
|---|---|
| any behaviour (app, API, site) | its scenarios in `gherkin/*.feature`; the covering test carries `// Gherkin: <feature>` |
| a new module in `app/js/`, `src/` or a moved/renamed file | `# Source:` / `# Implementation:` headers of the features that name it |
| a new feature file | its row in `gherkin/README.md`, a test with the marker |
| any app file | `VERSION` in `app/js/app.js` **and** `app/sw.js` |
| inline `<script>` in `app/index.html` | its sha256 in the `<meta>` CSP |
| inline `<script>` of a site page | CSP hashes in `nginx.conf.example` and `wharf.conf.example` |
| cache entry format | `NR_CACHE_SCHEMA` |
| API behaviour, limits, codes, headers | `README.md`, `docs/api/index.html`, `llms.txt` |
| what is stored or sent | `privacy.*` in `i18n/*.json` (all languages), README *Storage* |
| user-facing features | site texts / FAQ (plain words), app help texts, `gherkin/*.feature` |
| a top-level folder that must not be public | deny rule in all `*.conf.example` and `tests/support/router.php` |

## Before you finish

- `npm test` (PHP, JS, API, E2E) must be green; add a test for every fix or new behaviour (`tests/php`, `tests/api`, `tests/js`, `tests/e2e`), linked to its feature with `// Gherkin:`. Tests run offline against `tests/fixtures/`.
- Several agents may work in parallel: follow `.agents/COORDINATION.md` (LOCK before editing, log when done). Never commit, stash, reset or switch branches unless asked.
