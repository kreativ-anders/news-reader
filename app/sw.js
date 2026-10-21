// INFO: caches the app shell only – the API always goes to the network
const VERSION = 'news-0.8.16';
const SHELL = [
  './', 'index.html', 'app.css', 'theme.css', 'manifest.webmanifest',
  'fonts/newsreader.woff2', 'fonts/source-sans-3.woff2',
  'js/app.js', 'js/db.js', 'js/sync.js', 'js/feeds.js', 'js/i18n.js', 'js/offline.js', 'js/util.js',
  'i18n/en.json', 'i18n/de.json', 'i18n/fr.json', 'i18n/it.json', 'i18n/es.json',
  'icons/news.svg', 'icons/favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon-v4.png', 'icons/favicon-32.png', 'icons/favicon-32-dark.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => (k.startsWith('flint-') || k.startsWith('news-')) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (req.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  // INFO: navigations to the app (share target ?url=…, pairing #pair=…) get the app shell. Other navigations
  //       (e.g. a link to i18n/en.json) go to the network – cached as the shell they would replace the app.
  const shell = url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html';
  if (req.mode === 'navigate' && !shell) return;
  const key = req.mode === 'navigate' ? new Request(new URL('index.html', scope)) : req;

  // INFO: stale-while-revalidate – updates arrive with the next launch
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
  }));
});

// INFO: number on the app icon while the app is closed – Chromium only, installed app, switched on in the settings
//       (app.js badgeSync, at most every 12 h). Gentle on the server: the server's copy (no refresh=1), one source at
//       a time, only sources whose copy may have changed, stop at the first "not now". Posts newer than the last
//       refresh that this device has not seen are added to the Inbox number the app left behind. Nothing is stored –
//       the app fetches properly on its next start.
const BADGE_SKIP_MS = 30 * 60 * 1000;
const BADGE_TIMEOUT_MS = 30 * 1000;

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'badge') e.waitUntil(checkBadge().catch(() => {}));
});

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('news');
    req.onupgradeneeded = () => req.transaction.abort(); // INFO: no data yet – never create the database here
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const idbAll = (db, store, keys = false) => new Promise((resolve, reject) => {
  const s = db.transaction(store).objectStore(store);
  const req = keys ? s.getAllKeys() : s.getAll();
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function checkBadge() {
  if (!self.navigator.setAppBadge) return;
  const db = await idb();
  let kv, records, known;
  try {
    [kv, records, known] = await Promise.all([idbAll(db, 'kv'), idbAll(db, 'records'), idbAll(db, 'entries', true)]);
  } finally {
    db.close();
  }
  const v = Object.fromEntries(kv.map((r) => [r.k, r.v]));
  const now = Date.now(), since = v.lastRefresh || 0, state = v.fetchState || {};
  if (now - since < BADGE_SKIP_MS) return;
  const seen = new Set([...known, ...records.filter((r) => r.kind === 'item').map((r) => r.id)]);
  const feeds = records.filter((r) => r.kind === 'feed' && r.data?.url && !r.data.d)
    .filter((f) => { const st = state[f.id]; return !(st?.retry > now) && !(st?.ok && st.next > now); });
  const base = v.server || new URL('../', self.registration.scope).href;
  let fresh = 0;
  for (const f of feeds) {
    const api = new URL('api/collect', base);
    api.searchParams.set('url', f.data.url);
    const res = await fetch(api.href, { cache: 'no-cache', signal: AbortSignal.timeout(BADGE_TIMEOUT_MS) }).catch(() => null);
    if (!res || res.status === 429 || res.status === 503) break; // INFO: offline or "not now" – the app catches up later
    if (!res.ok) continue;
    const body = await res.json().catch(() => null);
    for (const x of Array.isArray(body?.entries) ? body.entries : []) {
      if (typeof x?.id !== 'string' || seen.has(x.id)) continue;
      seen.add(x.id);
      if ((Date.parse(x.publishedAt || x.updatedAt || '') || now) > since) fresh++;
    }
  }
  if (fresh) await self.navigator.setAppBadge((v.badge || 0) + fresh);
}
