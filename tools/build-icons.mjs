// INFO: renders the app and site icons from brand/news-icon.svg (rounded) and brand/news-icon-full.svg (full bleed):
//       node tools/build-icons.mjs
//       iOS caches the touch icon by URL – after a design change bump TOUCH (and app/index.html, app/sw.js, the asset test).
//       Uses the Playwright Chromium from the test tooling – no extra dependency.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOUCH = 'apple-touch-icon-v3.png';
const svg = (f) => readFileSync(join(ROOT, 'brand', f), 'utf8').replace(/<title>.*?<\/title>/, '');

// INFO: full bleed without alpha – iOS fills transparency with black and a mask cuts the corners itself
const ICONS = [
  ['news-icon-full.svg', 180, true, ['apple-touch-icon.png', `app/icons/${TOUCH}`]],
  ['news-icon-full.svg', 512, true, ['app/icons/maskable-512.png']],
  ['news-icon.svg', 192, false, ['icon-192.png', 'app/icons/icon-192.png']],
  ['news-icon.svg', 512, false, ['icon-512.png', 'app/icons/icon-512.png']],
];

const browser = await chromium.launch();
try {
  for (const [src, size, opaque, out] of ICONS) {
    const tab = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await tab.setContent(`<!doctype html><style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg(src)}`);
    const png = await tab.screenshot({ type: 'png', omitBackground: !opaque });
    await tab.close();
    for (const f of out) { writeFileSync(join(ROOT, f), png); console.log(`✓ ${f}`); }
  }
} finally {
  await browser.close();
}
