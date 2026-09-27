import { serverBase } from './sync.js';

// INFO: same normalisation as the Collector (scheme optional)
export function normalizeUrl(input) {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    return u.href;
  } catch {
    return '';
  }
}

// INFO: Android share sheets put the link into "text"
export function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[).,;!?]+$/, '') : '';
}

// INFO: cyrb53 of the normalised URL – works without crypto.subtle on plain HTTP
export function feedId(url) {
  const str = normalizeUrl(url).replace(/\/$/, '');
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'f' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export async function fetchFeed(url, { refresh = false, timeout = 60000, t = (k) => k } = {}) {
  const api = new URL('api/collect', await serverBase());
  api.searchParams.set('url', url);
  if (refresh) api.searchParams.set('refresh', '1');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    // INFO: revalidate – the HTTP cache would otherwise keep serving an answer older than the last ?refresh=1
    const res = await fetch(api.href, { signal: ctrl.signal, cache: 'no-cache' });
    let body = null;
    try { body = await res.json(); } catch { /* INFO: not JSON – handled below */ }
    if (!res.ok || !body || body.error) {
      const e = body?.error;
      throw Object.assign(new Error(e?.message || t('err.http', { status: res.status })), { code: e?.code || 'HTTP_' + res.status, retryAfter: Number(res.headers.get('retry-after')) || 0 });
    }
    return body;
  } catch (err) {
    if (err.name === 'AbortError') throw Object.assign(new Error(t('err.timeout')), { code: 'TIMEOUT' });
    if (err instanceof TypeError) throw Object.assign(new Error(t('err.unreachable')), { code: 'UNREACHABLE' });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = { ok: true, value: await fn(items[k], k) }; }
      catch (error) { out[k] = { ok: false, error }; }
    }
  });
  await Promise.all(workers);
  return out;
}

// INFO: the folder of a feed is the title of the nearest enclosing outline without xmlUrl (OPML categories)
export function parseOpml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('This is not a valid OPML file.');
  const feeds = [];
  for (const o of doc.querySelectorAll('outline')) {
    const url = o.getAttribute('xmlUrl') || o.getAttribute('xmlurl') || o.getAttribute('url');
    if (!url) continue;
    const parent = o.parentElement?.closest('outline');
    const folder = parent ? (parent.getAttribute('title') || parent.getAttribute('text') || '').trim() : '';
    feeds.push({ url, title: o.getAttribute('title') || o.getAttribute('text') || '', folder });
  }
  return feeds;
}

// INFO: feeds with a folder (data.g) are nested in an outline of that name, the others stay at the top level
export function buildOpml(feeds) {
  const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  const line = (f, pad) => `${pad}<outline type="rss" text="${esc(f.title || f.url)}" title="${esc(f.title || f.url)}" xmlUrl="${esc(f.url)}"/>`;
  const folders = new Map();
  for (const f of feeds.filter((f) => f.g)) folders.set(f.g, [...(folders.get(f.g) || []), f]);
  const lines = [
    ...[...folders].sort(([a], [b]) => a.localeCompare(b)).map(([g, list]) =>
      `    <outline text="${esc(g)}" title="${esc(g)}">\n${list.map((f) => line(f, '      ')).join('\n')}\n    </outline>`),
    ...feeds.filter((f) => !f.g).map((f) => line(f, '    ')),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>News subscriptions</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${lines.join('\n')}
  </body>
</opml>
`;
}

// INFO: platform wording around the real name, e.g. "Stories by Jane Doe on Medium" → "Jane Doe", "Heise – RSS Feed" → "Heise"
const TITLE_NOISE = [
  /^stories by (.+?) on medium$/i,
  /^(.+?) (?:on|[-–|]) medium$/i,
  /^(?:rss|atom)(?: feed)?\s*[-–|:»]\s*(.+)$/i,
  /^(.+?)\s*[-–|:»]\s*(?:(?:rss|atom)(?: ?feed)?|feed|news ?feed)$/i,
  /^(.+?) (?:rss|atom) feed$/i,
];
export function cleanTitle(title) {
  const s = String(title || '').trim();
  for (const re of TITLE_NOISE) {
    const m = s.match(re);
    if (m && m[1].trim().length >= 2) return m[1].trim();
  }
  return s;
}
