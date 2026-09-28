// Files the browser needs: service worker shell, manifests, icons, versions.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../support/servers.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('service worker: every app-shell file exists (a missing file breaks install → no offline mode)', () => {
  const sw = read('app/sw.js');
  const shell = JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  assert.ok(shell.length > 10);
  for (const f of shell) {
    const p = f === './' ? 'app/index.html' : `app/${f}`;
    assert.ok(existsSync(join(ROOT, p)), `sw.js SHELL: ${f} does not exist`);
  }
  for (const f of readdirSync(join(ROOT, 'app/js')).filter((n) => n.endsWith('.js'))) {
    assert.ok(shell.includes(`js/${f}`), `app/js/${f} is not cached for offline use`);
  }
});

test('service worker cache version follows the app version', () => {
  const app = read('app/js/app.js').match(/(?:export )?const VERSION = '([^']+)'/)[1];
  const sw = read('app/sw.js').match(/const VERSION = 'news-([^']+)'/)[1];
  assert.equal(sw, app, 'bump VERSION in app/sw.js together with app/js/app.js');
});

for (const [file, base] of [['app/manifest.webmanifest', 'app/'], ['site.webmanifest', '']]) {
  test(`${file}: valid, icons exist`, () => {
    const m = JSON.parse(read(file));
    assert.ok(m.name && m.icons?.length, 'name and icons');
    for (const i of m.icons) assert.ok(existsSync(join(ROOT, base, i.src.replace(/^\.?\//, ''))), `icon ${i.src}`);
    if (file.startsWith('app/')) {
      assert.ok(m.start_url && m.display, 'start_url / display');
      assert.ok(m.icons.some((i) => /maskable/.test(i.purpose || '')), 'maskable icon');
      if (m.share_target) assert.ok(m.share_target.action && m.share_target.params, 'share_target');
    }
  });
}

test('app icon: one design for iOS and Android, opaque where iOS or a mask fills the corners', () => {
  const png = (p) => { const b = readFileSync(join(ROOT, p)); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha: b[25] === 4 || b[25] === 6, b }; };
  for (const [p, size, opaque] of [['apple-touch-icon.png', 180, true], ['app/icons/maskable-512.png', 512, true], ['icon-192.png', 192, false], ['icon-512.png', 512, false]]) {
    const i = png(p);
    assert.equal(i.w, size, p);
    assert.equal(i.h, size, p);
    if (opaque) assert.ok(!i.alpha, `${p}: no alpha – iOS fills transparency with black`);
  }
  for (const [f, a] of [['apple-touch-icon.png', 'apple-touch-icon-v3.png'], ['icon-192.png'], ['icon-512.png']]) assert.ok(png(f).b.equals(png(`app/icons/${a || f}`).b), `${f}: site and app/icons differ`);
  for (const old of ['apple-touch-icon.png', 'apple-touch-icon-v2.png']) assert.ok(!existsSync(join(ROOT, 'app/icons', old)), `app/icons/${old}: touch icon keeps a new name – iOS caches the previous design under the old name`);
  assert.match(read('app/index.html'), /rel="apple-touch-icon" href="icons\/apple-touch-icon-v3\.png"/);
  assert.ok(!existsSync(join(ROOT, 'brand/news-icon-dark.svg')), 'no separate dark app icon – iOS and manifests cannot switch it');
});

test('app/index.html references existing local files', () => {
  const html = read('app/index.html');
  for (const m of html.matchAll(/(?:href|src)="([^"#:]+)"/g)) {
    if (m[1] === './') continue;
    assert.ok(existsSync(join(ROOT, 'app', m[1])), `app/index.html → ${m[1]}`);
  }
});

test('committed config keeps production defaults', () => {
  const cfg = read('src/config.php');
  assert.match(cfg, /const NR_ALLOW_PRIVATE_HOSTS\s*=\s*false;/, 'SSRF protection must be on');
  assert.match(cfg, /const NR_SYNC_ALLOWED_NETS\s*=\s*\[\];/);
  assert.match(cfg, /const NR_CA_BUNDLE\s*=\s*'';/);
});

test('versions: README / config / app agree on format', () => {
  assert.match(read('src/config.php'), /const NR_VERSION\s*=\s*'\d+\.\d+\.\d+';/);
  assert.match(read('app/js/app.js'), /(?:export )?const VERSION = '\d+\.\d+\.\d+';/);
});
