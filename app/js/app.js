// News – a calm, local-first feed reader (News Reader project).
//
// Item flow:   new ──► reading ("read now") ──► done
//               │  └─► later ──► reading ──► done
//               └────► dismissed ("not interested")
//
// Feeds and item states are records {kind, id, data, updatedAt} in IndexedDB,
// synced end-to-end encrypted via <server>/api/sync (last write wins). Entries
// themselves are never synced – every device fetches them from the Collector.
//
// UI strings: app/i18n/<lang>.json (English is the fallback per key), see js/i18n.js.

import * as db from './db.js';
import { Sync, serverBase, defaultServer, isValidKey, cryptoAvailable } from './sync.js';
import { DB_NAME } from './db.js';
import { normalizeUrl, extractUrl, feedId, fetchFeed, pool, parseOpml, buildOpml } from './feeds.js';
import { LANGS, getLang, setLang, loadI18n, applyI18n, getTheme, setTheme, applyTheme } from './i18n.js';

export const VERSION = '0.4.0';

const PAGE = 150;
const AUTO_REFRESH_MS = 30 * 60 * 1000;   // refetch feeds when older than 30 min (the Collector caches 24 h)
const INITIAL_WINDOW_MS = 14 * 864e5;      // a new subscription shows entries of the last 14 days
const KEEP_UNSEEN_MS = 30 * 864e5;         // unseen entries that left the feed are kept 30 days
const SWIPE_DEFAULT = { right: 'later', left: 'dismissed' };
const SWIPE_CHOICES = ['later', 'dismissed', 'done', 'reading', 'none'];

const S = {
  view: 'inbox',
  feeds: new Map(),   // id → record
  items: new Map(),   // entry id → record
  entries: new Map(), // entry id → entry
  fetch: new Map(),   // feed id → { at, ok, error, strategy, count }
  filter: '',
  shown: PAGE,
  refreshing: false,
  kb: -1,
  lastRefresh: 0,
  share: '',          // URL received via share sheet / bookmarklet, prefilled in "Follow"
  swipe: { ...SWIPE_DEFAULT }, // per device (IndexedDB kv), not synced
};

let t = (k) => k;     // replaced by loadI18n() at boot
const sync = new Sync();
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const viewEl = $('#view');

applyTheme();

// ------------------------------------------------------------ helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  now: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  later: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
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
  return ['direct', 'discovered', 'guessed', 'html', 'sitemap'].includes(k) ? `var(--v-${k})` : 'var(--brand)';
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
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const feedTitle = (id) => { const f = S.feeds.get(id); return f ? (f.data.title || host(f.data.url)) : ''; };

// ------------------------------------------------------------ data

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

/** Local write → memory, IndexedDB + outbox, then sync. */
async function commit(records) {
  for (const r of records) (r.kind === 'feed' ? S.feeds : S.items).set(r.id, r);
  await db.putLocal(records);
  sync.schedule();
}

function itemRecord(id, s) {
  const e = S.entries.get(id);
  const prev = S.items.get(id)?.data || {};
  const data = { s };
  // snapshot so "Later" & "Done" stay complete after the entry left the feed
  const title = e?.title ?? prev.t, u = e?.url ?? prev.u, f = e?.feedId ?? prev.f, p = e?.publishedAt ?? prev.p;
  if (title) data.t = title;
  if (u) data.u = u;
  if (f) data.f = f;
  if (p) data.p = p;
  return { kind: 'item', id, data, updatedAt: Date.now() };
}

async function setState(ids, s, { toast = true, animate = true } = {}) {
  ids = [].concat(ids);
  const before = ids.map((id) => S.items.get(id) || null);
  if (animate) await leave(ids, s);
  await commit(ids.map((id) => itemRecord(id, s)));
  render();
  if (toast) {
    const what = t(`toast.${s}`);
    showToast(ids.length > 1 ? t('toast.many', { n: ids.length, what }) : what, async () => {
      const now = Date.now();
      await commit(ids.map((id, i) => {
        const prev = before[i];
        return prev ? { ...prev, updatedAt: now } : { ...itemRecord(id, 'new'), updatedAt: now };
      }));
      render();
    });
  }
}

async function leave(ids, s) {
  const cards = ids.map((id) => viewEl.querySelector(`.card[data-id="${CSS.escape(id)}"]`)).filter(Boolean);
  if (!cards.length || cards.length > 20) return;
  const dir = s === 'dismissed' ? '-40px' : '40px';
  cards.forEach((c) => { c.style.setProperty('--leave', dir); c.classList.add('leaving'); });
  await new Promise((r) => setTimeout(r, 160));
}

function openUrl(url) {
  if (url) window.open(url, '_blank', 'noopener');
}

