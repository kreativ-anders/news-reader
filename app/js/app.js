// INFO: item flow   new ──► opened in a new tab ──► done (undo via toast)
//                    ├──► later ──► opened ──► done (offline: reader, done when scrolled to the end)
//                    └──► dismissed        done ──► "read again" ──► reading
//       Feeds and item states are synced records; entries are fetched per device from the Collector.

import * as db from './db.js';
import { Sync, serverBase, defaultServer, isValidKey, cryptoAvailable } from './sync.js';
import { esc, httpUrl, hostOf as host } from './util.js';
import { normalizeUrl, extractUrl, feedId, fetchFeed, pool, parseOpml, buildOpml } from './feeds.js';
import { LANGS, getLang, setLang, loadI18n, applyI18n, getTheme, setTheme, applyTheme } from './i18n.js';
import { OfflineStore, openReader, readerOpen } from './offline.js';

const VERSION = '0.5.3';

const PAGE = 150;
const AUTO_REFRESH_MS = 30 * 60 * 1000;
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
};

let t = (k) => k;
const sync = new Sync();
const offline = new OfflineStore();
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const viewEl = $('#view');

applyTheme();

const ICON = {
  now: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  later: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  offline: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
};

function strategyVar(strategy) {
  if (!strategy) return 'var(--brand)';
  const k = strategy.startsWith('html') ? 'html' : strategy;
  return ['rule', 'direct', 'discovered', 'guessed', 'html', 'sitemap'].includes(k) ? `var(--v-${k})` : 'var(--brand)';
}

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

const entryTime = (e) => Date.parse(e.publishedAt || '') || e.firstSeen || 0;
const liveFeeds = () => [...S.feeds.values()].filter((f) => !f.data.d).sort((a, b) => (a.data.title || a.data.url).localeCompare(b.data.title || b.data.url));
const stateOf = (id) => S.items.get(id)?.data?.s || 'new';
const feedTitle = (id) => { const f = S.feeds.get(id); return f ? (f.data.title || host(f.data.url)) : ''; };

async function loadAll() {
  S.feeds.clear(); S.items.clear(); S.entries.clear();
  for (const r of await db.getAll('records')) {
    if (r.kind === 'feed') S.feeds.set(r.id, r);
    else if (r.kind === 'item') S.items.set(r.id, r);
  }
  for (const e of await db.getAll('entries')) S.entries.set(e.id, e);
  S.lastRefresh = await db.kvGet('lastRefresh', 0);
  Object.entries(await db.kvGet('fetchState', {})).forEach(([k, v]) => S.fetch.set(k, v));
  S.swipe = { ...SWIPE_DEFAULT, ...(await db.kvGet('swipe', {})) };
}

async function commit(records) {
  for (const r of records) (r.kind === 'feed' ? S.feeds : S.items).set(r.id, r);
  await db.putLocal(records);
  sync.schedule();
  if (records.some((r) => r.kind === 'item')) scheduleOffline();
}

const feedUrlOf = (id) => S.feeds.get(id)?.data?.url || '';
const scheduleOffline = (delay) => offline.schedule(() => S.items, feedUrlOf, delay);

function itemRecord(id, s) {
  const e = S.entries.get(id);
  const prev = S.items.get(id)?.data || {};
  const data = { s };
  // INFO: snapshot so "Later" and "Done" stay complete after the entry left the feed
  const title = e?.title ?? prev.t, u = e?.url ?? prev.u, f = e?.feedId ?? prev.f, p = e?.publishedAt ?? prev.p, i = e?.image || prev.i;
  if (title) data.t = title;
  if (u) data.u = u;
  if (f) data.f = f;
  if (p) data.p = p;
  if (i) data.i = i;
  return { kind: 'item', id, data, updatedAt: Date.now() };
}

async function setState(ids, s, { toast = true, animate = true, label = '' } = {}) {
  ids = [].concat(ids);
  const before = ids.map((id) => S.items.get(id) || null);
  if (animate) await leave(ids, s);
  await commit(ids.map((id) => itemRecord(id, s)));
  render();
  if (toast) {
    const what = t(`toast.${s}`);
    showToast(label || (ids.length > 1 ? t('toast.many', { n: ids.length, what }) : what), () => restore(ids, before));
  }
}

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
  const what = t('toast.done');
  showToast(ids.length > 1 ? t('toast.many', { n: ids.length, what }) : what, () => restore(ids, before));
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
  S.fetch.set(feed.id, { at: now, ok: true, strategy: res.source?.strategy, count: fresh.length, stale: !!res.meta?.stale });
  return res;
}

