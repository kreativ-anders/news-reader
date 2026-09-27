// INFO: shared by the site (/) and the app (/app/). en.json is complete, other languages fall back per key.
//       Placeholders "{n}"; plurals via "x_one" / "x_other" when vars.n is a number.
// WARNING: t() does not escape placeholder values – escape untrusted values before passing them in.

export const LANGS = { en: 'English', de: 'Deutsch', fr: 'Français', it: 'Italiano', es: 'Español' };
export const THEMES = ['auto', 'light', 'dark'];

const LS_LANG = 'nr.lang';
const LS_THEME = 'nr.theme';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* INFO: storage blocked */ } },
};

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

export async function loadI18n(baseUrl, lang = getLang()) {
  const base = String(baseUrl).replace(/\/?$/, '/');
  const [en, own] = await Promise.all([loadJson(base + 'en.json'), lang === 'en' ? null : loadJson(base + lang + '.json')]);
  const dict = own ? merge(en, own) : en;
  const plural = new Intl.PluralRules(lang), num = new Intl.NumberFormat(lang);
  const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), dict);
  const t = (key, vars = {}) => {
    let s;
    if (typeof vars.n === 'number') s = lookup(`${key}_${plural.select(vars.n)}`) ?? lookup(`${key}_other`);
    s ??= lookup(key);
    if (typeof s !== 'string') return key;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? (typeof vars[k] === 'number' ? num.format(vars[k]) : String(vars[k])) : m));
  };
  t.lang = lang;
  return t;
}

// WARNING: data-i18n sets innerHTML – translation files must stay trusted, first-party content
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