const urlOf = (id) => S.entries.get(id)?.url || S.items.get(id)?.data?.u;

// ------------------------------------------------------------ feeds

async function refreshFeed(feed, force = false) {
  const res = await fetchFeed(feed.data.url, { refresh: force, t });
  const now = Date.now();
  const existing = await db.entriesForFeed(feed.id);
  const known = new Map(existing.map((e) => [e.id, e]));
  const fresh = res.entries.map((e) => ({
    id: e.id,
    feedId: feed.id,
    url: e.url,
    title: e.title || e.url,
    summary: e.summary || '',
    publishedAt: e.publishedAt || e.updatedAt || null,
    firstSeen: known.get(e.id)?.firstSeen || now,
  }));
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

async function addFeed(input, { quiet = false, title = '' } = {}) {
  const url = normalizeUrl(input);
  if (!url) throw new Error(t('err.invalid_url'));
  const id = feedId(url);
  if (S.feeds.get(id) && !S.feeds.get(id).data.d) throw new Error(t('err.already_following'));
  const res = await fetchFeed(url, { t });
  const now = Date.now();
  const rec = {
    kind: 'feed', id, updatedAt: now,
    data: { url, title: title || res.source?.title || host(url), since: now - INITIAL_WINDOW_MS, added: now },
  };
  await commit([rec]);
  // store the entries we already have
  const fresh = res.entries.map((e) => ({ id: e.id, feedId: id, url: e.url, title: e.title || e.url, summary: e.summary || '', publishedAt: e.publishedAt || e.updatedAt || null, firstSeen: now }));
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

// ------------------------------------------------------------ lists

function inboxEntries() {
  const since = new Map(liveFeeds().map((f) => [f.id, f.data.since || 0]));
  return [...S.entries.values()]
    .filter((e) => since.has(e.feedId) && stateOf(e.id) === 'new' && (!S.filter || e.feedId === S.filter) && entryTime(e) >= since.get(e.feedId))
    .sort((a, b) => entryTime(b) - entryTime(a));
}

function itemsIn(s) {
  return [...S.items.values()]
    .filter((r) => r.data.s === s)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((r) => {
      const e = S.entries.get(r.id);
      return {
        id: r.id,
        url: e?.url || r.data.u,
        title: e?.title || r.data.t || r.data.u || t('untitled'),
        summary: e?.summary || '',
        feedId: e?.feedId || r.data.f,
        time: e ? entryTime(e) : Date.parse(r.data.p || '') || 0,
        changed: r.updatedAt,
      };
    });
}

function counts() {
  const c = { inbox: inboxEntries().length, reading: 0, later: 0 };
  for (const r of S.items.values()) if (r.data.s === 'reading' || r.data.s === 'later') c[r.data.s]++;
  return c;
}

// [target state, label key, icon, css class, keyboard key]
const ACTIONS = {
  inbox: [['reading', 'act.reading', ICON.now, 'main', 'o'], ['later', 'act.later', ICON.later, '', 'l'], ['dismissed', 'act.dismissed', ICON.x, 'x', 'x']],
  reading: [['done', 'act.done', ICON.done, 'main', 'd'], ['later', 'act.later', ICON.later, '', 'l'], ['dismissed', 'act.drop', ICON.x, 'x', 'x']],
  later: [['reading', 'act.reading', ICON.now, 'main', 'o'], ['done', 'act.done', ICON.done, '', 'd'], ['dismissed', 'act.remove', ICON.x, 'x', 'x']],
  done: [['reading', 'act.again', ICON.back, '', 'o'], ['later', 'act.later', ICON.later, '', 'l']],
};

/** Configured swipe actions, limited to what the current view offers: [right, left]. */
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
  return `<li class="card" data-id="${esc(it.id)}" tabindex="-1"${right ? ` data-right="${esc(t('act.' + right))} →" data-right-act="${right}"` : ''}${left ? ` data-left="← ${esc(t('act.' + left))}" data-left-act="${left}"` : ''}>
    <div class="meta"><span class="src" style="--v:${strategyVar(strat)}">${esc(feed ? feedTitle(it.feedId) : host(it.url))}</span>${when ? `<span aria-hidden="true">·</span><time datetime="${new Date(when).toISOString()}">${ago(when)}</time>` : ''}</div>
    <h3><a href="${esc(it.url || '#')}" target="_blank" rel="noopener" data-open>${esc(it.title)}</a></h3>
    ${it.summary ? `<p class="sum">${esc(it.summary)}</p>` : ''}
    <div class="acts">${acts}</div>
  </li>`;
}

// ------------------------------------------------------------ render

function render() {
  const c = counts();
  $$('[data-count]').forEach((b) => { const n = c[b.dataset.count]; b.textContent = n ? (n > 999 ? '999+' : n) : ''; });
  $$('.nav [data-view], .top [data-view]').forEach((b) => {
    if (b.dataset.view === S.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.title = c.inbox ? `(${c.inbox}) News` : 'News';
  if (navigator.setAppBadge) navigator.setAppBadge(c.inbox).catch(() => {});

  const views = { inbox: renderInbox, reading: renderItems, later: renderItems, done: renderItems, feeds: renderFeeds, settings: renderSettings };
  const scroll = window.scrollY;
  views[S.view]();
  window.scrollTo(0, scroll);
  applyKb();
}

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
  const opts = feeds.map((f) => `<option value="${esc(f.id)}"${S.filter === f.id ? ' selected' : ''}>${esc(f.data.title || f.data.url)}</option>`).join('');
  viewEl.innerHTML = `<div class="vh">
      <div><h1>${t('inbox.title')}</h1><p>${all.length ? t('inbox.count', { n: all.length }) : t('inbox.nothing_new')}</p></div>
      <div class="tools">
        <select id="filter" aria-label="${esc(t('inbox.filter'))}"><option value="">${t('inbox.all_feeds')}</option>${opts}</select>
        ${list.length ? `<button class="btn btn-ghost" type="button" id="clearInbox" title="${esc(t('inbox.clear_hint'))}">${t(list.length < all.length ? 'inbox.clear_shown' : 'inbox.clear_all')}</button>` : ''}
      </div></div>
    ${list.length ? `<ol class="list">${list.map((e) => card({ ...e, time: entryTime(e) }, 'inbox')).join('')}</ol>` : `<div class="empty"><strong>${t('inbox.zero')}</strong>${S.lastRefresh ? t('inbox.last_checked', { when: ago(S.lastRefresh) }) : ''}<br><button class="btn btn-ghost" type="button" data-refresh>${t('inbox.check')}</button></div>`}
    ${all.length > list.length ? `<div class="more"><button class="btn btn-ghost" type="button" data-more>${t('inbox.more', { n: all.length - list.length })}</button></div>` : ''}`;
}

function renderItems() {
  const v = `views.${S.view}`;
  let list = itemsIn(S.view);
  if (S.view === 'done') list = list.slice(0, 300);
  viewEl.innerHTML = `<div class="vh"><div><h1>${t(v + '.title')}</h1><p>${t(v + '.text')}</p></div></div>
    ${list.length ? `<ol class="list">${list.map((it) => card(it, S.view)).join('')}</ol>` : `<div class="empty"><strong>${t(v + '.empty')}</strong>${t(v + '.hint')}</div>`}`;
}

function renderFeeds() {
  const feeds = liveFeeds();
  const app = location.href.split(/[?#]/)[0];
  const bookmarklet = `javascript:location.href='${app}?add='+encodeURIComponent(location.href)`;
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
  if (key) drawQr(pairLink);
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

// ------------------------------------------------------------ language & theme

async function useLanguage(lang) {
  t = await loadI18n('i18n/', lang);
  rtf = new Intl.RelativeTimeFormat(t.lang, { numeric: 'auto', style: 'short' });
  applyI18n(t);
  paintStatus(sync.status);
}

// ------------------------------------------------------------ sync status

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

// ------------------------------------------------------------ toast & dialog

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

// ------------------------------------------------------------ navigation

function go(view) {
  if (S.view !== view) { S.view = view; S.shown = PAGE; S.kb = -1; S.share = ''; window.scrollTo(0, 0); }
  history.replaceState(null, '', view === 'inbox' ? location.pathname : `${location.pathname}#${view}`);
  render();
  viewEl.focus({ preventScroll: true });
}

// ------------------------------------------------------------ events

document.addEventListener('click', async (ev) => {
  const el = ev.target;
  const viewBtn = el.closest('[data-view]');
  if (viewBtn) return go(viewBtn.dataset.view);

  const cardEl = el.closest('.card');
  if (cardEl) {
    const id = cardEl.dataset.id;
    const act = el.closest('[data-act]');
    if (act) {
      const s = act.dataset.act;
      if (s === 'reading') openUrl(urlOf(id));
      return setState(id, s);
    }
    if (el.closest('[data-open]')) {
      // opening the article = reading it (the link opens in a new tab by itself)
      if (S.view === 'inbox' || S.view === 'later') setState(id, 'reading', { toast: false, animate: false });
      return;
    }
  }
  if (el.closest('[data-more]')) { S.shown += PAGE; return render(); }
  if (el.closest('[data-refresh]')) return refreshAll(true);

  const feedBtn = el.closest('[data-feed-act]');
  if (feedBtn) return feedAction(feedBtn.dataset.feedAct, feedBtn.closest('[data-feed]').dataset.feed);

  switch (el.closest('button')?.id) {
    case 'clearInbox': {
      const ids = inboxEntries().slice(0, S.shown).map((e) => e.id);
      return setState(ids, 'dismissed', { animate: false });
    }
    case 'opmlOut': return exportOpml();
    case 'serverTest': return testServer();
    case 'createVault':
      await sync.createVault();
      await loadAll();
      return render();
    case 'syncNow': return sync.run();
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
        indexedDB.deleteDatabase(DB_NAME);
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
  if (id === 'filter') { S.filter = ev.target.value; S.shown = PAGE; render(); }
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
      render(); // re-renders the feeds view → write the result into the fresh DOM
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

// ------------------------------------------------------------ pairing

function parsePairing(raw) {
  if (isValidKey(raw)) return { key: raw };
  try {
    const u = new URL(raw);
    const p = new URLSearchParams(u.hash.slice(1));
    const key = p.get('pair');
    if (isValidKey(key)) return { key, server: p.get('server') || '' };
  } catch { /* not a URL */ }
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
  showToast(t(sync.status.state === 'ok' ? 'toast.paired_synced' : 'toast.paired_later'));
  refreshAll();
}

// ------------------------------------------------------------ keyboard

function cardsInView() { return $$('.card', viewEl); }

function applyKb() {
  const cards = cardsInView();
  cards.forEach((c, i) => c.classList.toggle('kb', i === S.kb));
}

document.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.target.closest('input, textarea, select, dialog')) return;
  const cards = cardsInView();
  const k = ev.key;
  const views = ['inbox', 'reading', 'later', 'done', 'feeds'];
  if (k >= '1' && k <= '5') { go(views[+k - 1]); return; }
  if (k === 'r') { refreshAll(true); return; }
  if (k === 'u' && lastUndo) { const f = lastUndo; lastUndo = null; $('#toast').hidden = true; f(); return; }
  if (!cards.length) return;
  if (k === 'j' || k === 'ArrowDown' && S.kb >= 0) { S.kb = Math.min(cards.length - 1, S.kb + 1); }
  else if (k === 'k' || k === 'ArrowUp' && S.kb >= 0) { S.kb = Math.max(0, S.kb - 1); }
  else {
    const cur = cards[S.kb >= 0 ? S.kb : 0];
    const map = { o: 'reading', Enter: 'reading', l: 'later', x: 'dismissed', d: 'done' };
    const s = map[k];
    if (!s || !cur) return;
    const allowed = ACTIONS[S.view]?.some(([a]) => a === s);
    if (!allowed) return;
    ev.preventDefault();
    if (S.kb < 0) S.kb = 0;
    const btn = cur.querySelector(`[data-act="${s}"]`);
    btn?.click();
    S.kb = Math.min(S.kb, cardsInView().length - 2);
    return;
  }
  ev.preventDefault();
  applyKb();
  cards[S.kb]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

// ------------------------------------------------------------ swipe (touch) – actions configurable in Settings

let sw = null;
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
    try { sw.c.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
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
  if (s === 'reading') openUrl(urlOf(c.dataset.id));
  setState(c.dataset.id, s, { animate: false });
};
viewEl.addEventListener('pointerup', endSwipe);
viewEl.addEventListener('pointercancel', endSwipe);

// ------------------------------------------------------------ incoming links (share target, bookmarklet, pairing)

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

// ------------------------------------------------------------ boot

sync.addEventListener('status', (e) => paintStatus(e.detail));
sync.addEventListener('remote', async (e) => {
  const newFeeds = e.detail.filter((r) => r.kind === 'feed' && !r.data.d && !S.feeds.has(r.id));
  const gone = e.detail.filter((r) => r.kind === 'feed' && r.data.d);
  await loadAll();
  for (const r of gone) await db.deleteEntriesForFeed(r.id);
  if (gone.length) await loadAll();
  render();
  if (newFeeds.length) {
    await pool(newFeeds, 4, (r) => refreshFeed(S.feeds.get(r.id)));
    await db.kvSet('fetchState', Object.fromEntries(S.fetch));
    render();
  }
});

window.addEventListener('online', () => sync.run());
window.addEventListener('offline', () => sync.run());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  sync.run();
  if (Date.now() - S.lastRefresh > AUTO_REFRESH_MS) refreshAll();
  else render(); // relative times
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
  await sync.init();
  render();
  await handleIncoming();
  render();
  sync.run();
  if (Date.now() - S.lastRefresh > AUTO_REFRESH_MS) refreshAll();
})();