async function refreshAll(force = false) {
  const feeds = liveFeeds();
  if (S.refreshing || !feeds.length) return;
  S.refreshing = true;
  $('#refreshBtn').setAttribute('aria-busy', 'true');
  const results = await pool(feeds, 4, (f) => refreshFeed(f, force));
  let failed = 0;
  results.forEach((r, i) => {
    if (!r.ok) {
      failed++;
      S.fetch.set(feeds[i].id, { ...(S.fetch.get(feeds[i].id) || {}), at: Date.now(), ok: false, error: r.error.message, code: r.error.code });
    }
  });
  S.lastRefresh = Date.now();
  await db.kvSet('lastRefresh', S.lastRefresh);
  await db.kvSet('fetchState', Object.fromEntries(S.fetch));
  S.refreshing = false;
  $('#refreshBtn').removeAttribute('aria-busy');
  render();
  if (failed === feeds.length && results[0]?.error?.code === 'UNREACHABLE') showToast(results[0].error.message);
  else if (failed) showToast(t('toast.refresh_failed', { n: failed }), () => go('feeds'), t('toast.details'));
}

function toEntry(e, feedId, firstSeen) {
  const url = httpUrl(e.url);
  return { id: e.id, feedId, url, title: e.title || url, summary: e.summary || '', image: httpUrl(e.image), publishedAt: e.publishedAt || e.updatedAt || null, firstSeen };
}

const toEntries = (list, feedId, firstSeenOf) => (Array.isArray(list) ? list : [])
  .filter((e) => e && typeof e.id === 'string' && httpUrl(e.url))
  .map((e) => toEntry(e, feedId, firstSeenOf(e.id)));

async function addFeed(input, { quiet = false, title = '' } = {}) {
  const url = normalizeUrl(input);
  if (!url) throw new Error(t('err.invalid_url'));
  const id = feedId(url);
  if (S.feeds.get(id) && !S.feeds.get(id).data.d) throw new Error(t('err.already_following'));
  const res = await fetchFeed(url, { t });
  const now = Date.now();
  const fresh = toEntries(res.entries, id, () => now);
  const times = fresh.map(entryTime).sort((a, b) => b - a);
  const since = Math.min(now - INITIAL_WINDOW_MS, times[Math.min(INITIAL_MIN_ENTRIES, times.length) - 1] ?? Infinity);
  const rec = {
    kind: 'feed', id, updatedAt: now,
    data: { url, title: title || res.source?.title || host(url), since, added: now },
  };
  await commit([rec]);
  await db.putEntries(fresh);
  fresh.forEach((e) => S.entries.set(e.id, e));
  S.fetch.set(id, { at: now, ok: true, strategy: res.source?.strategy, count: fresh.length });
  await db.kvSet('fetchState', Object.fromEntries(S.fetch));
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
  const since = new Map(liveFeeds().map((f) => [f.id, f.data.since || 0]));
  return [...S.entries.values()]
    .filter((e) => since.has(e.feedId) && (stateOf(e.id) === 'new' || lingersIn(e.id, 'inbox')) && (!filter || e.feedId === filter) && entryTime(e) >= since.get(e.feedId))
    .sort((a, b) => entryTime(b) - entryTime(a));
}

function itemsIn(s) {
  return [...S.items.values()]
    .filter((r) => r.data.s === s ? !lingering.has(r.id) || lingersIn(r.id, s) : lingersIn(r.id, s))
    .sort((a, b) => (lingering.get(b.id)?.before?.updatedAt ?? b.updatedAt) - (lingering.get(a.id)?.before?.updatedAt ?? a.updatedAt))
    .map((r) => {
      const e = S.entries.get(r.id);
      return {
        id: r.id,
        url: e?.url || r.data.u,
        title: e?.title || r.data.t || r.data.u || t('untitled'),
        summary: e?.summary || '',
        image: e?.image || r.data.i || '',
        feedId: e?.feedId || r.data.f,
        time: e ? entryTime(e) : Date.parse(r.data.p || '') || 0,
        changed: r.updatedAt,
      };
    });
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
};

// INFO: configured swipe actions [right, left], limited to what the view offers
function swipeFor(view) {
  const allowed = (ACTIONS[view] || []).map(([s]) => s);
  const ok = (s) => (s && s !== 'none' && allowed.includes(s) ? s : null);
  return [ok(S.swipe.right), ok(S.swipe.left)];
}

