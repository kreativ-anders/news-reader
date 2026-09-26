// Translations: valid JSON, English complete, no stray keys, placeholders intact, every used key exists.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../support/servers.mjs';
import { LANGS, loadI18n } from '../../app/js/i18n.js';

const flat = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) =>
  v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]);
const load = (dir, lang) => JSON.parse(readFileSync(join(ROOT, dir, `${lang}.json`), 'utf8'));
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s) => [...String(s).matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase()).sort();

for (const dir of ['i18n', 'app/i18n']) {
  const files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

  test(`${dir}: one file per language in LANGS`, () => {
    assert.deepEqual(files, Object.keys(LANGS).sort());
  });

  const en = new Map(flat(load(dir, 'en')));
  test(`${dir}/en.json: only strings`, () => {
    for (const [k, v] of en) assert.equal(typeof v, 'string', `${k} must be a string`);
  });

  for (const lang of files.filter((l) => l !== 'en')) {
    test(`${dir}/${lang}.json: keys, placeholders and markup match English`, (t) => {
      const tr = flat(load(dir, lang));
      const missing = [...en.keys()].filter((k) => !tr.some(([key]) => key === k));
      for (const [k, v] of tr) {
        assert.ok(en.has(k), `${lang}: key "${k}" does not exist in en.json (typo or removed key)`);
        assert.equal(typeof v, 'string', `${lang}: ${k}`);
        assert.deepEqual(vars(v), vars(en.get(k)), `${lang}: placeholders of "${k}"`);
        assert.deepEqual(tags(v), tags(en.get(k)), `${lang}: HTML tags of "${k}"`);
      }
      if (missing.length) t.diagnostic(`${missing.length} keys fall back to English: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}`);
    });
  }
}

test('every data-i18n key used in the markup exists in en.json', () => {
  for (const [page, dir] of [['index.html', 'i18n'], ['privacy.html', 'i18n'], ['imprint.html', 'i18n'], ['thanks.html', 'i18n'], ['app/index.html', 'app/i18n']]) {
    const html = readFileSync(join(ROOT, page), 'utf8');
    const en = new Map(flat(load(dir, 'en')));
    const keys = [
      ...[...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]),
      ...[...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(';').map((p) => p.split(':')[1]?.trim())),
    ].filter(Boolean);
    assert.ok(keys.length > 0, page);
    for (const k of keys) assert.ok(en.has(k), `${page}: "${k}" missing in ${dir}/en.json`);
  }
});

test("every literal t('key') in the app exists in app/i18n/en.json", () => {
  const en = new Map(flat(load('app/i18n', 'en')));
  const has = (k) => en.has(k) || en.has(`${k}_one`) || en.has(`${k}_other`);
  for (const f of readdirSync(join(ROOT, 'app/js'))) {
    const src = readFileSync(join(ROOT, 'app/js', f), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'\s*[,)]/g)) {
      assert.ok(has(m[1]), `app/js/${f}: t('${m[1]}') has no translation`);
    }
  }
});

test('loadI18n: fallback per key, placeholders, plurals', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify({
    'x/en.json': { a: { hello: 'Hello {name}', only_en: 'English only', item_one: '{n} item', item_other: '{n} items' } },
    'x/de.json': { a: { hello: 'Hallo {name}', item_one: '{n} Eintrag', item_other: '{n} Einträge' } },
  }[url] ?? {}), { status: 200 });
  try {
    const t = await loadI18n('x', 'de');
    assert.equal(t.lang, 'de');
    assert.equal(t('a.hello', { name: 'Manuel' }), 'Hallo Manuel');
    assert.equal(t('a.only_en'), 'English only');
    assert.equal(t('a.item', { n: 1 }), '1 Eintrag');
    assert.equal(t('a.item', { n: 5 }), '5 Einträge');
    assert.equal(t('a.missing'), 'a.missing');
    assert.equal(t('a.hello'), 'Hallo {name}', 'unknown placeholders stay');
  } finally {
    globalThis.fetch = realFetch;
  }
});
