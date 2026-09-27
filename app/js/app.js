// INFO: item flow   new ──► opened in a new tab ──► done (undo via toast)
//                    ├──► later ──► opened ──► done (offline: reader, done when scrolled to the end)
//                    └──► dismissed        done ──► "read again" ──► reading
//       Feeds and item states are synced records; entries are fetched per device from the Collector.

import * as db from './db.js';
import { Sync, serverBase, defaultServer, isValidKey, cryptoAvailable } from './sync.js';
import { esc, httpUrl, hostOf as host } from './util.js';
import { normalizeUrl, extractUrl, feedId, fetchFeed, pool, parseOpml, buildOpml, cleanTitle } from './feeds.js';
import { LANGS, getLang, setLang, loadI18n, applyI18n, getTheme, setTheme, applyTheme } from './i18n.js';
import { OfflineStore, openReader, readerOpen } from './offline.js';

const VERSION = '0.7.9';

const PAGE = 150;
const AUTO_REFRESH_MS = 30 * 60 * 1000;
// INFO: matches the Collector's NR_UPSTREAM_PER_CLIENT – more parallel fetches only earn BUSY answers
const FETCH_PARALLEL = 2;
const RETRY_MAX_MS = 15 * 60 * 1000;
// INFO: a new subscription shows the last 14 days, but at least the newest 3 entries
const INITIAL_WINDOW_MS = 14 * 864e5;
const INITIAL_MIN_ENTRIES = 3;
const KEEP_UNSEEN_MS = 30 * 864e5;
const SWIPE_DEFAULT = { right: 'later', left: 'dismissed' };
const SWIPE_CHOICES = ['later', 'dismissed', 'done', 'reading', 'none'];

const S = {
  view: 'inbox',
  feeds: new Map(),
  items: new Map(),
  entries: new Map(),
  fetch: new Map(),
  filter: '',
  shown: PAGE,
  refreshing: false,
  kbId: '',
  kbPos: -1,
  lastRefresh: 0,
  share: '',
  swipe: { ...SWIPE_DEFAULT },
  quiet: new Set(),
  dupImg: new Set(),
};

let t = (k) => k;
const sync = new Sync();
const offline = new OfflineStore();
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const viewEl = $('#view');

applyTheme();

// INFO: per-device layout preference – "compact" hides teasers and thumbnails
const DENSITIES = ['comfortable', 'compact'];
const store = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, // INFO: storage blocked (private mode)
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* INFO: storage blocked */ } },
};
const getDensity = () => (DENSITIES.includes(store.get('news.density')) ? store.get('news.density') : 'comfortable');
function setDensity(d) {
  store.set('news.density', d);
  document.documentElement.dataset.density = d;
}
document.documentElement.dataset.density = getDensity();

// INFO: card actions appear on hover/focus by default; "always" keeps them visible (magnifiers, motor or cognitive needs)
const ACT_MODES = ['hover', 'always'];
const getActs = () => (ACT_MODES.includes(store.get('news.acts')) ? store.get('news.acts') : 'hover');
function setActs(m) {
  store.set('news.acts', m);
  document.documentElement.dataset.acts = m;
}
document.documentElement.dataset.acts = getActs();

const ICON = {
  now: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  later: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  offline: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M5 21h14"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  view: { inbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/></svg>', feeds: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.5"/></svg>', settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>' },
  doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
};
ICON.view.reading = ICON.now; ICON.view.later = ICON.later; ICON.view.done = ICON.done;

let rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });
function ago(ts) {
  if (!ts) return '';
  const s = (ts - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return t('time.just_now');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 7 * 86400) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(ts).toLocaleDateString(t.lang, { day: 'numeric', month: 'short', year: a > 300 * 86400 ? 'numeric' : undefined });
}
const clock = (ts) => new Date(ts).toLocaleTimeString(t.lang, { hour: '2-digit', minute: '2-digit' });

// INFO: render() fills this memo once per pass – counts, sidebar, list and filter all need the same derived lists
let memo = null;
const memoized = (key, fn) => (memo ? (memo[key] ??= fn()) : fn());

const entryTime = (e) => (e.ts ??= Date.parse(e.publishedAt || '') || e.firstSeen || 0);
let coll = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const byName = (a, b) => coll.compare(a, b);
const feedTitle = (id) => { const f = S.feeds.get(id); return f ? (cleanTitle(f.data.title) || host(f.data.url)) : ''; };
const liveFeeds = () => memoized('live', () => [...S.feeds.values()].filter((f) => !f.data.d).sort((a, b) => byName(feedTitle(a.id), feedTitle(b.id))));
const stateOf = (id) => S.items.get(id)?.data?.s || 'new';
// INFO: dismissed/new records are pruned after 30 days (sync.js) – for feeds followed longer than that, older entries
//       must not come back as new, so the inbox starts at most 30 days back
const sinceOf = (f, now = Date.now()) => ((f.data.added || 0) < now - KEEP_UNSEEN_MS ? Math.max(f.data.since || 0, now - KEEP_UNSEEN_MS) : f.data.since || 0);

// INFO: S.filter is '' (all), a feed id ("f…") or a folder ("g:<name>")
const folderOf = (id) => S.feeds.get(id)?.data?.g || '';
const inFilter = (fid, filter = S.filter) => !filter || (filter.startsWith('g:') ? folderOf(fid) === filter.slice(2) : fid === filter);
const filterName = (filter) => (filter.startsWith('g:') ? filter.slice(2) : feedTitle(filter));
const folders = () => [...new Set(liveFeeds().map((f) => f.data.g).filter(Boolean))].sort(byName);