function card(it, view) {
  const feed = S.feeds.get(it.feedId);
  const strat = S.fetch.get(it.feedId)?.strategy;
  const [right, left] = swipeFor(view);
  const when = view === 'inbox' ? it.time : it.changed;
  const acts = ACTIONS[view].map(([s, label, icon, cls, key]) =>
    `<button type="button" class="act ${cls}" data-act="${s}">${icon}<span>${t(label)}</span><kbd>${key}</kbd></button>`).join('');
  const saved = offline.has(it.id) ? `<span class="offline" title="${esc(t('reader.saved'))}" aria-label="${esc(t('reader.saved'))}">${ICON.offline}</span>` : '';
  const image = httpUrl(it.image);
  const img = image ? `<img class="thumb" src="${esc(image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="112" height="76">` : '';
  return `<li class="card${img ? ' has-img' : ''}${lingering.has(it.id) ? ' opened' : ''}" data-id="${esc(it.id)}" tabindex="-1"${right ? ` data-right="${esc(t('act.' + right))} →" data-right-act="${right}"` : ''}${left ? ` data-left="← ${esc(t('act.' + left))}" data-left-act="${left}"` : ''}>
    <div class="meta"><span class="src" style="--v:${strategyVar(strat)}">${esc(feed ? feedTitle(it.feedId) : host(it.url))}</span>${when ? `<span aria-hidden="true">·</span><time datetime="${new Date(when).toISOString()}">${ago(when)}</time>` : ''}${saved}</div>
    ${img}<h3><a href="${esc(httpUrl(it.url) || '#')}" target="_blank" rel="noopener noreferrer" data-open>${esc(it.title)}</a></h3>
    ${it.summary ? `<p class="sum">${esc(it.summary)}</p>` : ''}
    <div class="acts">${acts}</div>
  </li>`;
}

const badge = (n) => (n ? (n > 999 ? '999+' : String(n)) : '');

