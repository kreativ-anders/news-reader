// News service worker – offline app shell. Collector (/api/collect) and sync always go to the network.
const VERSION = 'news-0.4.0';
const SHELL = [
  './', 'index.html', 'app.css', 'theme.css', 'manifest.webmanifest',
  'fonts/newsreader.woff2', 'fonts/source-sans-3.woff2',
  'js/app.js', 'js/db.js', 'js/sync.js', 'js/feeds.js', 'js/i18n.js', 'vendor/qrcode.js',
  'i18n/en.json', 'i18n/de.json', 'i18n/fr.json', 'i18n/it.json', 'i18n/es.json',
  'icons/news.svg', 'icons/favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
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
  // only GETs of our own app files; never the API (Collector, sync)
  if (req.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  // navigations (incl. share target ?url=… and pairing #pair=…) → the app shell
  const key = req.mode === 'navigate' ? new Request(new URL('index.html', scope)) : req;

  // stale-while-revalidate: instant start, updates arrive with the next launch
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
  }));
});
