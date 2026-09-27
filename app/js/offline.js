// INFO: an item moved to "Later" gets one readable copy (feed full text or server extraction via /api/article),
//       stored only on this device. Offline, a click opens it in the reader; scrolled to the end = "Done".

import * as db from './db.js';
import { serverBase } from './sync.js';
import { pool } from './feeds.js';
import { esc, httpUrl, hostOf } from './util.js';

const KEEP = new Set(['later', 'reading']);
const GRACE_MS = 864e5;                        // INFO: done/dismissed copies stay 1 day (undo, "read again")
const RETRY_TRANSIENT_MS = 5 * 60 * 1000;
const RETRY_PERMANENT_MS = 24 * 3600 * 1000;
const TRANSIENT = new Set(['UNREACHABLE', 'TIMEOUT', 'RATE_LIMITED', 'BUSY', 'UPSTREAM_FETCH_FAILED', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504']);
// INFO: the source itself answered 5xx / 429 – worth a retry soon, unlike a 404
const transient = (code) => TRANSIENT.has(code) || /^UPSTREAM_HTTP_(5\d\d|429)$/.test(code);

export class OfflineStore extends EventTarget {
  constructor() {
    super();
    this.meta = new Map(); // INFO: metadata only – the content stays in IndexedDB
    this.running = null;
    this.timer = null;
  }

  async load() {
    this.meta.clear();
    for (const a of await db.getAll('articles')) this.meta.set(a.id, summary(a));
  }

  has(id) { return !!this.meta.get(id)?.ok; }

  words(id) { const m = this.meta.get(id); return m?.ok && !m.partial ? m.words : 0; }

  get(id) { return db.get('articles', id); }

  async savePosition(id, pos) {
    const a = await db.get('articles', id);
    if (a?.ok) await db.write(['articles'], (tx) => tx.objectStore('articles').put({ ...a, pos }));
  }

  schedule(items, feedUrlOf, delay = 800) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reconcile(items(), feedUrlOf), delay);
  }

  async reconcile(items, feedUrlOf) {
    if (this.running) return this.running;
    this.running = (async () => {
      const now = Date.now();
      const drop = [...this.meta.keys()].filter((id) => {
        const r = items.get(id);
        return !r || (!KEEP.has(r.data.s) && now - r.updatedAt > GRACE_MS);
      });
      if (drop.length) {
        await db.write(['articles'], (tx) => drop.forEach((id) => tx.objectStore('articles').delete(id)));
        drop.forEach((id) => this.meta.delete(id));
        this.emit();
      }
      if (!navigator.onLine) return;

      const todo = [...items.values()].filter((r) => {
        if (r.data.s !== 'later' || !r.data.u) return false;
        const m = this.meta.get(r.id);
        if (!m) return true;
        if (m.ok) return false;
        return now - m.triedAt > (transient(m.code) ? RETRY_TRANSIENT_MS : RETRY_PERMANENT_MS);
      });
      if (!todo.length) return;

      let saved = 0;
      await pool(todo, 2, async (r) => {
        const row = await fetchArticle({ id: r.id, url: r.data.u, feedUrl: r.data.f ? feedUrlOf(r.data.f) : '' })
          .then((a) => ({ id: r.id, ok: true, ...a, savedAt: Date.now(), pos: 0 }))
          .catch((e) => ({ id: r.id, ok: false, code: e.code || 'ERROR', error: e.message, triedAt: Date.now() }));
        if (!KEEP.has(items.get(r.id)?.data?.s)) return;
        await db.write(['articles'], (tx) => tx.objectStore('articles').put(row));
        this.meta.set(r.id, summary(row));
        if (row.ok) saved++;
        this.emit();
      });
      if (saved) navigator.storage?.persist?.().catch(() => {});
    })().finally(() => { this.running = null; });
    return this.running;
  }

  emit() { this.dispatchEvent(new Event('change')); }
}

const summary = (a) => ({ ok: !!a.ok, partial: !!a.partial, words: a.words || 0, triedAt: a.triedAt || a.savedAt || 0, code: a.code || '' });