function render() {
  if (S.filter && !folderFeeds(S.view).some((f) => f.id === S.filter)) S.filter = '';
  const c = counts();
  $$('[data-count]').forEach((b) => { b.textContent = badge(c[b.dataset.count]); });
  $$('.nav [data-view], .top [data-view]').forEach((b) => {
    if (b.dataset.view === S.view && !(S.view === 'inbox' && S.filter)) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  renderFeedNav();
  document.title = c.inbox ? `(${c.inbox}) News` : 'News';
  if (navigator.setAppBadge) navigator.setAppBadge(c.inbox).catch(() => {});

  const views = { inbox: renderInbox, reading: renderItems, later: renderItems, done: renderItems, feeds: renderFeeds, settings: renderSettings };
  const scroll = window.scrollY;
  views[S.view]();
  window.scrollTo(0, scroll);
  applyKb();
}

const FOLDER_VIEWS = ['inbox', 'reading', 'later', 'done'];
let feedNavOpen = true;
try { feedNavOpen = localStorage.getItem('news.feedNav') !== '0'; } catch { /* INFO: storage blocked (private mode) */ }

function perFeed(view) {
  const m = new Map();
  const ids = view === 'inbox' ? inboxEntries('').map((e) => e.feedId) : itemsIn(view).map((it) => it.feedId);
  for (const id of ids) m.set(id, (m.get(id) || 0) + 1);
  return m;
}

// INFO: outside the inbox, unfollowed feeds with saved items keep their folder
function folderFeeds(view, n = perFeed(view)) {
  const live = liveFeeds();
  if (view === 'inbox' || !FOLDER_VIEWS.includes(view)) return live;
  const liveIds = new Set(live.map((f) => f.id));
  const gone = [...n.keys()]
    .filter((id) => !liveIds.has(id) && S.feeds.has(id))
    .map((id) => S.feeds.get(id))
    .sort((a, b) => feedTitle(a.id).localeCompare(feedTitle(b.id)));
  return [...live, ...gone];
}

function renderFeedNav() {
  const box = $('#feedNav'), toggle = $('#feedNavToggle');
  if (!box || !toggle) return;
  const n = FOLDER_VIEWS.includes(S.view) ? perFeed(S.view) : new Map();
  const feeds = folderFeeds(S.view, n);
  const group = FOLDER_VIEWS.includes(S.view) && feeds.length ? $(`.nav [data-view="${S.view}"]`)?.closest('.nav-group') : null;
  toggle.hidden = !group;
  box.hidden = !group || !feedNavOpen;
  if (!group) return;
  if (toggle.parentElement !== group) group.append(toggle);
  if (box.previousElementSibling !== group) group.after(box);
  toggle.setAttribute('aria-expanded', String(feedNavOpen));
  if (box.hidden) return;
  box.innerHTML = feeds.map((f) => {
    const c = n.get(f.id) || 0;
    const cur = S.filter === f.id ? ' aria-current="page"' : '';
    const cls = [c ? '' : 'zero', f.data.d ? 'gone' : ''].filter(Boolean).join(' ');
    const tip = feedTitle(f.id) + (f.data.d ? ` – ${t('feeds.unfollowed')}` : '');
    return `<button type="button" data-filter="${esc(f.id)}"${cur}${cls ? ` class="${cls}"` : ''} title="${esc(tip)}"><span>${esc(feedTitle(f.id))}</span><b class="badge">${badge(c)}</b></button>`;
  }).join('');
}

// INFO: feed filter for narrow screens, where the sidebar folders are hidden
function filterSelect() {
  const opts = folderFeeds(S.view).map((f) => `<option value="${esc(f.id)}"${S.filter === f.id ? ' selected' : ''}>${esc(feedTitle(f.id))}</option>`).join('');
  return `<select id="filter" aria-label="${esc(t('inbox.filter'))}"><option value="">${t('inbox.all_feeds')}</option>${opts}</select>`;
}

const crumb = () => (S.filter ? `<small class="crumb"> · ${esc(feedTitle(S.filter))}</small>` : '');

function renderInbox() {
  const feeds = liveFeeds();
  if (!feeds.length) {
    viewEl.innerHTML = `<div class="vh"><div><h1>${t('inbox.title')}</h1></div></div>
      <div class="empty"><strong>${t('inbox.empty_title')}</strong>${t('inbox.empty_text')}<br>
      <button class="btn btn-primary" data-view="feeds" type="button">${t('inbox.add_first')}</button></div>`;
    return;
  }
  const all = inboxEntries();
  const list = all.slice(0, S.shown);
  viewEl.innerHTML = `<div class="vh">
      <div><h1>${t('inbox.title')}${crumb()}</h1><p>${all.length ? t('inbox.count', { n: all.length }) : t('inbox.nothing_new')}</p></div>
      <div class="tools">
        ${filterSelect()}
        ${list.length ? `<button class="btn btn-ghost" type="button" id="clearInbox" title="${esc(t('inbox.clear_hint'))}">${t(list.length < all.length ? 'inbox.clear_shown' : 'inbox.clear_all')}</button>` : ''}
      </div></div>
    ${list.length ? `<ol class="list">${list.map((e) => card({ ...e, time: entryTime(e) }, 'inbox')).join('')}</ol>` : `<div class="empty"><strong>${t('inbox.zero')}</strong>${S.lastRefresh ? t('inbox.last_checked', { when: ago(S.lastRefresh) }) : ''}<br><button class="btn btn-ghost" type="button" data-refresh>${t('inbox.check')}</button></div>`}
    ${all.length > list.length ? `<div class="more"><button class="btn btn-ghost" type="button" data-more>${t('inbox.more', { n: all.length - list.length })}</button></div>` : ''}`;
}

function renderItems() {
  const v = `views.${S.view}`;
  let list = itemsIn(S.view).filter((it) => !S.filter || it.feedId === S.filter);
  if (S.view === 'done') list = list.slice(0, 300);
  const clear = S.view === 'done' && list.length
    ? `<button class="btn btn-danger" type="button" id="clearDone">${ICON.trash}<span>${t('views.done.clear')}</span></button>`
    : S.view === 'later' && list.length
      ? `<button class="btn btn-ghost" type="button" id="laterAllDone">${ICON.done}<span>${t('views.later.all_done')}</span></button>` : '';
  const hasFolders = folderFeeds(S.view).length > 0;
  const tools = hasFolders || clear ? `<div class="tools">${hasFolders ? filterSelect() : ''}${clear}</div>` : '';
  viewEl.innerHTML = `<div class="vh"><div><h1>${t(v + '.title')}${crumb()}</h1><p>${t(v + '.text')}</p></div>${tools}</div>
    ${list.length ? `<ol class="list">${list.map((it) => card(it, S.view)).join('')}</ol>` : `<div class="empty"><strong>${t(v + '.empty')}</strong>${t(v + '.hint')}</div>`}`;
}

function renderFeeds() {
  const feeds = liveFeeds();
  const app = location.href.split(/[?#]/)[0];
  const bookmarklet = `javascript:location.href=${JSON.stringify(app + '?add=')}+encodeURIComponent(location.href)`;
  const rows = feeds.map((f) => {
    const st = S.fetch.get(f.id) || {};
    const unread = [...S.entries.values()].filter((e) => e.feedId === f.id && stateOf(e.id) === 'new' && entryTime(e) >= (f.data.since || 0)).length;
    const name = esc(f.data.title);
    return `<div class="feedrow" data-feed="${esc(f.id)}">
      <div class="t">${esc(f.data.title || f.data.url)}</div>
      <div class="u">${esc(f.data.url)}</div>
      <div class="st">${st.strategy ? `<span class="pill" style="--v:${strategyVar(st.strategy)}">${esc(st.strategy)}</span>` : ''}
        <span>${t('feeds.new', { n: unread })}</span>${st.at ? `<span>${t('feeds.checked', { when: ago(st.at) })}</span>` : ''}${st.ok === false ? `<span class="err">· ${esc(st.error)}</span>` : ''}${st.stale ? `<span>${t('feeds.stale')}</span>` : ''}</div>
      <div class="ops">
        <button class="icon-btn" type="button" data-feed-act="refresh" title="${esc(t('feeds.refresh'))}" aria-label="${esc(t('feeds.refresh'))}: ${name}">${ICON.refresh}</button>
        <button class="icon-btn" type="button" data-feed-act="rename" title="${esc(t('feeds.rename'))}" aria-label="${esc(t('feeds.rename'))}: ${name}">${ICON.edit}</button>
        <button class="icon-btn" type="button" data-feed-act="remove" title="${esc(t('feeds.unfollow'))}" aria-label="${esc(t('feeds.unfollow'))}: ${name}">${ICON.trash}</button>
      </div></div>`;
  }).join('');
  viewEl.innerHTML = `<div class="vh"><div><h1>${t('feeds.title')}</h1><p>${t('feeds.count', { n: feeds.length })}</p></div></div>
    <section class="panel">
      <h2>${t('feeds.follow_title')}</h2>
      <p>${t('feeds.follow_text')}</p>
      <form class="row" id="addForm"><input type="url" id="addUrl" inputmode="url" autocomplete="url" placeholder="https://example.com/blog" required aria-label="${esc(t('feeds.url_label'))}"><button class="btn btn-primary" type="submit">${t('feeds.follow')}</button></form>
      <div class="result" id="addResult" aria-live="polite"></div>
    </section>
    <section class="panel">
      <h2>${t('feeds.yours')}</h2>
      ${rows || `<p class="hint">${t('feeds.none')}</p>`}
    </section>
    <section class="panel">
      <h2>${t('feeds.io_title')}</h2>
      <p>${t('feeds.io_text')} <a class="btn btn-ghost" href="${esc(bookmarklet)}" onclick="return false">+ News</a></p>
      <div class="row"><label class="btn btn-ghost">${t('feeds.import')}<input type="file" id="opmlIn" accept=".opml,.xml,text/xml,application/xml" hidden></label><button class="btn btn-ghost" type="button" id="opmlOut"${feeds.length ? '' : ' disabled'}>${t('feeds.export')}</button></div>
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
  viewEl.innerHTML = `<div class="vh"><div><h1>${t('settings.title')}</h1><p>${t('settings.subtitle', { version: VERSION })}</p></div></div>
    <section class="panel">
      <h2>${t('settings.look_title')}</h2>
      <div class="grid2">
        <label class="field"><span>${t('settings.language')}</span><select id="langSel">${Object.entries(LANGS).map(([k, v]) => opt(k, v, t.lang)).join('')}</select></label>
        <label class="field"><span>${t('settings.theme')}</span><select id="themeSel">${['auto', 'light', 'dark'].map((m) => opt(m, t('settings.theme_' + m), getTheme())).join('')}</select></label>
      </div>
    </section>
    <section class="panel">
      <h2>${t('settings.swipe_title')}</h2>
      <p>${t('settings.swipe_text')}</p>
      <div class="grid2">
        <label class="field"><span>${t('settings.swipe_right')}</span><select id="swipeRight">${swipeOpts(S.swipe.right)}</select></label>
        <label class="field"><span>${t('settings.swipe_left')}</span><select id="swipeLeft">${swipeOpts(S.swipe.left)}</select></label>
      </div>
    </section>
    <section class="panel">
      <h2>${t('settings.server_title')}</h2>
      <p>${t('settings.server_text')}</p>
      <form class="row" id="serverForm"><input type="url" id="serverUrl" value="${esc(custom || '')}" placeholder="${esc(defaultServer())}" aria-label="${esc(t('settings.server_label'))}"><button class="btn btn-ghost" type="submit">${t('settings.save')}</button><button class="btn btn-ghost" type="button" id="serverTest">${t('settings.test')}</button></form>
      <div class="result" id="serverResult" aria-live="polite"></div>
    </section>
    <section class="panel" id="syncPanel">
      <h2>${t('settings.sync_title')}</h2>
      ${key ? `
        <p>${t('settings.sync_paired')}</p>
        <div class="qr" id="qr" aria-label="${esc(t('settings.qr_label'))}"></div>
        <div class="row">
          <button class="btn btn-primary" type="button" id="syncNow">${t('settings.sync_now')}</button>
          <button class="btn btn-ghost" type="button" id="copyLink">${t('settings.copy_link')}</button>
          <button class="btn btn-ghost" type="button" id="leaveVault">${t('settings.unpair')}</button>
          <button class="btn btn-danger" type="button" id="wipeVault">${t('settings.wipe')}</button>
        </div>
        <dl class="kv" style="margin-top:14px"><dt>${t('settings.server')}</dt><dd>${esc(new URL('api/sync', server).href)}</dd><dt>${t('settings.status')}</dt><dd id="syncDetail">${esc(statusText(sync.status, true))}</dd></dl>`
      : `
        <p>${t('settings.sync_intro')}</p>${cryptoAvailable() ? '' : `<p class="err">${t('settings.sync_https')}</p>`}
        <div class="row"><button class="btn btn-primary" type="button" id="createVault">${t('settings.create_vault')}</button></div>
        <h2 style="margin-top:20px">${t('settings.join_title')}</h2>
        <p>${t('settings.join_text')}</p>
        <form class="row" id="joinForm"><input type="text" id="joinKey" placeholder="${esc(t('settings.join_placeholder'))}" autocomplete="off" aria-label="${esc(t('settings.join_placeholder'))}"><button class="btn btn-ghost" type="submit">${t('settings.join')}</button></form>`}
      <div class="result" id="syncResult" aria-live="polite"></div>
    </section>
    ${key ? `<section class="panel" id="devicesPanel">
      <h2>${t('devices.title')}</h2>
      <p>${t('devices.text')}</p>
      <div id="devices"></div>
      <div class="row"><button class="btn btn-ghost" type="button" id="rotateKey">${t('devices.rotate')}</button></div>
    </section>` : ''}
    <section class="panel">
      <h2>${t('settings.keyboard')}</h2>
      <ul class="keys">
        <li><kbd>j</kbd><kbd>k</kbd>${t('settings.key_jk')}</li>
        <li><kbd>o</kbd>${t('settings.key_o')}</li>
        <li><kbd>l</kbd>${t('settings.key_l')}</li>
        <li><kbd>x</kbd>${t('settings.key_x')}</li>
        <li><kbd>d</kbd>${t('settings.key_d')}</li>
        <li><kbd>u</kbd>${t('settings.key_u')}</li>
        <li><kbd>r</kbd>${t('settings.key_r')}</li>
        <li><kbd>1</kbd>–<kbd>5</kbd>${t('settings.key_num')}</li>
      </ul>
    </section>
    <section class="panel">
      <h2>${t('settings.local_title')}</h2>
      <p>${t('settings.local_text', { feeds: S.feeds.size, items: S.items.size, entries: S.entries.size })}</p>
      <div class="row"><button class="btn btn-danger" type="button" id="resetLocal">${t('settings.reset')}</button></div>
    </section>`;
  if (key) {
    drawQr(pairLink);
    renderDevices();
  }
}

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
      <div class="t">${name}${self ? ` <span class="pill" style="--v:var(--v-direct)">${t('devices.this')}</span>` : ''}</div>
      ${d.data.platform !== d.data.name ? `<div class="u">${esc(d.data.platform)}</div>` : ''}
      <div class="st"><span>${self ? t('devices.active_now') : t('devices.seen', { when: ago(d.data.seen) })}</span>${since ? `<span>· ${t('devices.since', { date: since })}</span>` : ''}</div>
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
    const name = prompt(t('devices.rename_prompt'), d.data.name || '');
    if (name === null || !name.trim()) return;
    await sync.renameDevice(id, name);
    return renderDevices();
  }
  if (act !== 'remove') return;
  const keyless = (await sync.devices()).filter((x) => x.id !== id && !x.data.pub).length;
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
    showToast(e.code === 'offline' ? t('devices.offline') : t('devices.rotate_failed', { msg: e.message }));
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
  } catch {
    box.hidden = true;
  }
}

async function useLanguage(lang) {
  t = await loadI18n('i18n/', lang);
  rtf = new Intl.RelativeTimeFormat(t.lang, { numeric: 'auto', style: 'short' });
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
      const msg = st.code && t('sync.' + st.code) !== 'sync.' + st.code ? t('sync.' + st.code) : st.message;
      return join(long ? t('sync.error_long', { msg }) : t('sync.error'), p);
    }
    default: return st.state;
  }
}

function paintStatus(st) {
  const pill = $('#syncPill');
  pill.dataset.state = st.state === 'ok' && st.pending ? 'pending' : st.state;
  $('.txt', pill).textContent = statusText(st);
  const detail = [statusText(st, true)];
  if (st.lastSync) detail.push(t('sync.last', { when: new Date(st.lastSync).toLocaleString(t.lang) }));
  pill.title = detail.join('\n') + '\n' + t(st.state === 'local' ? 'sync.click_setup' : 'sync.click_sync');
  const d = $('#syncDetail');
  if (d) d.textContent = statusText(st, true);
}

let toastTimer = null;
let lastUndo = null;
function showToast(msg, action, actionLabel) {
  const el = $('#toast');
  const isUndo = action && !actionLabel;
  actionLabel = actionLabel || t('toast.undo');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  el.hidden = false;
  lastUndo = isUndo ? action : null;
  if (action) $('button', el).onclick = () => { el.hidden = true; lastUndo = null; action(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; lastUndo = null; }, action ? 6000 : 3500);
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

function go(view, filter = '') {
  if (S.view !== view || S.filter !== filter) { S.view = view; S.filter = filter; S.shown = PAGE; S.kbId = ''; S.kbPos = -1; S.share = ''; window.scrollTo(0, 0); }
  history.replaceState(null, '', view === 'inbox' ? location.pathname : `${location.pathname}#${view}`);
  render();
  viewEl.focus({ preventScroll: true });
}

document.addEventListener('click', async (ev) => {
  const el = ev.target;
  const filterBtn = el.closest('[data-filter]');
  if (filterBtn) return go(S.view, filterBtn.dataset.filter);
  if (el.closest('#feedNavToggle')) {
    feedNavOpen = !feedNavOpen;
    try { localStorage.setItem('news.feedNav', feedNavOpen ? '1' : '0'); } catch { /* INFO: storage blocked */ }
    return render();
  }
  const viewBtn = el.closest('[data-view]');
  if (viewBtn) return go(viewBtn.dataset.view);

  const cardEl = el.closest('.card');
  if (cardEl) {
    const id = cardEl.dataset.id;
    selectCard(cardEl, false);
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
  if (el.closest('[data-more]')) { S.shown += PAGE; return render(); }
  if (el.closest('[data-refresh]')) return refreshAll(true);

  const feedBtn = el.closest('[data-feed-act]');
  if (feedBtn) return feedAction(feedBtn.dataset.feedAct, feedBtn.closest('[data-feed]').dataset.feed);
  const deviceBtn = el.closest('[data-device-act]');
  if (deviceBtn) return deviceAction(deviceBtn.dataset.deviceAct, deviceBtn.closest('[data-device]').dataset.device);

  switch (el.closest('button')?.id) {
    case 'laterAllDone': {
      const ids = itemsIn('later').filter((it) => !S.filter || it.feedId === S.filter).map((it) => it.id);
      if (!ids.length) return;
      return setState(ids, 'done', { animate: ids.length <= 20, label: t('toast.all_done', { n: ids.length }) });
    }
    case 'clearInbox': {
      const ids = inboxEntries().slice(0, S.shown).map((e) => e.id);
      return setState(ids, 'dismissed', { animate: false });
    }
    case 'clearDone': {
      const ids = itemsIn('done').filter((it) => !S.filter || it.feedId === S.filter).map((it) => it.id);
      if (!ids.length || !await dialog({ title: t('dlg.clear_done_title'), body: t('dlg.clear_done_body', { n: ids.length }), ok: t('dlg.clear_done_ok'), danger: true })) return;
      return setState(ids, 'dismissed', { animate: false, label: t('toast.cleared', { n: ids.length }) });
    }
    case 'opmlOut': return exportOpml();
    case 'serverTest': return testServer();
    case 'createVault':
      await sync.createVault();
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
      catch { await dialog({ title: t('dlg.link_title'), body: `<textarea rows="4" readonly>${esc(link)}</textarea>`, cancel: '' }); }
      return;
    }
    case 'leaveVault':
      if (await dialog({ title: t('dlg.unpair_title'), body: t('dlg.unpair_body'), ok: t('dlg.unpair_ok') })) {
        await sync.leaveVault(); render();
      }
      return;
    case 'wipeVault':
      if (await dialog({ title: t('dlg.wipe_title'), body: t('dlg.wipe_body'), ok: t('dlg.wipe_ok'), danger: true })) {
        try { await sync.wipeServer(); showToast(t('toast.server_deleted')); } catch (e) { showToast(e.message); }
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
  if (id === 'filter') go(S.view, ev.target.value);
  if (id === 'opmlIn' && ev.target.files[0]) importOpml(ev.target.files[0]);
  if (id === 'langSel') { setLang(ev.target.value); await useLanguage(ev.target.value); render(); }
  if (id === 'themeSel') setTheme(ev.target.value);
  if (id === 'swipeRight' || id === 'swipeLeft') {
    S.swipe = { right: $('#swipeRight').value, left: $('#swipeLeft').value };
    await db.kvSet('swipe', S.swipe);
    showToast(t('toast.saved'));
  }
});

document.addEventListener('submit', async (ev) => {
  const id = ev.target.id;
  if (!['addForm', 'serverForm', 'joinForm'].includes(id)) return;
  ev.preventDefault();
  if (id === 'addForm') {
    const out = $('#addResult');
    const btn = $('button[type="submit"]', ev.target);
    btn.disabled = true;
    out.innerHTML = t('feeds.asking');
    try {
      const { rec, res } = await addFeed($('#addUrl').value, { quiet: true });
      S.share = '';
      render();
      $('#addResult').innerHTML = `<span class="pill" style="--v:${strategyVar(res.source?.strategy)}">${esc(res.source?.strategy)}</span> ${t('feeds.following', { title: esc(rec.data.title), n: res.entries.length })}`;
    } catch (e) {
      out.innerHTML = `<span class="err">${esc(e.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  }
  if (id === 'serverForm') {
    const v = $('#serverUrl').value.trim();
    if (v) {
      const u = normalizeUrl(v);
      if (!u) { $('#serverResult').innerHTML = `<span class="err">${t('settings.invalid_url')}</span>`; return; }
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
    if (!parsed) { $('#syncResult').innerHTML = `<span class="err">${t('settings.join_invalid')}</span>`; return; }
    await joinVault(parsed);
  }
});

async function feedAction(act, id) {
  const f = S.feeds.get(id);
  if (!f) return;
  if (act === 'refresh') {
    try { await refreshFeed(f, true); } catch (e) { S.fetch.set(id, { ...(S.fetch.get(id) || {}), at: Date.now(), ok: false, error: e.message }); }
    await db.kvSet('fetchState', Object.fromEntries(S.fetch));
    return render();
  }
  if (act === 'rename') {
    const name = prompt(t('feeds.rename_prompt'), f.data.title || '');
    if (name === null) return;
    await commit([{ ...f, data: { ...f.data, title: name.trim() || f.data.title }, updatedAt: Date.now() }]);
    return render();
  }
  if (act === 'remove' && await dialog({ title: t('feeds.unfollow_title'), body: `<p>${t('feeds.unfollow_body', { title: esc(f.data.title) })}</p>`, ok: t('feeds.unfollow'), danger: true })) {
    await removeFeed(id);
    showToast(t('toast.feed_removed'));
  }
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
  const results = await pool(todo, 3, async (f) => {
    const r = await addFeed(f.url, { quiet: true, title: f.title });
    out.textContent = t('feeds.importing_progress', { done: ++done, n: todo.length });
    return r;
  });
  const failed = results.map((r, i) => (r.ok ? null : `${todo[i].url}: ${r.error.message}`)).filter(Boolean);
  render();
  const o = $('#opmlResult');
  if (o) o.innerHTML = `${t('feeds.imported', { ok: todo.length - failed.length, n: todo.length })}${failed.length ? `<br><span class="err">${failed.map(esc).join('<br>')}</span>` : ''}`;
}

function exportOpml() {
  const blob = new Blob([buildOpml(liveFeeds().map((f) => f.data))], { type: 'text/x-opml' });
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

function selectCard(card, scroll = true) {
  if (!card) return;
  S.kbId = card.dataset.id;
  applyKb();
  if (scroll) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

document.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing || readerOpen()) return;
  if (ev.target.closest('input, textarea, select, dialog, [contenteditable]') || $('#dlg')?.open) return;
  const k = ev.key;
  if (k === 'Enter' && ev.target.closest('button, a')) return;
  const views = ['inbox', 'reading', 'later', 'done', 'feeds'];
  if (k >= '1' && k <= '5') { go(views[+k - 1]); return; }
  if (k === 'r') { refreshAll(true); return; }
  if (k === 'u' && lastUndo) { const f = lastUndo; lastUndo = null; $('#toast').hidden = true; f(); return; }
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

let sw = null;
// INFO: logos and portraits are shown whole instead of cropped to 16:9
viewEl.addEventListener('load', (ev) => {
  const img = ev.target;
  if (img instanceof HTMLImageElement && img.classList.contains('thumb') && img.naturalHeight) {
    const r = img.naturalWidth / img.naturalHeight;
    if (r > 2.2 || r < 1.1) img.classList.add('fit');
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
async function handleIncoming() {
  const q = new URLSearchParams(location.search);
  const shared = q.get('add') || q.get('url') || extractUrl(q.get('text')) || extractUrl(q.get('title'));
  const hash = new URLSearchParams(location.hash.slice(1));
  const pair = hash.get('pair');
  const view = location.hash.slice(1);

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
  if (['reading', 'later', 'done', 'feeds', 'settings'].includes(view)) S.view = view;
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
  await loadAll();
  for (const r of gone) await db.deleteEntriesForFeed(r.id);
  if (gone.length) await loadAll();
  render();
  if (e.detail.some((r) => r.kind === 'item')) scheduleOffline();
  if (newFeeds.length) {
    await pool(newFeeds, 4, (r) => refreshFeed(S.feeds.get(r.id)));
    await db.kvSet('fetchState', Object.fromEntries(S.fetch));
    render();
  }
});

window.addEventListener('focus', () => flushOpened());
document.addEventListener('auxclick', (ev) => {
  if (ev.button !== 1 || !navigator.onLine) return;
  const id = ev.target.closest('[data-open]') && ev.target.closest('.card')?.dataset.id;
  if (id) markOpened(id, { background: true });
});
window.addEventListener('online', () => { sync.run(); scheduleOffline(2000); });
offline.addEventListener('change', () => { if (S.view === 'later' || S.view === 'reading') render(); });
window.addEventListener('offline', () => sync.run());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  flushOpened();
  sync.run();
  if (Date.now() - S.lastRefresh > AUTO_REFRESH_MS) refreshAll();
  else render();
});
setInterval(() => { if (document.visibilityState === 'visible') sync.run(); }, 5 * 60 * 1000);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

(async function boot() {
  await useLanguage(getLang());
  try {
    await loadAll();
  } catch (e) {
    viewEl.innerHTML = `<div class="empty"><strong>${t('err.storage_title')}</strong>${esc(e.message)}<br>${t('err.storage_hint')}</div>`;
    return;
  }
  await offline.load().catch(() => {});
  await sync.init();
  render();
  await handleIncoming();
  render();
  sync.run();
  if (Date.now() - S.lastRefresh > AUTO_REFRESH_MS) refreshAll();
  scheduleOffline(3000);
})();