// INFO: favicon from the Collector (source.icon), else /favicon.ico of the site; on error a monogram stays visible
const iconFailed = new Set();
function feedIcon(id, fallbackUrl = '') {
  const f = S.feeds.get(id);
  const st = S.fetch.get(id) || {};
  const name = f ? feedTitle(id) : host(fallbackUrl);
  let hue = 0;
  for (const ch of id || name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  let src = httpUrl(st.icon);
  if (!src) {
    try { src = new URL('/favicon.ico', httpUrl(st.site) || httpUrl(f?.data?.url) || httpUrl(fallbackUrl)).href; } catch { src = ''; }
  }
  const img = src && !iconFailed.has(src) ? `<img class="fi-img" src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="16" height="16">` : '';
  const letter = (name.match(/[\p{L}\p{N}]/u)?.[0] || '·').toLocaleUpperCase(t.lang);
  return `<span class="fi" style="--fi-h:${hue}" aria-hidden="true">${esc(letter)}${img}</span>`;
}

// INFO: server error codes → text in the app's language (the raw message goes into the tooltip)
const ERRC = {
  NO_FEED_DETECTED: 'no_feed', PLATFORM_NO_FEED: 'platform', DNS_FAILED: 'dns', UPSTREAM_FETCH_FAILED: 'upstream', UPSTREAM_HTTP_ERROR: 'upstream',
  UPSTREAM_TOO_LARGE: 'too_large', TOO_MANY_REDIRECTS: 'redirects', INVALID_URL: 'invalid', UNSUPPORTED_URL: 'invalid', FORBIDDEN_HOST: 'invalid',
  RATE_LIMITED: 'busy', BUSY: 'busy', SYNC_DISABLED: 'sync_disabled', FORBIDDEN_NETWORK: 'network', SERVER_FULL: 'full',
  PAYLOAD_TOO_LARGE: 'sync_too_big', SERVER_MISCONFIGURED: 'misconfigured', NOT_AN_ARTICLE: 'no_article', NO_CONTENT: 'no_article',
};
// INFO: errors without a code (or TIMEOUT / UNREACHABLE / HTTP_nnn from feeds.js) already carry translated text
//       401/403 from the source means it turns the collector away (often a bot wall), so "try later" would not help
function errText(code, message = '', status = 0) {
  if (code === 'UPSTREAM_HTTP_ERROR' && (status === 401 || status === 403)) return t('errc.blocked');
  if (ERRC[code]) return t('errc.' + ERRC[code]);
  if (!code || code === 'TIMEOUT' || code === 'UNREACHABLE' || /^HTTP_/.test(code)) return message || t('errc.generic');
  return t('errc.generic');
}
const errHtml = (e) => `<span class="err" title="${esc(e.message || '')}">${esc(errText(e.code, e.message, e.status))}</span>`;

async function loadAll() {
  S.feeds.clear(); S.items.clear(); S.entries.clear();
  for (const r of await db.getAll('records')) {
    if (r.kind === 'feed') S.feeds.set(r.id, r);
    else if (r.kind === 'item') S.items.set(r.id, r);
  }
  const [entries, last, fetchState, swipe] = await Promise.all([db.getAll('entries'), db.kvGet('lastRefresh', 0), db.kvGet('fetchState', {}), db.kvGet('swipe', {})]);
  for (const e of entries) S.entries.set(e.id, e);
  S.lastRefresh = last;
  Object.entries(fetchState).forEach(([k, v]) => S.fetch.set(k, v));
  S.swipe = { ...SWIPE_DEFAULT, ...swipe };
}

async function commit(records) {
  for (const r of records) (r.kind === 'feed' ? S.feeds : S.items).set(r.id, r);
  await db.putLocal(records);
  sync.schedule();
  if (records.some((r) => r.kind === 'item')) scheduleOffline();
}

const feedUrlOf = (id) => S.feeds.get(id)?.data?.url || '';
const scheduleOffline = (delay) => offline.schedule(() => S.items, feedUrlOf, delay);

function itemRecord(id, s, extra = {}) {
  const e = S.entries.get(id);
  const prev = S.items.get(id)?.data || {};
  const data = { s, ...extra };
  // INFO: snapshot so "Later" and "Done" stay complete after the entry left the feed
  const title = e?.title ?? prev.t, u = e?.url ?? prev.u, f = e?.feedId ?? prev.f, p = e?.publishedAt ?? prev.p, i = e?.image || prev.i;
  if (title) data.t = title;
  if (u) data.u = u;
  if (f) data.f = f;
  if (p) data.p = p;
  if (i) data.i = i;
  return { kind: 'item', id, data, updatedAt: Date.now() };
}

async function setState(ids, s, { toast = true, animate = true, label = '', extra } = {}) {
  ids = [].concat(ids);
  const before = ids.map((id) => S.items.get(id) || null);
  if (animate) await leave(ids, s);
  await commit(ids.map((id) => itemRecord(id, s, extra)));
  render();
  if (toast) showToast(label || stateToast(s, ids.length), () => restore(ids, before));
}

const stateToast = (s, n) => (n > 1 ? t(`toast.n_${s}`, { n }) : t(`toast.${s}`));

async function restore(ids, before) {
  const now = Date.now();
  await commit(ids.map((id, i) => {
    const prev = before[i];
    return prev ? { ...prev, updatedAt: now } : { ...itemRecord(id, 'new'), updatedAt: now };
  }));
  render();
}

// INFO: an opened entry is saved as "done" at once, but its card stays (dimmed) until News is visible again –
//       then it slides out with the undo toast. Background tabs keep News in front → the card leaves right away.
const lingering = new Map();
let lingerTimer = null;

async function markOpened(id, { background = false } = {}) {
  if (S.view === 'done' || lingering.has(id)) return;
  lingering.set(id, { view: S.view, before: S.items.get(id) || null });
  await commit([itemRecord(id, 'done')]);
  render();
  clearTimeout(lingerTimer);
  lingerTimer = setTimeout(() => {
    if (document.visibilityState === 'visible' && document.hasFocus()) flushOpened();
  }, background ? 350 : 1500);
}

async function flushOpened() {
  if (!lingering.size || readerOpen()) return;
  clearTimeout(lingerTimer);
  const ids = [...lingering.keys()];
  const before = ids.map((id) => lingering.get(id).before);
  await leave(ids, 'done');
  ids.forEach((id) => lingering.delete(id));
  render();
  showToast(stateToast('done', ids.length), () => restore(ids, before));
}

const lingersIn = (id, view) => lingering.get(id)?.view === view;

async function leave(ids, s) {
  const cards = ids.map((id) => viewEl.querySelector(`.card[data-id="${CSS.escape(id)}"]`)).filter(Boolean);
  if (!cards.length || cards.length > 20) return;
  const dir = s === 'dismissed' ? '-40px' : '40px';
  cards.forEach((c) => { c.style.setProperty('--leave', dir); c.classList.add('leaving'); });
  await new Promise((r) => setTimeout(r, 160));
}

function openUrl(url) {
  const safe = httpUrl(url);
  if (safe) window.open(safe, '_blank', 'noopener,noreferrer');
}

// INFO: online the original opens in a new tab (never through the server), offline the saved copy in the reader
function openArticle(id) {
  if (navigator.onLine) { openUrl(urlOf(id)); return 'tab'; }
  if (!offline.has(id)) { showToast(t('reader.unavailable')); return 'none'; }
  offline.get(id).then((a) => {
    if (!a?.ok) return;
    openReader(a, {
      t, lang: t.lang,
      onClose: async ({ read, pos }) => {
        if (read && stateOf(id) !== 'done') await setState(id, 'done', { label: t('reader.read_done') });
        else offline.savePosition(id, read ? 0 : pos);
      },
    });
  });
  return 'reader';
}

const urlOf = (id) => S.entries.get(id)?.url || S.items.get(id)?.data?.u;

async function refreshFeed(feed, force = false) {
  const res = await fetchFeed(feed.data.url, { refresh: force, t });
  const now = Date.now();
  const existing = await db.entriesForFeed(feed.id);
  const known = new Map(existing.map((e) => [e.id, e]));
  const fresh = toEntries(res.entries, feed.id, (id) => known.get(id)?.firstSeen || now);
  const freshIds = new Set(fresh.map((e) => e.id));
  const remove = existing
    .filter((e) => !freshIds.has(e.id) && !S.items.has(e.id) && now - entryTime(e) > KEEP_UNSEEN_MS)
    .map((e) => e.id);
  await db.putEntries(fresh, remove);
  fresh.forEach((e) => S.entries.set(e.id, e));
  remove.forEach((id) => S.entries.delete(id));
  S.fetch.set(feed.id, { at: now, ok: true, strategy: res.source?.strategy, count: fresh.length, stale: !!res.meta?.stale, ...sourceMeta(res) });
  return res;
}

// INFO: the Collector caches a source for hours – an automatic refresh skips feeds whose copy cannot have changed yet
//       and feeds it turned away until their retry time
const waiting = (f, now) => S.fetch.get(f.id)?.retry > now;
const due = (f, now) => { const st = S.fetch.get(f.id); return !st?.ok ? !waiting(f, now) : !st.next || st.next <= now; };

// INFO: BUSY / RATE_LIMITED mean "not now" – the feed is fetched again after Retry-After, backing off on repeats.
//       retry and tries live in fetchState (per device, not synced)
const NOT_NOW = ['RATE_LIMITED', 'BUSY'];
function failState(id, e, now = Date.now()) {
  const { retry, tries, ...prev } = S.fetch.get(id) || {};
  const st = { ...prev, at: now, ok: false, error: e.message, code: e.code, status: e.status || 0, next: 0 };
  if (!NOT_NOW.includes(e.code)) return st;
  const n = retry ? (tries || 0) + 1 : 0;
  return { ...st, tries: n, retry: now + Math.min(RETRY_MAX_MS, Math.max(1, e.retryAfter || 60) * 1000 * 2 ** n) };
}

let retryTimer = 0;
function scheduleRetry() {
  clearTimeout(retryTimer);
  const at = Math.min(...liveFeeds().map((f) => (S.fetch.get(f.id)?.ok === false && S.fetch.get(f.id).retry) || Infinity));
  if (at !== Infinity) retryTimer = setTimeout(() => refreshAll(), Math.max(0, at - Date.now()) + 1000);
}

async function refreshAll(force = false) {
  const all = liveFeeds(), now = Date.now();
  if (!all.length) { if (force) showToast(t('toast.no_feeds')); return; }
  const feeds = all.filter((f) => (force ? !waiting(f, now) : due(f, now)));
  if (S.refreshing) return;
  const before = inboxEntries('').length;
  S.refreshing = true;
  $('#refreshBtn').setAttribute('aria-busy', 'true');
  const results = await pool(feeds, FETCH_PARALLEL, (f) => refreshFeed(f, force));
  let failed = 0;
  results.forEach((r, i) => {
    if (!r.ok) {
      S.fetch.set(feeds[i].id, failState(feeds[i].id, r.error));
      if (!NOT_NOW.includes(r.error.code)) failed++;
    }
  });
  const later = all.filter((f) => waiting(f, Date.now())).length;
  S.lastRefresh = Date.now();
  await db.kvSet('lastRefresh', S.lastRefresh);
  await db.kvSet('fetchState', Object.fromEntries(S.fetch));
  S.refreshing = false;
  $('#refreshBtn').removeAttribute('aria-busy');
  if (force) render(); else renderSoft();
  scheduleRetry();
  if (feeds.length && failed === feeds.length && results[0]?.error?.code === 'UNREACHABLE') showToast(results[0].error.message);
  else if (failed) showToast(t('toast.refresh_failed', { n: failed }), () => go('feeds'), t('toast.details'));
  else if (force && later) showToast(t('toast.retry_later', { n: later }));
  else if (force) { const n = Math.max(0, inboxEntries('').length - before); showToast(n ? t('toast.checked', { n }) : t('toast.checked_none')); }
}

function toEntry(e, feedId, firstSeen) {
  const url = httpUrl(e.url);
  const author = typeof e.author === 'string' ? e.author.slice(0, 80) : '';
  return { id: e.id, feedId, url, title: e.title || url, summary: e.summary || '', image: httpUrl(e.image), author, publishedAt: e.publishedAt || e.updatedAt || null, firstSeen };
}

// INFO: per device (fetchState), not synced – icon and site only decorate the feed list
const sourceMeta = (res) => ({
  icon: httpUrl(res.source?.icon) || '', site: httpUrl(res.source?.siteUrl) || '',
  feed: res.source?.feedUrl ? feedId(res.source.feedUrl) : '', next: Date.parse(res.meta?.nextRefreshAfter || '') || 0,
});

const toEntries = (list, feedId, firstSeenOf) => (Array.isArray(list) ? list : [])
  .filter((e) => e && typeof e.id === 'string' && httpUrl(e.url))
  .map((e) => toEntry(e, feedId, firstSeenOf(e.id)));

// INFO: "later" = the feed is added even if the server is busy or unreachable (OPML import) – the next refresh fills it
const RETRY_LATER = ['RATE_LIMITED', 'BUSY', 'TIMEOUT', 'UNREACHABLE'];
async function addFeed(input, { quiet = false, title = '', folder = '', later = false, persist = true } = {}) {
  const url = normalizeUrl(input);
  if (!url) throw new Error(t('err.invalid_url'));
  const id = feedId(url);
  if (S.feeds.get(id) && !S.feeds.get(id).data.d) throw new Error(t('err.already_following'));
  let res;
  try {
    res = await fetchFeed(url, { t });
  } catch (e) {
    if (!later || !RETRY_LATER.includes(e.code)) throw e;
    res = { entries: [], source: {}, pending: e };
  }
  // INFO: two addresses of the same site (page and feed) resolve to one feed
  const resolved = res.source?.feedUrl ? feedId(res.source.feedUrl) : '';
  if (resolved && liveFeeds().some((f) => f.id === resolved || S.fetch.get(f.id)?.feed === resolved)) throw new Error(t('err.already_following'));
  const now = Date.now();
  const fresh = toEntries(res.entries, id, () => now);
  const times = fresh.map(entryTime).sort((a, b) => b - a);
  const since = Math.min(now - INITIAL_WINDOW_MS, times[Math.min(INITIAL_MIN_ENTRIES, times.length) - 1] ?? Infinity);
  const rec = {
    kind: 'feed', id, updatedAt: now,
    data: { url, title: cleanTitle(title || res.source?.title) || host(url), since, added: now },
  };
  if (folder.trim()) rec.data.g = folder.trim().slice(0, 60);
  await commit([rec]);
  await db.putEntries(fresh);
  fresh.forEach((e) => S.entries.set(e.id, e));
  S.fetch.set(id, res.pending
    ? failState(id, res.pending, now)
    : { at: now, ok: true, strategy: res.source?.strategy, count: fresh.length, ...sourceMeta(res) });
  if (persist) await db.kvSet('fetchState', Object.fromEntries(S.fetch));
  if (!quiet) render();
  return { rec, res };
}

async function removeFeed(id) {
  const f = S.feeds.get(id);
  if (!f) return;
  await commit([{ ...f, data: { url: f.data.url, title: f.data.title, d: 1 }, updatedAt: Date.now() }]);
  await db.deleteEntriesForFeed(id);
  for (const [eid, e] of S.entries) if (e.feedId === id) S.entries.delete(eid);
  render();
}

function inboxEntries(filter = S.filter) {
  const all = memoized('inbox', () => {
    const now = Date.now();
    const since = new Map(liveFeeds().map((f) => [f.id, sinceOf(f, now)]));
    return [...S.entries.values()]
      .filter((e) => since.has(e.feedId) && (stateOf(e.id) === 'new' || lingersIn(e.id, 'inbox')) && entryTime(e) >= since.get(e.feedId))
      .sort((a, b) => entryTime(b) - entryTime(a));
  });
  return filter ? all.filter((e) => inFilter(e.feedId, filter)) : all;
}

function itemsIn(s) {
  return memoized('items:' + s, () => [...S.items.values()]
    .filter((r) => (r.data.s === s && !r.data.h) ? !lingering.has(r.id) || lingersIn(r.id, s) : lingersIn(r.id, s))
    .sort((a, b) => (lingering.get(b.id)?.before?.updatedAt ?? b.updatedAt) - (lingering.get(a.id)?.before?.updatedAt ?? a.updatedAt))
    .map((r) => {
      const e = S.entries.get(r.id);
      return {
        id: r.id,
        url: e?.url || r.data.u,
        title: e?.title || r.data.t || r.data.u || t('untitled'),
        summary: e?.summary || '',
        image: e?.image || r.data.i || '',
        author: e?.author || '',
        feedId: e?.feedId || r.data.f,
        time: e ? entryTime(e) : Date.parse(r.data.p || '') || 0,
        changed: r.updatedAt,
      };
    }));
}

function counts() {
  const c = { inbox: inboxEntries('').length, reading: 0, later: 0 };
  for (const r of S.items.values()) if (r.data.s === 'reading' || r.data.s === 'later') c[r.data.s]++;
  return c;
}

// INFO: [target state, label key, icon, css class, keyboard key]
const ACTIONS = {
  inbox: [['reading', 'act.reading', ICON.now, 'main', 'o'], ['later', 'act.later', ICON.later, '', 'l'], ['dismissed', 'act.dismissed', ICON.x, 'x', 'x']],
  reading: [['done', 'act.done', ICON.done, 'main', 'd'], ['later', 'act.later', ICON.later, '', 'l'], ['dismissed', 'act.drop', ICON.x, 'x', 'x']],
  later: [['reading', 'act.reading', ICON.now, 'main', 'o'], ['done', 'act.done', ICON.done, '', 'd'], ['dismissed', 'act.remove', ICON.x, 'x', 'x']],
  done: [['reading', 'act.again', ICON.back, '', 'o'], ['later', 'act.later', ICON.later, '', 'l']],
  dismissed: [['new', 'act.restore', ICON.back, 'main', '']],
};

// INFO: configured swipe actions [right, left], limited to what the view offers
function swipeFor(view) {
  const allowed = (ACTIONS[view] || []).map(([s]) => s);
  const ok = (s) => (s && s !== 'none' && allowed.includes(s) ? s : null);
  return [ok(S.swipe.right), ok(S.swipe.left)];
}

// INFO: actions sit in the meta line – shown on hover, focus and for the keyboard selection (always on touch).
//       Only the main action keeps its label; the key is in the tooltip and in the "?" overview.
// INFO: the teaser is clamped to two lines. Only when text is cut off, markClamped() shows a small chevron
//       (a disclosure button with a fixed name, state in aria-expanded); clicking the teaser itself toggles, too.
const openSums = new Set();
function sumHtml(id, text) {
  const open = openSums.has(id), name = esc(t('act.sum_full'));
  return `<div class="sumw"><p class="sum${open ? ' open' : ''}" id="s-${esc(id)}">${esc(text)}</p><button type="button" class="sum-t" data-sum aria-expanded="${open}" aria-controls="s-${esc(id)}" aria-label="${name}" title="${name}"${open ? '' : ' hidden'}>${ICON.chev}</button></div>`;
}

function markClamped() {
  if (getDensity() === 'compact') return;
  const ps = $$('#view .sum:not(.open)');
  const cut = ps.map((p) => p.scrollHeight > p.clientHeight + 1);
  ps.forEach((p, i) => { p.nextElementSibling.hidden = !cut[i]; p.classList.toggle('cut', cut[i]); });
}

function toggleSum(btn) {
  const p = $('#' + CSS.escape(btn.getAttribute('aria-controls')));
  const id = btn.closest('.card').dataset.id;
  const open = !p.classList.contains('open');
  p.classList.toggle('open', open);
  p.classList.remove('cut');
  if (open) openSums.add(id); else { openSums.delete(id); markClamped(); }
  btn.setAttribute('aria-expanded', String(open));
}

let clampTimer = null;
window.addEventListener('resize', () => { clearTimeout(clampTimer); clampTimer = setTimeout(markClamped, 150); });

function card(it, view) {
  const feed = S.feeds.get(it.feedId);
  const [right, left] = swipeFor(view);
  const when = view === 'inbox' ? it.time : it.changed;
  const acts = ACTIONS[view].map(([s, label, icon, cls, key]) =>
    `<button type="button" class="act ${cls}" data-act="${s}" title="${esc(t(label))}${key ? ` (${key})` : ''}" aria-label="${esc(t(label))}" aria-describedby="t-${esc(it.id)}"${key ? ` aria-keyshortcuts="${key}"` : ''}>${icon}${cls === 'main' ? `<span>${t(label)}</span>` : ''}</button>`).join('');
  const words = offline.words(it.id);
  const saved = offline.has(it.id) ? `<span class="offline" title="${esc(t('reader.saved'))}">${ICON.offline}<span class="sr">${t('reader.saved')}</span>${words ? `<span>${t('reader.minutes', { n: Math.max(1, Math.round(words / 220)) })}</span>` : ''}</span>` : '';
  const image = S.dupImg.has(it.image) ? '' : httpUrl(it.image);
  const img = image ? `<img class="thumb" src="${esc(image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="120" height="80">` : '';
  const dot = '<span class="sep" aria-hidden="true">·</span>';
  // INFO: DOM order title → meta → teaser → actions (reading and tab order); the grid puts meta and actions on top.
  //       The card is named by its title and described by its meta line, so j/k focus announces the post.
  return `<li class="card${img ? ' has-img' : ''}${lingering.has(it.id) ? ' opened' : ''}" data-id="${esc(it.id)}" tabindex="-1" aria-labelledby="t-${esc(it.id)}" aria-describedby="m-${esc(it.id)}"${right ? ` data-right="${esc(t('act.' + right))} →" data-right-act="${right}"` : ''}${left ? ` data-left="← ${esc(t('act.' + left))}" data-left-act="${left}"` : ''}>
    <h3><a id="t-${esc(it.id)}" href="${esc(httpUrl(it.url) || '#')}" target="_blank" rel="noopener noreferrer" data-open>${esc(it.title)}</a></h3>
    <div class="meta" id="m-${esc(it.id)}"><span class="src">${feedIcon(it.feedId, it.url)}<span>${esc(feed ? feedTitle(it.feedId) : host(it.url))}</span></span>${it.author ? `${dot}<span class="by">${esc(it.author)}</span>` : ''}${when ? `${dot}<time datetime="${new Date(when).toISOString()}">${ago(when)}</time>` : ''}${saved}</div>
    ${img}${it.summary ? sumHtml(it.id, it.summary) : ''}
    <div class="acts">${acts}</div>
  </li>`;
}

// INFO: an image that a feed repeats on several posts is a logo or placeholder, not a picture of the post
function repeatedImages() {
  const seen = new Set(), dup = new Set();
  for (const e of S.entries.values()) {
    if (!e.image) continue;
    const k = e.feedId + ' ' + e.image;
    if (seen.has(k)) dup.add(e.image); else seen.add(k);
  }
  return dup;
}

const dayKey = (ts) => { const d = new Date(ts); return ts ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : ''; };
function dayLabel(ts) {
  if (!ts) return t('day.undated');
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.max(0, Math.round((today - d) / 864e5));
  if (diff < 2) { const s = rtf.format(-diff, 'day'); return s[0].toLocaleUpperCase(t.lang) + s.slice(1); }
  const opts = { day: 'numeric', month: 'long' };
  if (diff < 7) opts.weekday = 'long';
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(t.lang, opts);
}

// INFO: lists are sorted newest first, so every day is one run; the sticky day header carries the count
function dayGroups(list, view, whenOf) {
  const groups = [];
  for (const it of list) {
    const w = whenOf(it), k = dayKey(w);
    let g = groups.at(-1);
    if (!g || g.k !== k) groups.push(g = { k, w, items: [] });
    g.items.push(it);
  }
  return groups.map((g) => `<section class="day"><h2 class="day-h"><span>${esc(dayLabel(g.w))}</span><b aria-hidden="true">${g.items.length}</b><span class="sr">, ${t('day.posts', { n: g.items.length })}</span></h2>
    <ol class="list">${g.items.map((it) => card(it, view)).join('')}</ol></section>`).join('');
}

const badge = (n) => (n ? (n > 999 ? '999+' : String(n)) : '');

// INFO: a redraw replaces the focused element – remember what it was (id or data attributes) and focus its successor
const FOCUS_ATTRS = ['data-feed-act', 'data-device-act', 'data-fold', 'data-quiet', 'data-filter', 'data-view', 'data-more', 'data-refresh'];
function focusSelector(a) {
  if (!a || a === document.body || !a.closest('#view, #srcSec') || a.closest('.card')) return null;
  if (a.id) return '#' + CSS.escape(a.id);
  const attr = FOCUS_ATTRS.find((x) => a.hasAttribute(x));
  if (!attr) return null;
  const scope = a.closest('[data-feed], [data-device]');
  const pre = scope ? (scope.dataset.feed ? `[data-feed="${CSS.escape(scope.dataset.feed)}"] ` : `[data-device="${CSS.escape(scope.dataset.device)}"] `) : '';
  return `${pre}[${attr}="${CSS.escape(a.getAttribute(attr))}"]`;
}
const viewHeading = () => $('#view h1');

function renderCounts(c = counts()) {
  $$('[data-count]').forEach((b) => { b.textContent = badge(c[b.dataset.count]); });
  document.title = (c.inbox ? `(${c.inbox}) ` : '') + (S.view === 'inbox' ? 'News' : `${viewName(S.view)} – News`);
  if (navigator.setAppBadge) navigator.setAppBadge(c.inbox).catch(() => {});
}
const viewName = (v) => t(v === 'settings' ? 'app.settings' : v === 'dismissed' ? 'views.dismissed.title' : 'nav.' + v);

// INFO: background redraws (sync, visibility, offline copies) must not wipe half-typed input in Feeds / Settings
function editing() {
  const a = document.activeElement;
  if (a?.closest?.('#view') && a.matches('input, textarea, select')) return true;
  return $$('#view input[type="text"], #view input:not([type])').some((i) => i.value !== i.defaultValue);
}
function renderSoft() {
  if ((S.view === 'feeds' || S.view === 'settings') && editing()) return renderCounts();
  render();
}

function render() {
  memo = {};
  try { renderNow(); } finally { memo = null; }
}

function renderNow() {
  if (S.filter && !folderFeeds(S.view).some((f) => inFilter(f.id))) S.filter = '';
  const c = counts();
  renderCounts(c);
  $$('.nav [data-view], .top [data-view]').forEach((b) => {
    if (b.dataset.view === S.view && !(S.view === 'inbox' && S.filter)) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  S.dupImg = repeatedImages();
  const scroll = window.scrollY;
  const active = document.activeElement;
  const refocus = !!active?.closest?.('#view .card');
  const again = focusSelector(active);
  renderFeedNav();
  const views = { inbox: renderInbox, reading: renderItems, later: renderItems, done: renderItems, dismissed: renderItems, feeds: renderFeeds, settings: renderSettings };
  views[S.view]();
  markClamped();
  window.scrollTo(0, scroll);
  const i = applyKb();
  // INFO: the focused card (or its button) was replaced – without this, focus would fall back to <body>
  if (refocus) (cardsInView()[i] || viewHeading() || viewEl).focus({ preventScroll: true });
  else if (again && !document.activeElement?.closest?.('#view, #srcSec')) ($(again) || viewHeading() || viewEl).focus({ preventScroll: true });
}

const FOLDER_VIEWS = ['inbox', 'reading', 'later', 'done', 'dismissed'];
let feedNavOpen = store.get('news.feedNav') !== '0';
let closedFolders = new Set();
try { closedFolders = new Set(JSON.parse(store.get('news.folders.closed', '[]'))); } catch { /* INFO: broken value */ }

function perFeed(view) {
  const m = new Map();
  const ids = view === 'inbox' ? inboxEntries('').map((e) => e.feedId) : itemsIn(view).map((it) => it.feedId);
  for (const id of ids) m.set(id, (m.get(id) || 0) + 1);
  return m;
}

// INFO: outside the inbox, unfollowed feeds with saved items keep their entry
function folderFeeds(view, n = perFeed(view)) {
  const live = liveFeeds();
  if (view === 'inbox' || !FOLDER_VIEWS.includes(view)) return live;
  const liveIds = new Set(live.map((f) => f.id));
  const gone = [...n.keys()]
    .filter((id) => !liveIds.has(id) && S.feeds.has(id))
    .map((id) => S.feeds.get(id))
    .sort((a, b) => byName(feedTitle(a.id), feedTitle(b.id)));
  return [...live, ...gone];
}

// INFO: sources of the current view as a tree: folders first, then feeds without folder. Feeds with nothing in
//       this view fold away behind "+ n more" per group – with one feed there is nothing to filter.
function renderFeedNav() {
  const sec = $('#srcSec'), box = $('#feedNav'), toggle = $('#feedNavToggle');
  if (!sec) return;
  const on = FOLDER_VIEWS.includes(S.view);
  const n = on ? perFeed(S.view) : new Map();
  const feeds = on ? folderFeeds(S.view, n) : [];
  sec.hidden = feeds.length < 2;
  if (sec.hidden) return;
  toggle.setAttribute('aria-expanded', String(feedNavOpen));
  box.hidden = !feedNavOpen;
  if (box.hidden) return;

  const feedBtn = (f) => {
    const c = n.get(f.id) || 0;
    const cur = S.filter === f.id ? ' aria-current="page"' : '';
    const cls = ['feed', c ? '' : 'zero', f.data.d ? 'gone' : ''].filter(Boolean).join(' ');
    const tip = feedTitle(f.id) + (f.data.d ? ` – ${t('feeds.unfollowed')}` : '');
    return `<button type="button" data-filter="${esc(f.id)}"${cur} class="${cls}" title="${esc(tip)}">${feedIcon(f.id)}<span class="nm">${esc(feedTitle(f.id))}</span><b class="badge">${badge(c)}</b></button>`;
  };
  const list = (key, group) => {
    const shown = group.filter((f) => n.get(f.id) || S.filter === f.id);
    const quiet = group.length - shown.length;
    // INFO: hiding a single feed behind a button saves nothing
    const hide = quiet >= 2 && !S.quiet.has(key);
    const body = (hide ? shown : group).map(feedBtn).join('');
    const more = quiet >= 2
      ? `<button type="button" class="quiet" data-quiet="${esc(key)}" aria-expanded="${!hide}">${hide ? t('nav.more', { n: quiet }) : t('nav.less')}</button>` : '';
    return body + more;
  };

  const byFolder = new Map();
  const loose = [];
  for (const f of feeds) {
    if (f.data.g && !f.data.d) byFolder.set(f.data.g, [...(byFolder.get(f.data.g) || []), f]);
    else loose.push(f);
  }
  const html = [...byFolder].sort(([a], [b]) => byName(a, b)).map(([g, group]) => {
    const total = group.reduce((sum, f) => sum + (n.get(f.id) || 0), 0);
    const closed = closedFolders.has(g);
    const cur = S.filter === 'g:' + g ? ' aria-current="page"' : '';
    return `<div class="fold${closed ? ' closed' : ''}">
      <div class="fold-h"><button type="button" class="fold-t" data-fold="${esc(g)}" aria-expanded="${!closed}" aria-label="${esc(t('nav.toggle_folder', { name: g }))}">${ICON.chev}</button><button type="button" data-filter="${esc('g:' + g)}"${cur} class="${total ? '' : 'zero'}" title="${esc(g)}">${ICON.folder}<span class="nm">${esc(g)}</span><b class="badge">${badge(total)}</b></button></div>
      ${closed ? '' : `<div class="fold-b">${list('g:' + g, group)}</div>`}
    </div>`;
  }).join('') + list('', loose);
  box.innerHTML = html;
}

// INFO: feed filter for narrow screens, where the sidebar is hidden – folders as option groups
function filterSelect() {
  const feeds = folderFeeds(S.view);
  const opt = (value, label) => `<option value="${esc(value)}"${S.filter === value ? ' selected' : ''}>${esc(label)}</option>`;
  const groups = [...new Set(feeds.map((f) => f.data.g).filter(Boolean))].sort(byName);
  const opts = groups.map((g) => `<optgroup label="${esc(g)}">${opt('g:' + g, t('inbox.folder_all', { name: g }))}${feeds.filter((f) => f.data.g === g).map((f) => opt(f.id, feedTitle(f.id))).join('')}</optgroup>`).join('')
    + feeds.filter((f) => !f.data.g).map((f) => opt(f.id, feedTitle(f.id))).join('');
  return `<select id="filter" aria-label="${esc(t('inbox.filter'))}"><option value="">${t('inbox.all_feeds')}</option>${opts}</select>`;
}

const crumb = () => (S.filter ? `<small class="crumb"> · ${esc(filterName(S.filter))}</small>` : '');

// INFO: posting rhythm and how much of a feed you actually read – a basis for unfollowing, instead of follower counts
function allFeedStats() {
  return memoized('stats', () => {
    const now = Date.now(), m = new Map();
    const get = (id) => m.get(id) || m.set(id, { recent: 0, oldest: now, read: 0, dropped: 0, unread: 0 }).get(id);
    const since = new Map(liveFeeds().map((f) => [f.id, sinceOf(f, now)]));
    for (const e of S.entries.values()) {
      const x = get(e.feedId), ts = entryTime(e);
      if (ts && now - ts < 28 * 864e5) { x.recent++; x.oldest = Math.min(x.oldest, ts); }
      if (since.has(e.feedId) && stateOf(e.id) === 'new' && ts >= since.get(e.feedId)) x.unread++;
    }
    for (const r of S.items.values()) {
      if (!r.data.f) continue;
      if (r.data.s === 'dismissed') get(r.data.f).dropped++;
      else if (r.data.s !== 'new') get(r.data.f).read++;
    }
    return m;
  });
}

function feedStats(id) {
  const x = allFeedStats().get(id) || { recent: 0, oldest: 0, read: 0, dropped: 0, unread: 0 };
  const span = x.recent ? Math.max(864e5, Date.now() - x.oldest) : 0;
  const perWeek = span ? x.recent / span * 7 * 864e5 : 0;
  const { read, dropped } = x;
  return { perWeek, read, dropped, unread: x.unread, rate: read + dropped >= 5 ? Math.round(read / (read + dropped) * 100) : null };
}

function statsText(id) {
  const st = feedStats(id);
  const parts = [st.perWeek >= 1 ? t('ctx.per_week', { n: Math.round(st.perWeek) }) : t('ctx.rarely')];
  if (st.rate !== null) parts.push(`<span${st.rate < 10 && st.read + st.dropped >= 20 ? ' class="low"' : ''}>${t('ctx.read_rate', { p: st.rate })}</span>`);
  return parts.join(' · ');
}

// INFO: filtered to one feed: its rhythm and read rate plus rename / folder / unfollow; filtered to a folder: its size
function context() {
  if (!S.filter) return '';
  if (S.filter.startsWith('g:')) {
    const n = liveFeeds().filter((f) => inFilter(f.id)).length;
    return `<p class="ctx">${ICON.folder}<span>${t('ctx.folder', { n })}</span></p>`;
  }
  const f = S.feeds.get(S.filter);
  if (!f || f.data.d) return '';
  const name = esc(feedTitle(f.id));
  return `<div class="ctx" data-feed="${esc(f.id)}">${feedIcon(f.id)}<span>${statsText(f.id)}</span>
    <span class="ctx-ops">
      <button class="icon-btn" type="button" data-feed-act="folder" title="${esc(t('feeds.folder'))}" aria-label="${esc(t('feeds.folder'))}: ${name}">${ICON.folder}</button>
      <button class="icon-btn" type="button" data-feed-act="rename" title="${esc(t('feeds.rename'))}" aria-label="${esc(t('feeds.rename'))}: ${name}">${ICON.edit}</button>
      <button class="icon-btn" type="button" data-feed-act="remove" title="${esc(t('feeds.unfollow'))}" aria-label="${esc(t('feeds.unfollow'))}: ${name}">${ICON.trash}</button>
    </span></div>`;
}

// INFO: first run explains the three choices; afterwards the line shows today's progress instead
function inboxLine(n) {
  if (!n) return t('inbox.nothing_new');
  const d0 = new Date().setHours(0, 0, 0, 0);
  let today = 0;
  for (const r of S.items.values()) if (r.updatedAt >= d0 && r.data.s !== 'new') today++;
  if (!S.items.size) return t('inbox.count', { n });
  return t('inbox.count_short', { n }) + (today ? ' · ' + t('inbox.today', { n: today }) : '');
}

function renderInbox() {
  const feeds = liveFeeds();
  if (!feeds.length) {
    viewEl.innerHTML = `<div class="vh"><div><h1 tabindex="-1">${t('inbox.title')}</h1></div></div>
      <div class="empty onboard">${ICON.view.inbox}<strong>${t('inbox.empty_title')}</strong><span>${t('inbox.empty_text')}</span><span>${t('inbox.empty_how')}</span>
      <span class="row"><button class="btn btn-primary" data-view="feeds" type="button">${t('inbox.add_first')}</button><button class="btn btn-ghost" type="button" id="startImport">${ICON.upload}<span>${t('inbox.import')}</span></button><button class="btn btn-ghost" type="button" id="startPair">${t('inbox.pair')}</button></span></div>`;
    return;
  }
  const all = inboxEntries();
  const list = all.slice(0, S.shown);
  viewEl.innerHTML = `<div class="vh">
      <div><h1 tabindex="-1">${t('inbox.title')}${crumb()}</h1><p>${inboxLine(all.length)}</p></div>
      <div class="tools">
        ${filterSelect()}
        ${list.length ? `<button class="btn btn-ghost" type="button" id="clearInbox" title="${esc(t('inbox.clear_hint'))}">${t(list.length < all.length ? 'inbox.clear_shown' : 'inbox.clear_all')}</button>` : ''}
      </div></div>
    ${context()}
    ${list.length ? dayGroups(list.map((e) => ({ ...e, time: entryTime(e) })), 'inbox', (it) => it.time) : `<div class="empty">${ICON.view.inbox}<strong>${t('inbox.zero')}</strong>${S.lastRefresh ? t('inbox.last_checked', { when: ago(S.lastRefresh) }) : ''}<br><button class="btn btn-ghost" type="button" data-refresh>${t('inbox.check')}</button></div>`}
    ${all.length > list.length ? `<div class="more"><button class="btn btn-ghost" type="button" data-more>${t('inbox.more', { n: all.length - list.length })}</button></div>` : ''}`;
}

function renderItems() {
  const v = `views.${S.view}`;
  const all = itemsIn(S.view).filter((it) => inFilter(it.feedId));
  const list = all.slice(0, S.shown);
  const clear = S.view === 'done' && list.length
    ? `<button class="btn btn-danger" type="button" id="clearDone">${ICON.trash}<span>${t('views.done.clear')}</span></button>`
    : S.view === 'later' && list.length
      ? `<button class="btn btn-ghost" type="button" id="laterAllDone">${ICON.done}<span>${t('views.later.all_done')}</span></button>` : '';
  const aside = S.view === 'done' ? `<button class="btn btn-ghost" type="button" data-view="dismissed">${ICON.x}<span>${t('views.done.show_dismissed')}</span></button>`
    : S.view === 'dismissed' ? `<button class="btn btn-ghost" type="button" data-view="done">${ICON.back}<span>${t('nav.done')}</span></button>` : '';
  const hasFolders = folderFeeds(S.view).length > 0;
  const tools = hasFolders || clear || aside ? `<div class="tools">${hasFolders ? filterSelect() : ''}${aside}${clear}</div>` : '';
  viewEl.innerHTML = `<div class="vh"><div><h1 tabindex="-1">${t(v + '.title')}${crumb()}</h1><p>${t(v + '.text')}</p></div>${tools}</div>
    ${context()}
    ${list.length ? dayGroups(list, S.view, (it) => it.changed) : `<div class="empty">${ICON.view[S.view] || ICON.x}<strong>${t(v + '.empty')}</strong>${t(v + '.hint')}</div>`}
    ${all.length > list.length ? `<div class="more"><button class="btn btn-ghost" type="button" data-more>${t('inbox.more', { n: all.length - list.length })}</button></div>` : ''}`;
}

// INFO: how the Collector found the posts, in plain words – the technical strategy name stays in the tooltip
const strategyPill = (s) => `<span class="pill" title="${esc(s)}">${t('feeds.strategy_' + (s === 'sitemap' || s === 'client' ? s : s.startsWith('html') ? 'page' : 'feed'))}</span>`;

function renderFeeds() {
  const feeds = liveFeeds();
  const app = location.href.split(/[?#]/)[0];
  const bookmarklet = `javascript:location.href=${JSON.stringify(app + '?add=')}+encodeURIComponent(location.href)`;
  const row = (f) => {
    const st = S.fetch.get(f.id) || {};
    const unread = feedStats(f.id).unread;
    const name = esc(feedTitle(f.id));
    return `<div class="feedrow has-fi" data-feed="${esc(f.id)}">${feedIcon(f.id)}
      <div class="t">${esc(feedTitle(f.id) || f.data.url)}</div>
      <div class="u">${esc(f.data.url)}</div>
      <div class="st">${st.strategy ? strategyPill(st.strategy) : ''}
        <span>${t('feeds.new', { n: unread })}</span><span>· ${statsText(f.id)}</span>${st.at ? `<span>${t('feeds.checked', { when: ago(st.at) })}</span>` : ''}${st.ok === false ? `<span class="err" title="${esc(st.error || '')}">· ${esc(errText(st.code, st.error, st.status))}</span>` : ''}${st.stale ? `<span>${t('feeds.stale')}</span>` : ''}</div>
      <div class="ops">
        <button class="icon-btn" type="button" data-feed-act="folder" title="${esc(t('feeds.folder'))}" aria-label="${esc(t('feeds.folder'))}: ${name}">${ICON.folder}</button>
        <button class="icon-btn" type="button" data-feed-act="refresh" title="${esc(t('feeds.refresh'))}" aria-label="${esc(t('feeds.refresh'))}: ${name}">${ICON.refresh}</button>
        <button class="icon-btn" type="button" data-feed-act="rename" title="${esc(t('feeds.rename'))}" aria-label="${esc(t('feeds.rename'))}: ${name}">${ICON.edit}</button>
        <button class="icon-btn" type="button" data-feed-act="remove" title="${esc(t('feeds.unfollow'))}" aria-label="${esc(t('feeds.unfollow'))}: ${name}">${ICON.trash}</button>
      </div></div>`;
  };
  const groups = folders();
  const rows = groups.map((g) => `<h3 class="fold-title">${ICON.folder}<span>${esc(g)}</span></h3>${feeds.filter((f) => f.data.g === g).map(row).join('')}`).join('')
    + (groups.length && feeds.some((f) => !f.data.g) ? `<h3 class="fold-title">${t('feeds.no_folder')}</h3>` : '')
    + feeds.filter((f) => !f.data.g).map(row).join('');
  viewEl.innerHTML = `<div class="vh"><div><h1 tabindex="-1">${t('feeds.title')}</h1><p>${t('feeds.count', { n: feeds.length })}</p></div></div>
    <section class="panel">
      <h2>${t('feeds.follow_title')}</h2>
      <p id="followText">${t('feeds.follow_text')}</p>
      <label class="lbl" for="addUrl">${t('feeds.url_label')}</label>
      <form class="row" id="addForm"><input type="text" id="addUrl" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="${esc(t('feeds.placeholder'))}" required aria-describedby="followText addResult"><button class="btn btn-primary" type="submit">${t('feeds.follow')}</button></form>
      <div class="result" id="addResult" aria-live="polite"></div>
    </section>
    <section class="panel">
      <h2>${t('feeds.yours')}</h2>
      ${rows || `<p class="hint">${t('feeds.none')}</p>`}
    </section>
    <section class="panel">
      <h2>${t('feeds.io_title')}</h2>
      <p id="ioText">${t('feeds.io_text')}</p>
      <div class="row"><button class="btn btn-ghost" type="button" id="opmlPick">${ICON.upload}<span>${t('feeds.import')}</span></button><input type="file" id="opmlIn" accept=".opml,.xml,text/xml,application/xml" hidden><button class="btn btn-ghost" type="button" id="opmlOut"${feeds.length ? '' : ' disabled'}>${ICON.download}<span>${t('feeds.export')}</span></button><a class="btn btn-ghost" href="${esc(bookmarklet)}" onclick="return false" aria-describedby="ioText">+ News</a></div>
      <div class="result" id="opmlResult" aria-live="polite"></div>
    </section>`;
  if (S.share) {
    $('#addUrl').value = S.share;
    $('#addResult').textContent = t('feeds.shared');
    $('#addUrl').focus();
  }
}

async function renderSettings() {
  const key = await db.kvGet('vaultKey');
  const server = await serverBase();
  const custom = await db.kvGet('server');
  const pairLink = key ? pairingLink(key, custom) : '';
  const opt = (value, label, cur) => `<option value="${value}"${value === cur ? ' selected' : ''}>${label}</option>`;
  const swipeOpts = (cur) => SWIPE_CHOICES.map((s) => opt(s, t(s === 'none' ? 'act.none' : 'act.' + s), cur)).join('');
  if (S.view !== 'settings') return; // INFO: the user navigated away while the settings were loading
  const site = '../' + (t.lang === 'en' ? '' : t.lang + '/'); // INFO: legal pages of the landing site, in the app's language
  const local = t('settings.local_text', {
    feeds: t('settings.local_feeds', { n: liveFeeds().length }), items: t('settings.local_items', { n: S.items.size }), entries: t('settings.local_entries', { n: S.entries.size }),
  });
  viewEl.innerHTML = `<div class="vh"><div><h1 tabindex="-1">${t('settings.title')}</h1><p>${t('settings.subtitle', { version: VERSION })}</p>${S.updateReady ? `<div class="row"><button class="btn btn-ghost" type="button" data-reload>${t('settings.update_reload')}</button></div>` : ''}<p class="legal"><a href="${site}privacy.html">${t('settings.privacy')}</a> · <a href="${site}imprint.html">${t('settings.imprint')}</a></p></div></div>
    <section class="panel">
      <h2>${t('settings.look_title')}</h2>
      <div class="grid2">
        <label class="field"><span>${t('settings.language')}</span><select id="langSel">${Object.entries(LANGS).map(([k, v]) => opt(k, v, t.lang)).join('')}</select></label>
        <label class="field"><span>${t('settings.theme')}</span><select id="themeSel">${['auto', 'light', 'dark'].map((m) => opt(m, t('settings.theme_' + m), getTheme())).join('')}</select></label>
        <label class="field"><span>${t('settings.density')}</span><select id="densitySel">${DENSITIES.map((d) => opt(d, t('settings.density_' + d), getDensity())).join('')}</select></label>
        <label class="field"><span>${t('settings.acts')}</span><select id="actsSel">${ACT_MODES.map((m) => opt(m, t('settings.acts_' + m), getActs())).join('')}</select></label>
      </div>
    </section>
    <section class="panel" id="syncPanel">
      <h2>${t('settings.sync_title')}</h2>
      ${key ? `
        <p>${t('settings.sync_paired')}</p>
        <div class="qr" id="qr" role="img" aria-label="${esc(t('settings.qr_label'))}"></div>
        <div class="row">
          <button class="btn btn-primary" type="button" id="syncNow">${t('settings.sync_now')}</button>
          <button class="btn btn-ghost" type="button" id="copyLink">${t('settings.copy_link')}</button>
          <button class="btn btn-ghost" type="button" id="leaveVault">${t('settings.unpair')}</button>
          <button class="btn btn-danger" type="button" id="wipeVault">${t('settings.wipe')}</button>
        </div>
        <dl class="kv" style="margin-top:14px"><dt>${t('settings.server')}</dt><dd>${esc(new URL('api/sync', server).href)}</dd><dt>${t('settings.status')}</dt><dd id="syncDetail">${esc(statusText(sync.status, true))}</dd></dl>`
      : `
        <p>${t('settings.sync_intro')}</p>${cryptoAvailable() ? '' : `<p class="err">${t('settings.sync_https')}</p>`}
        <div class="row"><button class="btn btn-primary" type="button" id="createVault"${cryptoAvailable() ? '' : ' disabled'}>${t('settings.create_vault')}</button></div>
        <h2 style="margin-top:20px">${t('settings.join_title')}</h2>
        <p>${t('settings.join_text')}</p>
        <label class="lbl" for="joinKey">${t('settings.join_placeholder')}</label>
        <form class="row" id="joinForm"><input type="text" id="joinKey" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="syncResult"><button class="btn btn-ghost" type="submit">${t('settings.join')}</button></form>`}
      <div class="result" id="syncResult" aria-live="polite"></div>
    </section>
    ${key ? `<section class="panel" id="devicesPanel">
      <h2>${t('devices.title')}</h2>
      <p>${t('devices.text')}</p>
      <div id="devices"></div>
      <div class="row"><button class="btn btn-ghost" type="button" id="rotateKey">${t('devices.rotate')}</button></div>
    </section>` : ''}
    <section class="panel only-touch">
      <h2>${t('settings.swipe_title')}</h2>
      <p>${t('settings.swipe_text')}</p>
      <div class="grid2">
        <label class="field"><span>${t('settings.swipe_right')}</span><select id="swipeRight">${swipeOpts(S.swipe.right)}</select></label>
        <label class="field"><span>${t('settings.swipe_left')}</span><select id="swipeLeft">${swipeOpts(S.swipe.left)}</select></label>
      </div>
    </section>
    <section class="panel only-keys">
      <h2>${t('settings.keyboard')}</h2>
      <p>${t('settings.keys_text')}</p>
      <div class="grid2"><label class="field"><span>${t('settings.keys')}</span><select id="keysSel">${KEY_MODES.map((m) => opt(m, t('settings.keys_' + m), getKeys())).join('')}</select></label></div>
      ${keysHtml()}
    </section>
    <section class="panel">
      <h2>${t('settings.server_title')}</h2>
      <p>${t('settings.server_text')}</p>
      <label class="lbl" for="serverUrl">${t('settings.server_label')}</label>
      <form class="row keep" id="serverForm"><input type="text" inputmode="url" autocapitalize="off" spellcheck="false" id="serverUrl" value="${esc(custom || '')}" placeholder="${esc(defaultServer())}" aria-describedby="serverResult"><span class="btns"><button class="btn btn-ghost" type="submit">${t('settings.save')}</button><button class="btn btn-ghost" type="button" id="serverTest">${t('settings.test')}</button></span></form>
      <div class="result" id="serverResult" aria-live="polite"></div>
    </section>
    <section class="panel">
      <h2>${t('settings.local_title')}</h2>
      <p>${local}</p>
      <div class="row"><button class="btn btn-danger" type="button" id="resetLocal">${t('settings.reset')}</button></div>
    </section>`;
  if (key) {
    drawQr(pairLink);
    renderDevices();
  }
}

const KEYS = [['j k', 'key_jk'], ['↓ ↑', 'key_arrows'], ['o', 'key_o'], ['Enter', 'key_enter'], ['l', 'key_l'], ['x', 'key_x'], ['d', 'key_d'], ['u', 'key_u'], ['r', 'key_r'], ['1–5', 'key_num'], ['/', 'key_search'], ['Ctrl+K', 'key_ctrlk'], ['v', 'key_v'], ['Esc', 'key_esc'], ['?', 'key_help']];
const keysHtml = () => `<ul class="keys">${KEYS.map(([k, label]) => `<li>${k.split(' ').map((x) => x.split('–').map((y) => `<kbd>${esc(y)}</kbd>`).join('–')).join('')}${t('settings.' + label)}</li>`).join('')}</ul>`;

// INFO: single-key shortcuts can be switched off (speech input, tremor) – WCAG 2.1.4
const KEY_MODES = ['on', 'off'];
const getKeys = () => (store.get('news.keys') === 'off' ? 'off' : 'on');

async function renderDevices() {
  const box = $('#devices');
  if (!box) return;
  const [list, own] = await Promise.all([sync.devices(), db.kvGet('deviceId')]);
  list.sort((a, b) => (b.id === own) - (a.id === own));
  box.innerHTML = list.length ? list.map((d) => {
    const self = d.id === own;
    const name = esc(d.data.name);
    const since = d.data.since ? new Date(d.data.since).toLocaleDateString(t.lang, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    return `<div class="feedrow device" data-device="${esc(d.id)}">
      <div class="t">${name}${self ? ` <span class="pill">${t('devices.this')}</span>` : ''}</div>
      ${d.data.platform !== d.data.name ? `<div class="u">${esc(d.data.platform)}</div>` : ''}
      <div class="st"><span>${self ? t('devices.active_now') : t('devices.seen', { when: ago(d.data.seen) })}</span>${since ? `<span>· ${t('devices.since', { date: since })}</span>` : ''}${d.pubChanged ? `<span class="err">· ${t('devices.key_changed')}</span>` : ''}</div>
      <div class="ops">
        <button class="icon-btn" type="button" data-device-act="rename" title="${esc(t('devices.rename'))}" aria-label="${esc(t('devices.rename'))}: ${name}">${ICON.edit}</button>
        ${self ? '' : `<button class="icon-btn" type="button" data-device-act="remove" title="${esc(t('devices.remove'))}" aria-label="${esc(t('devices.remove'))}: ${name}">${ICON.trash}</button>`}
      </div></div>`;
  }).join('') : `<p class="hint">${t('devices.none')}</p>`;
}

async function deviceAction(act, id) {
  const d = (await sync.devices()).find((x) => x.id === id);
  if (!d) return;
  if (act === 'rename') {
    const name = await ask({ title: t('devices.rename'), label: t('devices.rename_prompt'), value: d.data.name || '' });
    if (name === null || !name.trim()) return;
    await sync.renameDevice(id, name);
    return renderDevices();
  }
  if (act !== 'remove') return;
  const keyless = (await sync.devices()).filter((x) => x.id !== id && (!x.data.pub || x.pubChanged)).length;
  const body = `<p>${t('devices.remove_body', { name: esc(d.data.name) })}</p>${keyless ? `<p>${t('devices.keyless', { n: keyless })}</p>` : ''}`;
  if (!await dialog({ title: t('devices.remove_title'), body, ok: t('devices.remove_ok'), danger: true })) return;
  await rekey(() => sync.revoke(id), 'devices.removed');
}

// INFO: after a key change the pairing link and QR code change, so the whole settings view is redrawn
async function rekey(action, doneKey) {
  const btn = $('#rotateKey');
  if (btn) btn.disabled = true;
  try {
    await action();
    showToast(t(doneKey));
  } catch (e) {
    showToast(e.code === 'offline' ? t('devices.offline') : t('devices.rotate_failed', { msg: errText(e.code, e.message) }));
  }
  if (S.view === 'settings') render();
}

function pairingLink(key, server) {
  const base = location.href.split(/[?#]/)[0];
  const params = new URLSearchParams({ pair: key });
  if (server) params.set('server', server);
  return `${base}#${params}`;
}

async function drawQr(text) {
  const box = $('#qr');
  if (!box) return;
  try {
    if (!window.qrcode) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/qrcode.js';
        s.onload = resolve; s.onerror = reject;
        document.head.append(s);
      });
    }
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    box.firstElementChild?.setAttribute('aria-hidden', 'true');
  } catch {
    box.hidden = true;
  }
}

async function useLanguage(lang) {
  t = await loadI18n('i18n/', lang);
  rtf = new Intl.RelativeTimeFormat(t.lang, { numeric: 'auto', style: 'short' });
  coll = new Intl.Collator(t.lang, { sensitivity: 'base', numeric: true });
  applyI18n(t);
  paintStatus(sync.status);
}

function statusText(st, long = false) {
  const p = st.pending ? t('sync.pending', { n: st.pending }) : '';
  const join = (...a) => a.filter(Boolean).join(' · ');
  switch (st.state) {
    case 'local': return t(long ? 'sync.local_long' : 'sync.local');
    case 'syncing': return t('sync.syncing');
    case 'ok': return p || t('sync.synced', { time: clock(st.lastSync) });
    case 'idle': return join(t('sync.idle'), p);
    case 'offline': return join(t('sync.offline'), p);
    case 'unreachable': return join(t(long ? 'sync.unreachable_long' : 'sync.unreachable'), p);
    case 'error': {
      const msg = st.code && t('sync.' + st.code) !== 'sync.' + st.code ? t('sync.' + st.code) : errText(st.code, st.message);
      return join(long ? t('sync.error_long', { msg }) : t('sync.error'), p);
    }
    default: return st.state;
  }
}

const cloud = (extra) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1-.5 8.5z"/>${extra}</svg>`;
const SYNC_ICON = {
  local: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>',
  ok: cloud('<path d="m9.5 13 2 2 3.5-3.5"/>'),
  syncing: ICON.refresh,
  pending: cloud('<path d="M12 15.5v-5M9.8 12.5 12 10.3l2.2 2.2"/>'),
  offline: cloud('<path d="M3 3l18 18"/>'),
  error: cloud('<path d="M12 10.5v3M12 15.8v.1"/>'),
};
SYNC_ICON.idle = SYNC_ICON.pending; SYNC_ICON.unreachable = SYNC_ICON.offline;

function paintStatus(st) {
  const pill = $('#syncPill');
  pill.dataset.state = st.state === 'ok' && st.pending ? 'pending' : st.state;
  $('.ico', pill).innerHTML = SYNC_ICON[pill.dataset.state] || SYNC_ICON.ok;
  $('.txt', pill).textContent = statusText(st);
  const detail = [statusText(st, true)];
  if (st.lastSync) detail.push(t('sync.last', { when: new Date(st.lastSync).toLocaleString(t.lang) }));
  const hint = t(st.state === 'local' ? 'sync.click_setup' : 'sync.click_sync');
  pill.title = detail.join('\n') + '\n' + hint;
  pill.setAttribute('aria-label', `${statusText(st)} – ${hint}`);
  const d = $('#syncDetail');
  if (d) d.textContent = statusText(st, true);
}

let toastTimer = null;
let toastMs = 0;
let lastUndo = null;
function hideToast() {
  const el = $('#toast');
  // INFO: focus inside the toast would fall back to <body>
  if (el.contains(document.activeElement)) (cardsInView()[Math.max(0, S.kbPos)] || viewHeading() || viewEl).focus({ preventScroll: true });
  el.hidden = true;
}
function armToast() { clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, toastMs); }
function showToast(msg, action, actionLabel) {
  const el = $('#toast');
  const isUndo = action && !actionLabel;
  el.hidden = false;
  // INFO: undo stays available with "u" until the next action, even after the toast is gone
  lastUndo = isUndo ? action : null;
  const label = isUndo ? t('toast.undo') : actionLabel;
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button"${isUndo ? ` aria-keyshortcuts="u" title="${esc(t('toast.undo_key'))}"` : ''}>${esc(label)}</button>` : ''}`;
  if (action) $('button', el).onclick = () => { lastUndo = null; hideToast(); action(); };
  toastMs = action ? 10000 : 4000;
  armToast();
}
['mouseenter', 'focusin'].forEach((ev) => $('#toast').addEventListener(ev, () => clearTimeout(toastTimer)));
['mouseleave', 'focusout'].forEach((ev) => $('#toast').addEventListener(ev, (e) => { if (!$('#toast').contains(e.relatedTarget)) armToast(); }));

// INFO: a text question in the app's own dialog (window.prompt is unstyled and speaks the browser's language)
async function ask({ title, label, value = '' }) {
  const body = `<label class="field"><span>${esc(label)}</span><input type="text" id="askIn" maxlength="80" autocomplete="off" value="${esc(value)}"></label>`;
  const answer = dialog({ title, body, ok: t('settings.save') });
  const input = $('#askIn');
  input.focus();
  input.select();
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#dlgOk').click(); } };
  return (await answer) ? input.value : null;
}

function dialog({ title, body, ok = t('dlg.ok'), cancel = t('dlg.cancel'), danger = false }) {
  const dlg = $('#dlg');
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = body;
  $('#dlgOk').textContent = ok;
  $('#dlgOk').className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  $('#dlgCancel').textContent = cancel;
  $('#dlgCancel').hidden = !cancel;
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
    dlg.returnValue = '';
    dlg.showModal();
  });
}

const VIEWS = ['inbox', 'reading', 'later', 'done', 'dismissed', 'feeds', 'settings'];
function go(view, filter = '', { push = true } = {}) {
  const changed = S.view !== view;
  if (changed || S.filter !== filter) { S.view = view; S.filter = filter; S.shown = PAGE; S.kbId = ''; S.kbPos = -1; S.share = ''; window.scrollTo(0, 0); }
  const url = view === 'inbox' ? location.pathname : `${location.pathname}#${view}`;
  if (push && changed) history.pushState(null, '', url); else history.replaceState(null, '', url);
  render();
  (viewHeading() || viewEl).focus({ preventScroll: true });
}
window.addEventListener('popstate', () => {
  if (readerOpen()) return;
  // INFO: a pairing link opened while the app is already open only changes the hash – strip it the same way
  if (/(^|&)pair=/.test(location.hash.slice(1))) {
    window.nrIncoming = { search: '', hash: location.hash };
    history.replaceState(null, '', location.pathname);
    handleIncoming().then(() => render());
    return;
  }
  const v = location.hash.slice(1) || 'inbox';
  if (VIEWS.includes(v)) go(v, '', { push: false });
});

document.addEventListener('click', async (ev) => {
  const el = ev.target;
  const filterBtn = el.closest('[data-filter]');
  if (filterBtn) return go(S.view, filterBtn.dataset.filter);
  if (el.closest('#feedNavToggle')) {
    feedNavOpen = !feedNavOpen;
    store.set('news.feedNav', feedNavOpen ? '1' : '0');
    return renderFeedNav();
  }
  const fold = el.closest('[data-fold]');
  if (fold) {
    const g = fold.dataset.fold;
    if (closedFolders.has(g)) closedFolders.delete(g); else closedFolders.add(g);
    store.set('news.folders.closed', JSON.stringify([...closedFolders]));
    return renderFeedNav();
  }
  const quiet = el.closest('[data-quiet]');
  if (quiet) {
    const k = quiet.dataset.quiet;
    if (S.quiet.has(k)) S.quiet.delete(k); else S.quiet.add(k);
    return renderFeedNav();
  }
  if (el.closest('#searchBtn')) return openPalette();
  const viewBtn = el.closest('[data-view]');
  if (viewBtn) {
    go(viewBtn.dataset.view);
    // INFO: "Add your first feed" leads straight into the address field
    if (viewBtn.closest('.onboard')) $('#addUrl')?.focus();
    return;
  }

  const cardEl = el.closest('.card');
  if (cardEl) {
    const id = cardEl.dataset.id;
    selectCard(cardEl, false);
    const sumBtn = el.closest('[data-sum]') || (el.closest('.sum.cut, .sum.open') && !getSelection().toString() ? $('[data-sum]', cardEl) : null);
    if (sumBtn) return toggleSum(sumBtn);
    const act = el.closest('[data-act]');
    if (act) {
      const s = act.dataset.act;
      if (s === 'reading') {
        if (openArticle(id) !== 'tab') return;
        if (S.view === 'done') return setState(id, 'reading');
        return markOpened(id);
      }
      return setState(id, s);
    }
    if (el.closest('[data-open]')) {
      if (!navigator.onLine) { ev.preventDefault(); openArticle(id); return; }
      return markOpened(id, { background: ev.ctrlKey || ev.metaKey });
    }
  }
  if (el.closest('[data-more]')) {
    const first = S.shown;
    S.shown += PAGE;
    render();
    return cardsInView()[first]?.focus({ preventScroll: true });
  }
  if (el.closest('[data-refresh]')) return refreshAll(true);
  if (el.closest('[data-reload]')) return location.reload();

  const feedBtn = el.closest('[data-feed-act]');
  if (feedBtn) return feedAction(feedBtn.dataset.feedAct, feedBtn.closest('[data-feed]').dataset.feed);
  const deviceBtn = el.closest('[data-device-act]');
  if (deviceBtn) return deviceAction(deviceBtn.dataset.deviceAct, deviceBtn.closest('[data-device]').dataset.device);

  switch (el.closest('button')?.id) {
    case 'laterAllDone': {
      const ids = itemsIn('later').filter((it) => inFilter(it.feedId)).map((it) => it.id);
      if (!ids.length) return;
      return setState(ids, 'done', { animate: ids.length <= 20, label: t('toast.all_done', { n: ids.length }) });
    }
    case 'clearInbox': {
      const ids = inboxEntries().slice(0, S.shown).map((e) => e.id);
      return setState(ids, 'dismissed', { animate: false });
    }
    case 'clearDone': {
      const ids = itemsIn('done').filter((it) => inFilter(it.feedId)).map((it) => it.id);
      if (!ids.length || !await dialog({ title: t('dlg.clear_done_title'), body: t('dlg.clear_done_body', { n: ids.length }), ok: t('dlg.clear_done_ok'), danger: true })) return;
      // INFO: cleared posts stay "done" (hidden with h:1) – they were read, so the feed's read rate must not drop
      return setState(ids, 'done', { animate: false, extra: { h: 1 }, label: t('toast.cleared', { n: ids.length }) });
    }
    case 'startImport': go('feeds'); return $('#opmlIn')?.click();
    case 'startPair': go('settings'); return $('#joinKey')?.focus();
    case 'opmlPick': return $('#opmlIn').click();
    case 'opmlOut': return exportOpml();
    case 'serverTest': return testServer();
    case 'createVault':
      try {
        await sync.createVault();
      } catch (e) {
        $('#syncResult').innerHTML = errHtml(e);
        return;
      }
      await loadAll();
      return render();
    case 'syncNow': return sync.run();
    case 'rotateKey':
      if (await dialog({ title: t('devices.rotate_title'), body: `<p>${t('devices.rotate_body')}</p>`, ok: t('devices.rotate_ok') })) {
        await rekey(() => sync.rotateKey(), 'devices.rotated');
      }
      return;
    case 'copyLink': {
      const link = pairingLink(await db.kvGet('vaultKey'), await db.kvGet('server'));
      try { await navigator.clipboard.writeText(link); showToast(t('toast.link_copied')); }
      catch { await dialog({ title: t('dlg.link_title'), body: `<textarea rows="4" readonly aria-label="${esc(t('dlg.link_title'))}">${esc(link)}</textarea>`, cancel: '' }); }
      return;
    }
    case 'leaveVault':
      if (await dialog({ title: t('dlg.unpair_title'), body: t('dlg.unpair_body'), ok: t('dlg.unpair_ok') })) {
        await sync.leaveVault(); render();
      }
      return;
    case 'wipeVault':
      if (await dialog({ title: t('dlg.wipe_title'), body: t('dlg.wipe_body'), ok: t('dlg.wipe_ok'), danger: true })) {
        try { await sync.wipeServer(); showToast(t('toast.server_deleted')); } catch (e) { showToast(errText(e.code, e.message)); }
      }
      return;
    case 'resetLocal':
      if (await dialog({ title: t('dlg.reset_title'), body: t('dlg.reset_body'), ok: t('dlg.reset_ok'), danger: true })) {
        indexedDB.deleteDatabase(db.DB_NAME);
        location.replace(location.pathname);
      }
      return;
  }

  if (el.closest('#syncPill')) {
    if (sync.status.state === 'local') return go('settings');
    return sync.run();
  }
  if (el.closest('#refreshBtn')) return refreshAll(true);
});

document.addEventListener('change', async (ev) => {
  const id = ev.target.id;
  if (id === 'filter') { go(S.view, ev.target.value, { push: false }); $('#filter')?.focus(); }
  if (id === 'opmlIn' && ev.target.files[0]) importOpml(ev.target.files[0]);
  if (id === 'langSel') { setLang(ev.target.value); await useLanguage(ev.target.value); render(); }
  if (id === 'themeSel') setTheme(ev.target.value);
  if (id === 'densitySel') setDensity(ev.target.value);
  if (id === 'actsSel') setActs(ev.target.value);
  if (id === 'keysSel') store.set('news.keys', ev.target.value);
  if (id === 'swipeRight' || id === 'swipeLeft') {
    S.swipe = { right: $('#swipeRight').value, left: $('#swipeLeft').value };
    await db.kvSet('swipe', S.swipe);
    showToast(t('toast.saved'));
  }
});

function fieldError(input, out, html) {
  out.innerHTML = html || '';
  if (html) input?.setAttribute('aria-invalid', 'true'); else input?.removeAttribute('aria-invalid');
}

document.addEventListener('submit', async (ev) => {
  const id = ev.target.id;
  if (!['addForm', 'serverForm', 'joinForm'].includes(id)) return;
  ev.preventDefault();
  if (id === 'addForm') {
    const out = $('#addResult');
    const btn = $('button[type="submit"]', ev.target);
    btn.disabled = true;
    fieldError($('#addUrl'), out, '');
    out.innerHTML = t('feeds.asking');
    try {
      const { rec, res } = await addFeed($('#addUrl').value, { quiet: true });
      S.share = '';
      render();
      $('#addResult').innerHTML = `${res.source?.strategy ? strategyPill(res.source.strategy) : ''} ${t('feeds.following', { title: esc(rec.data.title), n: res.entries.length })}`;
    } catch (e) {
      fieldError($('#addUrl'), out, errHtml(e));
    } finally {
      btn.disabled = false;
    }
  }
  if (id === 'serverForm') {
    const v = $('#serverUrl').value.trim();
    if (v) {
      const u = normalizeUrl(v);
      if (!u) { fieldError($('#serverUrl'), $('#serverResult'), `<span class="err">${t('settings.invalid_url')}</span>`); return; }
      await db.kvSet('server', u.endsWith('/') ? u : u + '/');
    } else {
      await db.kvDel('server');
    }
    showToast(t('toast.server_saved'));
    render();
  }
  if (id === 'joinForm') {
    const raw = $('#joinKey').value.trim();
    const parsed = parsePairing(raw);
    if (!parsed) { fieldError($('#joinKey'), $('#syncResult'), `<span class="err">${t('settings.join_invalid')}</span>`); return; }
    await joinVault(parsed);
  }
});

async function feedAction(act, id) {
  const f = S.feeds.get(id);
  if (!f) return;
  if (act === 'refresh') {
    try { await refreshFeed(f, true); } catch (e) { S.fetch.set(id, failState(id, e)); }
    await db.kvSet('fetchState', Object.fromEntries(S.fetch));
    scheduleRetry();
    return render();
  }
  if (act === 'folder') return askFolder(f);
  if (act === 'rename') {
    const name = await ask({ title: t('feeds.rename'), label: t('feeds.rename_prompt'), value: feedTitle(id) });
    if (name === null) return;
    await commit([{ ...f, data: { ...f.data, title: name.trim() || f.data.title }, updatedAt: Date.now() }]);
    return render();
  }
  if (act === 'remove' && await dialog({ title: t('feeds.unfollow_title'), body: `<p>${t('feeds.unfollow_body', { title: esc(f.data.title) })}</p>`, ok: t('feeds.unfollow'), danger: true })) {
    await removeFeed(id);
    showToast(t('toast.feed_removed'));
  }
}

// INFO: free text with the existing folders as suggestions; empty = no folder
async function askFolder(f) {
  const list = folders().map((g) => `<option value="${esc(g)}"></option>`).join('');
  const body = `<p>${t('feeds.folder_text', { title: esc(feedTitle(f.id)) })}</p>
    <input type="text" id="folderIn" list="folderList" maxlength="60" autocomplete="off" value="${esc(f.data.g || '')}" placeholder="${esc(t('feeds.folder_placeholder'))}" aria-label="${esc(t('feeds.folder'))}"><datalist id="folderList">${list}</datalist>`;
  const answer = dialog({ title: t('feeds.folder'), body, ok: t('settings.save') });
  const input = $('#folderIn');
  input.focus();
  input.select();
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#dlgOk').click(); } };
  if (!await answer) return;
  const g = input.value.trim().slice(0, 60);
  const { g: _old, ...data } = f.data;
  if (g) data.g = g;
  await commit([{ ...f, data, updatedAt: Date.now() }]);
  render();
}

async function testServer() {
  const out = $('#serverResult');
  out.textContent = t('settings.testing');
  try {
    const res = await fetch(new URL('api/collect', await serverBase()), { cache: 'no-store' });
    const body = await res.json();
    out.innerHTML = body?.service === 'collector'
      ? esc(t('settings.test_ok', { version: body.version }) + t(body.sync ? 'settings.test_sync_on' : 'settings.test_sync_off'))
      : `<span class="err">${t('settings.test_wrong')}</span>`;
  } catch {
    out.innerHTML = `<span class="err">${t('settings.test_fail')}</span>`;
  }
}

async function importOpml(file) {
  const out = $('#opmlResult');
  let list;
  try { list = parseOpml(await file.text()); } catch { out.innerHTML = `<span class="err">${t('feeds.import_invalid')}</span>`; return; }
  const todo = list.filter((f) => { const u = normalizeUrl(f.url); return u && !(S.feeds.get(feedId(u)) && !S.feeds.get(feedId(u)).data.d); });
  if (!todo.length) { out.textContent = t('feeds.import_nothing', { n: list.length }); return; }
  let done = 0;
  out.textContent = t('feeds.importing', { n: todo.length });
  const results = await pool(todo, FETCH_PARALLEL, async (f) => {
    const r = await addFeed(f.url, { quiet: true, title: f.title, folder: f.folder, later: true, persist: false });
    out.textContent = t('feeds.importing_progress', { done: ++done, n: todo.length });
    return r;
  });
  await db.kvSet('fetchState', Object.fromEntries(S.fetch));
  scheduleRetry();
  const failed = results.map((r, i) => (r.ok ? null : `${todo[i].url}: ${errText(r.error.code, r.error.message, r.error.status)}`)).filter(Boolean);
  render();
  const o = $('#opmlResult');
  if (o) o.innerHTML = `${t('feeds.imported', { ok: todo.length - failed.length, n: todo.length })}${failed.length ? `<br><span class="err">${failed.map(esc).join('<br>')}</span>` : ''}`;
}

function exportOpml() {
  const blob = new Blob([buildOpml(liveFeeds().map((f) => ({ ...f.data, title: feedTitle(f.id) })))], { type: 'text/x-opml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `news-${new Date().toISOString().slice(0, 10)}.opml`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function parsePairing(raw) {
  if (isValidKey(raw)) return { key: raw };
  try {
    const u = new URL(raw);
    const p = new URLSearchParams(u.hash.slice(1));
    const key = p.get('pair');
    if (isValidKey(key)) return { key, server: p.get('server') || '' };
  } catch { /* INFO: not a URL */ }
  return null;
}

async function joinVault({ key, server }) {
  const current = await db.kvGet('vaultKey');
  if (current === key) { showToast(t('toast.already_paired')); return; }
  const ok = await dialog({
    title: t('dlg.pair_title'),
    body: t('dlg.pair_body') + (server ? t('dlg.pair_server', { server: esc(server) }) : '') + (current ? t('dlg.pair_leave') : '') + t('dlg.pair_merge'),
    ok: t('dlg.pair_ok'),
  });
  if (!ok) return;
  if (server) {
    const u = normalizeUrl(server);
    if (u) await db.kvSet('server', u.endsWith('/') ? u : u + '/');
  }
  await sync.joinVault(key);
  await loadAll();
  go('inbox');
  if (sync.status.state !== 'local') showToast(t(sync.status.state === 'ok' ? 'toast.paired_synced' : 'toast.paired_later'));
  refreshAll();
}

function cardsInView() { return $$('.card', viewEl); }

// INFO: if the selected card left the list, the card now at its position takes over
function applyKb() {
  const cards = cardsInView();
  let i = S.kbId ? cards.findIndex((c) => c.dataset.id === S.kbId) : -1;
  if (i < 0 && S.kbId) {
    i = Math.min(S.kbPos, cards.length - 1);
    S.kbId = cards[i]?.dataset.id || '';
  }
  S.kbPos = i;
  cards.forEach((c, j) => c.classList.toggle('kb', j === i));
  return i;
}

// INFO: keyboard selection moves the real focus, so screen readers announce the post and its actions show up
function selectCard(card, scroll = true, focus = scroll) {
  if (!card) return;
  S.kbId = card.dataset.id;
  applyKb();
  if (focus) card.focus({ preventScroll: true });
  if (scroll) card.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 'k' && !readerOpen() && !$('#dlg').open) {
    ev.preventDefault();
    openPalette();
    return;
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing || readerOpen()) return;
  if (ev.target.closest('input, textarea, select, dialog, [contenteditable]') || $('#dlg')?.open || $('#palette')?.open) return;
  const k = ev.key;
  if (getKeys() === 'off' && k.length === 1) return;
  if (k === '/') { ev.preventDefault(); openPalette(); return; }
  if (k === '?') { dialog({ title: t('settings.keyboard'), body: keysHtml(), cancel: '' }); return; }
  if (k === 'v') {
    setDensity(getDensity() === 'compact' ? 'comfortable' : 'compact');
    showToast(t('settings.density_' + getDensity()));
    if (S.view === 'settings') render();
    return;
  }
  if (k === 'Enter' && ev.target.closest('button, a')) return;
  const views = ['inbox', 'reading', 'later', 'done', 'feeds'];
  if (k >= '1' && k <= '5') { go(views[+k - 1]); return; }
  if (k === 'r') { refreshAll(true); return; }
  if (k === 'u' && lastUndo) { const f = lastUndo; lastUndo = null; hideToast(); f(); return; }
  const cards = cardsInView();
  if (!cards.length) return;
  const cur = applyKb();
  if (k === 'Escape' && cur >= 0) { S.kbId = ''; applyKb(); return; }
  if (k === 'j' || (k === 'ArrowDown' && cur >= 0)) { ev.preventDefault(); selectCard(cards[Math.min(cards.length - 1, cur + 1)]); return; }
  if (k === 'k' || (k === 'ArrowUp' && cur >= 0)) { ev.preventDefault(); selectCard(cards[Math.max(0, cur - 1)]); return; }
  const s = { o: 'reading', Enter: 'reading', l: 'later', x: 'dismissed', d: 'done' }[k];
  if (!s || !ACTIONS[S.view]?.some(([a]) => a === s)) return;
  ev.preventDefault();
  const card = cards[cur >= 0 ? cur : 0];
  selectCard(card, false);
  card.querySelector(`[data-act="${s}"]`)?.click();
});

// INFO: search and go to – views, folders and feeds without a query, plus every known post title with one.
//       A post jumps to the view it is in and gets the keyboard selection; dismissed posts open the original.
const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const STATE_VIEW = { new: 'inbox', reading: 'reading', later: 'later', done: 'done', dismissed: 'dismissed' };
let pal = { results: [], sel: 0 };
let corpus = null;

function postCorpus() {
  const posts = new Map();
  for (const e of inboxEntries('')) posts.set(e.id, { id: e.id, title: e.title, summary: e.summary, feedId: e.feedId, url: e.url, time: entryTime(e), s: 'new' });
  for (const r of S.items.values()) {
    if (r.data.s === 'new' || posts.has(r.id)) continue;
    const e = S.entries.get(r.id);
    posts.set(r.id, { id: r.id, title: e?.title || r.data.t || '', summary: e?.summary || '', feedId: e?.feedId || r.data.f, url: e?.url || r.data.u, time: r.updatedAt, s: r.data.s });
  }
  return [...posts.values()].filter((p) => p.title).map((p) => ({ ...p, nt: norm(p.title), ns: norm(p.summary) }));
}

function paletteResults(q) {
  const words = norm(q).split(/\s+/).filter(Boolean);
  const hit = (...xs) => words.every((w) => xs.some((x) => norm(x).includes(w)));
  const out = [];
  for (const v of ['inbox', 'reading', 'later', 'done', 'feeds', 'settings']) {
    const label = t(v === 'settings' ? 'app.settings' : 'nav.' + v);
    if (hit(label)) out.push({ kind: 'view', id: v, label, icon: ICON.view[v] });
  }
  for (const g of folders()) if (hit(g)) out.push({ kind: 'filter', id: 'g:' + g, label: g, sub: t('pal.folder'), icon: ICON.folder });
  for (const f of liveFeeds()) if (hit(feedTitle(f.id), f.data.url)) out.push({ kind: 'filter', id: f.id, label: feedTitle(f.id), sub: host(f.data.url), icon: feedIcon(f.id) });
  if (!words.length) return out;
  corpus ??= postCorpus();
  const found = corpus
    .map((p) => ({ p, title: words.every((w) => p.nt.includes(w)) }))
    .filter(({ p, title }) => title || words.every((w) => p.nt.includes(w) || p.ns.includes(w)))
    .sort((a, b) => (b.title - a.title) || (b.p.time - a.p.time))
    .slice(0, 40)
    .map(({ p }) => p);
  for (const p of found) {
    const where = viewName(STATE_VIEW[p.s] || 'dismissed');
    out.push({ kind: 'post', id: p.id, s: p.s, url: p.url, label: p.title, sub: `${feedTitle(p.feedId) || host(p.url)} · ${where}`, icon: ICON.doc });
  }
  return out;
}

function paintPalette() {
  const q = $('#palIn').value;
  pal = { results: paletteResults(q), sel: 0 };
  const list = $('#palList');
  list.innerHTML = pal.results.length
    ? pal.results.map((r, i) => `<li role="option" id="pal-${i}" data-i="${i}" class="k-${r.kind}" aria-selected="${i === 0}">${r.icon}<span class="pl">${esc(r.label)}</span>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</li>`).join('')
    : `<li class="none" role="presentation">${t('pal.empty')}</li>`;
  if (pal.results.length) $('#palIn').setAttribute('aria-activedescendant', 'pal-0');
  else $('#palIn').removeAttribute('aria-activedescendant');  // INFO: announced politely after typing – the listbox itself is not a live region
  $('#palStatus').textContent = q.trim() ? (pal.results.length ? t('pal.count', { n: pal.results.length }) : t('pal.empty')) : '';
}

function movePalette(d) {
  if (!pal.results.length) return;
  pal.sel = (pal.sel + d + pal.results.length) % pal.results.length;
  $$('#palList [role="option"]').forEach((li, i) => li.setAttribute('aria-selected', String(i === pal.sel)));
  $(`#pal-${pal.sel}`)?.scrollIntoView({ block: 'nearest' });
  $('#palIn').setAttribute('aria-activedescendant', `pal-${pal.sel}`);
}

function openPalette() {
  const d = $('#palette');
  if (d.open) return;
  corpus = null;
  $('#palIn').value = '';
  paintPalette();
  d.showModal();
  $('#palIn').focus();
}

function pickPalette(r) {
  $('#palette').close();
  if (!r) return;
  if (r.kind === 'view') return go(r.id);
  if (r.kind === 'filter') return go('inbox', r.id);
  const view = STATE_VIEW[r.s];
  if (!view) { openUrl(r.url); return; }
  go(view);
  const i = (view === 'inbox' ? inboxEntries() : itemsIn(view)).findIndex((e) => e.id === r.id);
  if (i >= S.shown) S.shown = i + 1;
  S.kbId = r.id;
  render();
  const c = viewEl.querySelector(`.card[data-id="${CSS.escape(r.id)}"]`);
  if (c) selectCard(c); else openUrl(r.url);
}

let palTimer = null;
$('#palIn').addEventListener('input', () => { clearTimeout(palTimer); palTimer = setTimeout(paintPalette, 80); });
$('#palIn').addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); movePalette(ev.key === 'ArrowDown' ? 1 : -1); }
  if (ev.key === 'Enter') { ev.preventDefault(); if (palTimer) { clearTimeout(palTimer); palTimer = null; paintPalette(); } pickPalette(pal.results[pal.sel]); }
  // INFO: in a filled search field, Esc would only clear the text – one press closes the palette
  if (ev.key === 'Escape') { ev.preventDefault(); $('#palette').close(); }
});
$('#palList').addEventListener('click', (ev) => {
  const li = ev.target.closest('[data-i]');
  if (li) pickPalette(pal.results[+li.dataset.i]);
});
$('#palette').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });

