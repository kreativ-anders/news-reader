// Share images: every site language points og:image and twitter:image at its own 1200×630 PNG in the repo.
// Gherkin: gherkin/site.feature
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../support/servers.mjs';

const LANGS = ['en', 'de', 'fr', 'it', 'es'];
const meta = (html, attr) => html.match(new RegExp(`<meta ${attr} content="([^"]*)"`))?.[1];

for (const lang of LANGS) {
  const file = lang === 'en' ? 'og-image.png' : `og-image-${lang}.png`;

  test(`${file}: PNG, 1200×630, small enough for link previews`, () => {
    const png = readFileSync(join(ROOT, file));
    assert.equal(png.toString('latin1', 1, 4), 'PNG');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
    // INFO: WhatsApp drops preview images above ~300 KB
    assert.ok(png.length < 300_000, `${file} is ${png.length} bytes`);
  });

  const path = lang === 'en' ? 'index.html' : `${lang}/index.html`;
  test(`${path}: og:image and twitter:image use ${file}`, () => {
    const html = readFileSync(join(ROOT, path), 'utf8');
    const og = meta(html, 'property="og:image"');
    assert.match(og ?? '', new RegExp(`^https://[^/]+/${file.replace('.', '\\.')}$`));
    assert.equal(meta(html, 'name="twitter:image"'), og);
  });
}
