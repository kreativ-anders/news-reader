// News Reader – language & theme preferences, shared by the site (/) and the app (/app/).
//
// Translations: one JSON file per language with nested keys, English is the source.
//   <base>/en.json   complete – every key exists here
//   <base>/de.json   partial is fine – missing keys fall back to English per key
// Placeholders: "{n} new" → t('inbox.count', { n: 3 }).
// Plurals: keys "x_one" / "x_other" are picked via Intl.PluralRules when vars.n is given.
// Preferences live in localStorage (same origin → site and app share them).

export const LANGS = { en: 'English', de: 'Deutsch', fr: 'Français', it: 'Italiano', es: 'Español' };
export const THEMES = ['auto', 'light', 'dark'];

const LS_LANG = 'nr.lang';
const LS_THEME = 'nr.theme';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ------------------------------------------------------------ language

/** Saved choice → browser languages → English. */
export function getLang() {
  const saved = store.get(LS_LANG);
  if (saved && LANGS[saved]) return saved;
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const base = String(l).toLowerCase().split('-')[0];
    if (LANGS[base]) return base;
  }
  return 'en';
}

export function setLang(lang) {
  store.set(LS_LANG, LANGS[lang] ? lang : null);
}

const cache = new Map();
async function loadJson(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  }
  return cache.get(url);
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base?.[k] || {}, v) : v;
  }
  return out;
}

/**
 * Load English + the requested language (merged, English fills the gaps).
 * @returns {Promise<(key:string, vars?:object) => string>}  t() with .lang
 */
export async function loadI18n(baseUrl, lang = getLang()) {
  const base = String(baseUrl).replace(/\/?$/, '/');
  const en = await loadJson(base + 'en.json');
  const dict = lang === 'en' ? en : merge(en, await loadJson(base + lang + '.json'));
  const plural = new Intl.PluralRules(lang);
  const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), dict);
  const t = (key, vars = {}) => {
    let s;
    if (typeof vars.n === 'number') s = lookup(`${key}_${plural.select(vars.n)}`) ?? lookup(`${key}_other`);
    s ??= lookup(key);
    if (typeof s !== 'string') return key;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  };
  t.lang = lang;
  return t;
}

/**
 * Translate static markup:
 *   data-i18n="key"             → innerHTML (translations are our own, trusted files)
 *   data-i18n-attr="attr:key;…" → attributes (aria-label, title, placeholder, content …)
 */
export function applyI18n(t, root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = t(el.dataset.i18n);
    if (v !== el.dataset.i18n) el.innerHTML = v;
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((x) => x.trim());
      const v = t(key);
      if (attr && v !== key) el.setAttribute(attr, v);
    }
  });
  if (root === document) document.documentElement.lang = t.lang;
}

// ------------------------------------------------------------ theme

export function getTheme() {
  const t = store.get(LS_THEME);
  return THEMES.includes(t) ? t : 'auto';
}

export function setTheme(theme) {
  store.set(LS_THEME, theme === 'auto' ? null : theme);
  applyTheme(theme);
}

export function applyTheme(theme = getTheme()) {
  const el = document.documentElement;
  if (theme === 'light' || theme === 'dark') el.dataset.theme = theme;
  else delete el.dataset.theme;
}