let sw = null;
// INFO: logos and portraits are shown whole instead of cropped to 16:9
viewEl.addEventListener('load', (ev) => {
  const img = ev.target;
  if (img instanceof HTMLImageElement && img.classList.contains('thumb') && img.naturalHeight) {
    const r = img.naturalWidth / img.naturalHeight;
    if (r > 2.2 || r < 1.1) img.classList.add('fit');
  }
}, true);

// INFO: a favicon that fails is not requested again this session – the monogram below it stays
document.addEventListener('error', (ev) => {
  const img = ev.target;
  if (img instanceof HTMLImageElement && img.classList.contains('fi-img')) {
    iconFailed.add(img.src);
    img.remove();
  }
}, true);

// INFO: 'error' does not bubble – capture phase
viewEl.addEventListener('error', (ev) => {
  const img = ev.target;
  if (img instanceof HTMLImageElement && img.classList.contains('thumb')) {
    img.closest('.card')?.classList.remove('has-img');
    img.remove();
  }
}, true);

viewEl.addEventListener('pointerdown', (ev) => {
  if (ev.pointerType === 'mouse') return;
  const c = ev.target.closest('.card');
  if (!c || ev.target.closest('button, a')) return;
  sw = { c, x: ev.clientX, y: ev.clientY, dx: 0, active: false };
});
viewEl.addEventListener('pointermove', (ev) => {
  if (!sw) return;
  const dx = ev.clientX - sw.x, dy = ev.clientY - sw.y;
  if (!sw.active) {
    if (Math.abs(dy) > 12) { sw = null; return; }
    if (Math.abs(dx) < 12) return;
    sw.active = true;
    try { sw.c.setPointerCapture(ev.pointerId); } catch { /* INFO: pointer already gone */ }
  }
  const [right, left] = swipeFor(S.view);
  if ((dx > 0 && !right) || (dx < 0 && !left)) return;
  sw.dx = dx;
  sw.c.style.transition = 'none';
  sw.c.style.transform = `translateX(${dx}px)`;
  sw.c.dataset.swipe = dx > 0 ? 'right' : 'left';
  sw.c.style.setProperty('--swipe-o', Math.min(1, Math.abs(dx) / 90));
});
const endSwipe = () => {
  if (!sw) return;
  const { c, dx, active } = sw;
  sw = null;
  if (!active) return;
  c.style.transition = '';
  c.style.transform = '';
  delete c.dataset.swipe;
  const [right, left] = swipeFor(S.view);
  const s = dx > 90 ? right : dx < -90 ? left : null;
  if (!s) return;
  if (s === 'reading') {
    if (openArticle(c.dataset.id) !== 'tab') return;
    if (S.view === 'done') return setState(c.dataset.id, 'reading', { animate: false });
    return markOpened(c.dataset.id);
  }
  setState(c.dataset.id, s, { animate: false });
};
viewEl.addEventListener('pointerup', endSwipe);
viewEl.addEventListener('pointercancel', endSwipe);