async function fetchArticle({ id, url, feedUrl }, timeout = 45000) {
  const api = new URL('api/article', await serverBase());
  api.searchParams.set('url', url);
  if (feedUrl) { api.searchParams.set('feed', feedUrl); api.searchParams.set('id', id); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(api.href, { signal: ctrl.signal });
    let body = null;
    try { body = await res.json(); } catch { /* INFO: not JSON – handled below */ }
    if (!res.ok || !body?.article) {
      const e = body?.error;
      const code = e?.code === 'UPSTREAM_HTTP_ERROR' && e.upstreamStatus ? `UPSTREAM_HTTP_${e.upstreamStatus}` : e?.code || 'HTTP_' + res.status;
      throw Object.assign(new Error(e?.message || `HTTP ${res.status}`), { code });
    }
    const a = body.article;
    return {
      url: httpUrl(a.url) || httpUrl(url), title: a.title || '', byline: a.byline || '', siteName: a.siteName || '',
      publishedAt: a.publishedAt || null, lang: a.lang || '', content: String(a.content || ''),
      words: a.words || 0, source: a.source || '', partial: !!a.partial,
    };
  } catch (err) {
    if (err.name === 'AbortError') throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    if (err instanceof TypeError) throw Object.assign(new Error('unreachable'), { code: 'UNREACHABLE' });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// INFO: defence in depth – the server already sanitizes, the client never trusts it

const TAGS = new Set(['P', 'BR', 'HR', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'BLOCKQUOTE', 'PRE', 'CODE',
  'EM', 'STRONG', 'B', 'I', 'U', 'S', 'MARK', 'SMALL', 'SUB', 'SUP', 'Q', 'CITE', 'ABBR', 'A', 'IMG', 'FIGURE', 'FIGCAPTION',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'SVG', 'MATH', 'TEMPLATE', 'LINK', 'META', 'BASE', 'NOSCRIPT']);

function sanitize(html) {
  const src = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  const out = document.createDocumentFragment();
  const walk = (node, parent, depth) => {
    for (const n of [...node.childNodes]) {
      if (n.nodeType === Node.TEXT_NODE) { parent.append(n.textContent); continue; }
      if (n.nodeType !== Node.ELEMENT_NODE || depth > 60 || DROP.has(n.tagName)) continue;
      const tag = n.tagName === 'H1' ? 'H2' : n.tagName;
      if (!TAGS.has(tag)) { walk(n, parent, depth + 1); continue; }
      const el = document.createElement(tag);
      if (tag === 'A') {
        const href = n.getAttribute('href') || '';
        if (!httpUrl(href) && !/^mailto:/i.test(href)) { walk(n, parent, depth + 1); continue; }
        el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer';
      } else if (tag === 'IMG') {
        const s = httpUrl(n.getAttribute('src'));
        if (!s) continue;
        el.src = s; el.alt = n.getAttribute('alt') || '';
        el.loading = 'lazy'; el.decoding = 'async'; el.referrerPolicy = 'no-referrer';
      }
      parent.append(el);
      walk(n, el, depth + 1);
    }
  };
  walk(src, out, 0);
  return out;
}

const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
let current = null;

export const readerOpen = () => !!current;

// INFO: onClose({ read, pos }) – read: the end was reached; pos: scroll position 0…1
export function openReader(article, { t, lang, onClose }) {
  if (current) current.close();

  const host = hostOf(article.url);
  const date = article.publishedAt ? new Date(article.publishedAt).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const mins = Math.max(1, Math.round((article.words || 0) / 220));
  const meta = [article.siteName || host, date, t('reader.minutes', { n: mins })].filter(Boolean).map(esc).join(' · ');

  const root = document.createElement('div');
  root.className = 'reader';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', article.title || t('untitled'));
  root.tabIndex = -1;
  if (article.lang) root.lang = article.lang;
  root.innerHTML = `
    <div class="reader-progress" aria-hidden="true"><i></i></div>
    <button type="button" class="reader-x" aria-label="${esc(t('reader.close'))}" title="${esc(t('reader.close'))} (Esc)">${X_ICON}</button>
    <article class="reader-doc">
      <header>
        <p class="reader-meta">${meta}</p>
        <h1>${esc(article.title || t('untitled'))}</h1>
        ${article.byline ? `<p class="reader-by">${esc(article.byline)}</p>` : ''}
      </header>
      <div class="reader-body"></div>
      <footer class="reader-end">
        ${article.partial ? `<p class="reader-partial">${esc(t('reader.partial'))}</p>` : ''}
        <span class="reader-fin" aria-hidden="true">■</span>
      </footer>
    </article>`;
  root.querySelector('.reader-body').append(sanitize(article.content || ''));

  root.addEventListener('error', (ev) => {
    if (ev.target instanceof HTMLImageElement) (ev.target.closest('figure') || ev.target).remove();
  }, true);

  const bar = root.querySelector('.reader-progress i');
  const fin = root.querySelector('.reader-fin');
  let read = false;
  const progress = () => {
    const max = root.scrollHeight - root.clientHeight;
    const p = max > 0 ? root.scrollTop / max : 1;
    bar.style.transform = `scaleX(${p})`;
    if (p >= 0.98) read = true;
  };
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) read = true; }, { root, threshold: 1 });

  const prevFocus = document.activeElement;
  document.documentElement.classList.add('reader-open');
  document.body.append(root);
  if (article.pos > 0.02 && article.pos < 0.98) {
    requestAnimationFrame(() => { root.scrollTop = article.pos * (root.scrollHeight - root.clientHeight); progress(); });
  }
  root.addEventListener('scroll', progress, { passive: true });
  requestAnimationFrame(() => { io.observe(fin); progress(); });
  root.focus({ preventScroll: true });

  // INFO: full screen needs the user gesture that opened the reader
  if (document.fullscreenEnabled && !document.fullscreenElement) {
    document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  }

  // INFO: the back button / gesture closes the reader instead of leaving the app
  history.pushState({ reader: 1 }, '');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    io.disconnect();
    removeEventListener('popstate', onPop);
    root.removeEventListener('keydown', onKey);
    const max = root.scrollHeight - root.clientHeight;
    const pos = max > 0 ? root.scrollTop / max : 1;
    root.remove();
    document.documentElement.classList.remove('reader-open');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    current = null;
    prevFocus?.focus?.({ preventScroll: true });
    onClose?.({ read, pos });
  };
  const onPop = () => close();
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); history.back(); }
    ev.stopPropagation();
  };
  addEventListener('popstate', onPop);
  root.addEventListener('keydown', onKey);
  root.querySelector('.reader-x').addEventListener('click', () => history.back());

  current = { close: () => history.back() };
}
