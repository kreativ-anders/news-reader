// INFO: site events for Pirsch Analytics (site pages only – the app loads no analytics).
//       One delegated listener, so links inside translated text (replaced by innerHTML) are counted too.
//       Events carry fixed, language-neutral values only – never text a visitor typed or anything personal.
//
//       Open app · Self-host · GitHub · Support · API docs   { position, lang }
//       FAQ { question } · Collector strategy { strategy } · Language { from, to } · Theme { mode } · Animations { state }
//       <body data-track-view="…"> – one event per page view (404.html: Not found)
const lang = document.documentElement.lang || 'en';

function track(name, meta = {}) {
  try { window.pirsch?.(name, { meta: { lang, ...meta } })?.catch?.(() => {}); } catch { /* INFO: analytics blocked */ }
}

// INFO: where on the page – header, footer or the section the element sits in
function position(el) {
  if (el.closest('header')) return 'header';
  if (el.closest('footer')) return 'footer';
  const sec = el.closest('section');
  return sec?.id || sec?.classList[0] || 'page';
}

const LINKS = [
  ['a[href$="app/"]', 'Open app'],
  ['a[href="#build"]', 'Self-host'],
  ['a[href^="https://github.com/"]', 'GitHub'],
  ['a[href^="https://buy.stripe.com/"]', 'Support'],
  ['a[href$="docs/api/"]', 'API docs'],
];

document.addEventListener('click', (ev) => {
  const el = ev.target;
  for (const [sel, name] of LINKS) {
    const a = el.closest(sel);
    if (a) return track(name, { position: position(a) });
  }
  const tab = el.closest('.vtab [role="tab"]');
  if (tab) return track('Collector strategy', { strategy: (tab.id || '').replace(/^vt-/, '') });
  // INFO: the site's own handlers run first (bubbling) – read the state they set
  if (el.closest('#themeBtn')) return track('Theme', { mode: document.getElementById('themeBtn').dataset.mode || '' });
  if (el.closest('#motionBtn')) return track('Animations', { state: document.documentElement.classList.contains('still') ? 'paused' : 'playing' });
});

document.addEventListener('toggle', (ev) => {
  const d = ev.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open || !d.closest('#faq')) return;
  track('FAQ', { question: d.querySelector('summary')?.dataset.i18n?.replace(/^faq\./, '') || '' });
}, true);

// INFO: arrow keys fire "change" per step – count each target language once per page view
const langs = new Set();
const langSel = document.getElementById('langSel');
['change', 'blur'].forEach((type) => langSel?.addEventListener(type, () => {
  const to = langSel.value;
  if (to === lang || langs.has(to)) return;
  langs.add(to);
  track('Language', { from: lang, to });
}));

if (document.body?.dataset.trackView) track(document.body.dataset.trackView);
