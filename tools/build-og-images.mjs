// INFO: renders the social share images (1200×630) – one per site language, run after changing the hero text,
//       the tagline or the brand icon:  node tools/build-og-images.mjs [--site=https://news-reader.app/]
//       Texts come from i18n/<lang>.json (hero.read_what_matters_skip, meta.og_image_tagline), icon from brand/news-icon.svg.
//       Output: og-image.png (English, x-default) and og-image-<lang>.png; tools/build-i18n.php points each page at its image.
//       Uses the Playwright Chromium from the test tooling – no extra dependency.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['en', 'de', 'fr', 'it', 'es'];
const site = (process.argv.find((a) => a.startsWith('--site='))?.slice(7) || 'https://news-reader.app/');
const host = new URL(site).host;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const text = (html) => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
const font = (file) => `data:font/woff2;base64,${readFileSync(join(ROOT, 'app/fonts', file)).toString('base64')}`;
const load = (lang) => JSON.parse(readFileSync(join(ROOT, 'i18n', `${lang}.json`), 'utf8'));

const en = load('en');
const icon = readFileSync(join(ROOT, 'brand/news-icon.svg'), 'utf8').replace(/<title>.*?<\/title>/, '');
const serif = font('newsreader.woff2');
const sans = font('source-sans-3.woff2');

// INFO: previews are shown at ~40 % (WhatsApp, iMessage, Slack) – every text must stay readable at that scale,
//       so the headline fills the width and nothing is smaller than 34 px.
const page = (headline, accent, tagline) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Newsreader;src:url(${serif}) format("woff2");font-weight:200 800}
@font-face{font-family:"Source Sans 3";src:url(${sans}) format("woff2");font-weight:200 900}
*{margin:0;box-sizing:border-box}
html,body{width:1200px;height:630px;background:#292929;color:#FFFFFF;-webkit-font-smoothing:antialiased}
body{display:flex;flex-direction:column;justify-content:space-between;padding:60px 72px 64px;font-family:"Source Sans 3",sans-serif;
  background:radial-gradient(900px 520px at 100% 0,rgba(255,165,0,.10),transparent 70%),#292929}
.top{display:flex;align-items:center;gap:22px}
.top svg{width:84px;height:84px;flex:none}
.name{font:600 62px/1 Newsreader,serif;letter-spacing:-.01em}
.host{margin-left:auto;font-weight:600;font-size:34px;color:#FFA500}
h1{font:600 132px/1.02 Newsreader,serif;letter-spacing:-.02em;white-space:nowrap}
h1 span{display:block}h1 .accent{color:#FFA500}
p{font-weight:500;font-size:40px;line-height:1.2;color:#E6E6E6;white-space:nowrap}
</style></head><body>
<div class="top">${icon}<span class="name">News</span><span class="host">${esc(host)}</span></div>
<h1><span>${esc(headline)}</span><span class="accent">${esc(accent)}</span></h1>
<p>${esc(tagline)}</p>
</body></html>`;

// INFO: shrinks a line until it fits the content width – translations differ a lot in length
const fit = () => document.fonts.ready.then(() => {
  const max = document.body.clientWidth - 144;
  for (const [sel, min] of [['h1', 88], ['p', 34]]) {
    const el = document.querySelector(sel);
    let size = parseFloat(getComputedStyle(el).fontSize);
    const wide = () => [...(el.children.length ? el.children : [el])].some((c) => c.scrollWidth > max);
    while (wide() && size > min) el.style.fontSize = `${--size}px`;
    if (wide()) throw new Error(`${sel} too long even at ${min}px: ${el.textContent}`);
  }
});

const browser = await chromium.launch();
try {
  const tab = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  for (const lang of LANGS) {
    const dict = load(lang);
    const t = (group, key) => dict[group]?.[key] ?? en[group][key];
    const [, first, second] = t('hero', 'read_what_matters_skip').match(/^(.*?)<em[^>]*>(.*?)<\/em>/) || [];
    if (!first) throw new Error(`${lang}: hero.read_what_matters_skip needs an <em> part`);
    await tab.setContent(page(text(first), text(second), t('meta', 'og_image_tagline')));
    await tab.evaluate(fit);
    const file = lang === 'en' ? 'og-image.png' : `og-image-${lang}.png`;
    await tab.screenshot({ path: join(ROOT, file), type: 'png' });
    console.log(`✓ ${file}`);
  }
} finally {
  await browser.close();
}
