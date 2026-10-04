// The example nginx configs, run by a real nginx against the repository: error page in the visitor's language, blocked paths.
// Gherkin: gherkin/site.feature, gherkin/server_protection.feature
// INFO: skipped when no nginx binary is installed – PHP-FPM is not needed, these requests never reach the API
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..', '..');
const NGINX = (() => {
  try { execFileSync('nginx', ['-v'], { stdio: 'ignore' }); return 'nginx'; } catch { return null; }
})();
const freePort = () => new Promise((resolve) => {
  const srv = createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

// INFO: only what a local run cannot have changes – TLS, Ploi includes, ports, paths; every map, location and error_page stays
function localConfig(file, dir, port, other) {
  return readFileSync(join(ROOT, file), 'utf8').split('\n')
    .filter((l) => !/^\s*(include \/etc\/nginx\/|ssl_|listen \[::\]|http2 on;|\{\{ssl\}\})/.test(l))
    .join('\n')
    .replace(/listen 443 ssl;|\{\{listen\}\}/g, `listen 127.0.0.1:${port};`)
    .replace(/listen 80;/g, `listen 127.0.0.1:${file.includes('ploi') ? port : other};`)
    .replace(/^(\s*)root [^;]+;/gm, `$1root "${ROOT}/";`)
    .replace(/^(\s*)(access_log|error_log)\s+[^;]+;/gm, `$1$2 "${dir}/$2.log";`)
    .replace(/include (?:fastcgi_params|"\{\{fastcgi\}\}");/g, `include "${dir}/fastcgi_params";`)
    .replace(/\{\{php\}\}/g, `unix:${dir}/php.sock`)
    .replace(/\{\{server_name\}\}/g, 'localhost')
    .replace(/\{\{log_dir\}\}/g, dir);
}

for (const file of ['nginx.ploi.conf.example', 'nginx.conf.example', 'wharf.conf.example']) {
  describe(`${file} under nginx`, { skip: !NGINX && 'nginx is not installed' }, () => {
    let dir, proc, base;
    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'news-reader-nginx-'));
      const [port, other] = await Promise.all([freePort(), freePort()]);
      writeFileSync(join(dir, 'fastcgi_params'), '');
      const temps = ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map((t) => `${t}_temp_path "${dir}/${t}";`).join(' ');
      writeFileSync(join(dir, 'nginx.conf'), `pid "${dir}/nginx.pid"; error_log "${dir}/error.log"; daemon off; events {}
http { types { text/html html; text/css css; text/javascript js mjs; application/json json; image/svg+xml svg; image/png png; } ${temps}
${localConfig(file, dir, port, other)}
}`);
      execFileSync(NGINX, ['-t', '-q', '-p', dir, '-c', join(dir, 'nginx.conf')], { stdio: 'pipe' });
      proc = spawn(NGINX, ['-p', dir, '-c', join(dir, 'nginx.conf')], { stdio: 'ignore' });
      base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 100; i++) {
        try { await fetch(base + '/'); return; } catch { await new Promise((r) => setTimeout(r, 50)); }
      }
      throw new Error('nginx did not start');
    });
    after(() => {
      proc?.kill();
      rmSync(dir, { recursive: true, force: true });
    });

    const get = async (path, lang) => {
      const res = await fetch(base + path, { headers: lang ? { 'Accept-Language': lang } : {}, redirect: 'manual' });
      return { status: res.status, text: await res.text(), csp: res.headers.get('content-security-policy') };
    };
    const page = (r) => r.text.match(/<html lang="([a-z]+)"/)?.[1];

    it('an unknown address gets the site 404 page, not the bare nginx page', async () => {
      const r = await get('/no-such-page');
      assert.equal(r.status, 404);
      assert.equal(page(r), 'en');
      assert.match(r.text, /data-track-view="Not found"/);
      assert.ok(!r.text.includes('<center>nginx</center>'));
      assert.match(r.csp, /default-src 'self'/);
    });

    it('blocked folders get it too – /gherkin, /src, /tests', async () => {
      for (const path of ['/gherkin', '/gherkin/sync.feature', '/src/config.php', '/tests/']) {
        const r = await get(path);
        assert.equal(r.status, 404, path);
        assert.equal(page(r), 'en', path);
        assert.ok(!r.text.includes('<?php') && !r.text.includes('Feature:'), path);
      }
    });

    it('the language of the address wins, then the first browser language', async () => {
      assert.equal(page(await get('/de/no-such-page')), 'de');
      assert.equal(page(await get('/fr/no-such-page', 'de-DE,de;q=0.9')), 'fr');
      assert.equal(page(await get('/gherkin', 'it-IT,it;q=0.9,en;q=0.8')), 'it');
      assert.equal(page(await get('/src/config.php', 'es')), 'es');
      assert.equal(page(await get('/gherkin', 'en-US,de;q=0.9')), 'en', 'only the first browser language counts');
      assert.equal(page(await get('/gherkin', 'pt-BR')), 'en', 'unsupported languages fall back to English');
    });

    it('the language pages themselves are served', async () => {
      assert.equal((await get('/')).status, 200);
      assert.equal((await get('/de/')).status, 200);
    });
  });
}