// INFO: incoming links – share target, bookmarklet, pairing
// WARNING: the inline script in index.html already moved ?… and #pair=… into window.nrIncoming (keeps keys out of history and screenshots)
async function handleIncoming() {
  const inc = window.nrIncoming || { search: location.search, hash: location.hash };
  delete window.nrIncoming;
  const q = new URLSearchParams(inc.search);
  const shared = q.get('add') || q.get('url') || extractUrl(q.get('text')) || extractUrl(q.get('title'));
  const hash = new URLSearchParams(inc.hash.slice(1));
  const pair = hash.get('pair');
  const view = inc.hash.slice(1);

  if (shared || pair || q.toString()) history.replaceState(null, '', location.pathname);

  if (pair && isValidKey(pair)) {
    await joinVault({ key: pair, server: hash.get('server') || '' });
    return;
  }
  if (shared) {
    S.view = 'feeds';
    S.share = shared;
    return;
  }
  if (VIEWS.includes(view)) S.view = view;
}

sync.addEventListener('status', (e) => {
  paintStatus(e.detail);
  if (e.detail.state === 'ok' && S.view === 'settings') renderDevices();
});
// INFO: stale = a pairing link whose key was changed meanwhile, otherwise this device was removed
sync.addEventListener('removed', (e) => {
  render();
  const k = e.detail?.stale ? 'devices.stale_link' : 'devices.removed_self';
  dialog({ title: t(k + '_title'), body: `<p>${t(k + '_body')}</p>`, cancel: '' });
});
sync.addEventListener('remote', async (e) => {
  const newFeeds = e.detail.filter((r) => r.kind === 'feed' && !r.data.d && !S.feeds.has(r.id));
  const gone = e.detail.filter((r) => r.kind === 'feed' && r.data.d);
  for (const r of gone) await db.deleteEntriesForFeed(r.id);
  await loadAll();
  renderSoft();
  if (e.detail.some((r) => r.kind === 'item')) scheduleOffline();
  if (newFeeds.length) {
    const results = await pool(newFeeds, FETCH_PARALLEL, (r) => refreshFeed(S.feeds.get(r.id)));
    results.forEach((r, i) => { if (!r.ok) S.fetch.set(newFeeds[i].id, failState(newFeeds[i].id, r.error)); });
    await db.kvSet('fetchState', Object.fromEntries(S.fetch));
    renderSoft();
    scheduleRetry();
  }
});

