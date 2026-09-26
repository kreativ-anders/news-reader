// Every JavaScript file of the app and site parses (ES modules as modules, the service worker as a script).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../support/servers.mjs';

const check = (code, type) => spawnSync(process.execPath, ['--input-type=' + type, '--check'], { input: code, encoding: 'utf8' });

for (const f of readdirSync(join(ROOT, 'app/js')).filter((f) => f.endsWith('.js'))) {
  test(`app/js/${f} parses as ES module`, () => {
    const r = check(readFileSync(join(ROOT, 'app/js', f), 'utf8'), 'module');
    assert.equal(r.status, 0, r.stderr);
  });
}

test('site.js parses as ES module', () => {
  const r = check(readFileSync(join(ROOT, 'site.js'), 'utf8'), 'module');
  assert.equal(r.status, 0, r.stderr);
});

for (const f of ['app/sw.js', 'app/vendor/qrcode.js']) {
  test(`${f} parses as script`, () => {
    const r = check(readFileSync(join(ROOT, f), 'utf8'), 'commonjs');
    assert.equal(r.status, 0, r.stderr);
  });
}

// inline <script> blocks of the site and the app
const SITE_PAGES = ['index.html', 'privacy.html', 'imprint.html', 'thanks.html']
  .flatMap((p) => ['', 'de/', 'fr/', 'it/', 'es/'].map((dir) => dir + p));
for (const page of [...SITE_PAGES, 'app/index.html', 'docs/api/index.html', '404.html']) {
  test(`${page}: inline scripts parse`, () => {
    const html = readFileSync(join(ROOT, page), 'utf8');
    for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const [, attrs, code] = m;
      if (/src=|application\/ld\+json/.test(attrs) || !code.trim()) continue;
      const r = check(code, /type="module"/.test(attrs) ? 'module' : 'commonjs');
      assert.equal(r.status, 0, `${page}: ${r.stderr}`);
    }
  });
  test(`${page}: JSON-LD blocks are valid JSON`, () => {
    const html = readFileSync(join(ROOT, page), 'utf8');
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) JSON.parse(m[1]);
  });
}