window.addEventListener('focus', () => flushOpened());
document.addEventListener('auxclick', (ev) => {
  if (ev.button !== 1 || !navigator.onLine) return;
  const id = ev.target.closest('[data-open]') && ev.target.closest('.card')?.dataset.id;
  if (id) markOpened(id, { background: true });
});
window.addEventListener('online', () => { sync.run(); scheduleOffline(2000); });
// INFO: offline copies arrive one by one – one redraw for a burst of them
let offlineTimer = null;
offline.addEventListener('change', () => {
  clearTimeout(offlineTimer);
  offlineTimer = setTimeout(() => { if (S.view === 'later' || S.view === 'reading') renderSoft(); }, 400);
});
window.addEventListener('offline', () => sync.run());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  flushOpened();
  sync.run();
  checkUpdate();
  if (Date.now() - S.lastRefresh > AUTO_REFRESH_MS) refreshAll();
  else renderSoft();
});
setInterval(() => { if (document.visibilityState === 'visible') sync.run(); }, 5 * 60 * 1000);

// INFO: iOS resumes an installed app without reloading it, so the browser would only look for a new version on a
//       cold start – the app asks on every return. The new worker takes over at once (skipWaiting + claim) with the
//       new shell cached; the running page keeps the old code until the user reloads.
let swReg = null;
const checkUpdate = () => swReg?.update().catch(() => {});
if ('serviceWorker' in navigator && window.isSecureContext) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || S.updateReady) return;
    S.updateReady = true;
    showToast(t('toast.update_ready'), () => location.reload(), t('toast.reload'));
    if (S.view === 'settings') renderSoft();
  });
  navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }, () => {});
}

// INFO: one hint per device on touch screens – swiping is otherwise invisible
function swipeTip() {
  if (!matchMedia('(pointer: coarse)').matches || store.get('news.tip.swipe') || !cardsInView().length) return;
  const [right, left] = swipeFor(S.view);
  if (!right || !left) return;
  store.set('news.tip.swipe', '1');
  showToast(t('inbox.swipe_tip', { right: t('act.' + right), left: t('act.' + left) }));
}

(async function boot() {
  // INFO: pruning runs before the first load, so pruned records never reach the lists
  const [, failed] = await Promise.all([useLanguage(getLang()), sync.maintain().catch(() => {}).then(() => loadAll()).then(() => null, (e) => e)]);
  if (failed) {
    viewEl.innerHTML = `<div class="empty"><strong>${t('err.storage_title')}</strong>${esc(failed.message)}<br>${t('err.storage_hint')}</div>`;
    return;
  }
  await sync.init();
  render();
  await handleIncoming();
  render();
  offline.load().then(() => { renderSoft(); scheduleOffline(3000); }, () => {});
  sync.run();
  if (Date.now() - S.lastRefresh > AUTO_REFRESH_MS) refreshAll();
  else scheduleRetry();
  swipeTip();
})();
