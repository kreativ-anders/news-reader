// Test infrastructure shared by the API tests (node --test) and the E2E tests (Playwright).
//
//   sandbox  a throw-away copy of the repository with a patched src/config.php and its own var/,
//            so tests never touch the working tree, the real cache or real vaults
//   fixture  a PHP built-in server that plays "the internet" (tests/fixtures/router.php)
//   api      a PHP built-in server for the sandbox (tests/support/router.php ≈ nginx.conf.example)
//
// Profiles:
//   strict   production config (SSRF protection on, real rate limits)
//   lab      private hosts allowed (so the Collector can reach the fixture server), rate limits lifted

import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PHP = process.env.PHP_BIN || 'php';
const SKIP = new Set(['.git', '.github', 'node_modules', 'tests', 'var', 'test-results', 'playwright-report']);

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Copy the repository into a temp dir and patch its config. Returns the directory. */
export function makeSandbox(profile = 'lab', overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), `news-reader-${profile}-`));
  cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(ROOT, src);
      return rel === '' || !SKIP.has(rel.split(sep)[0]);
    },
  });
  for (const d of ['var/cache', 'var/sync', 'var/rate']) mkdirSync(join(dir, d), { recursive: true });
  cpSync(join(ROOT, 'tests/support/router.php'), join(dir, 'router.php'));

  const configFile = join(dir, 'src/config.php');
  let config = readFileSync(configFile, 'utf8');
  const set = (name, value) => {
    const re = new RegExp(`const ${name}(\\s*)=\\s*[^;]+;`);
    if (!re.test(config)) throw new Error(`config.php: constant ${name} not found – update tests/support/servers.mjs`);
    config = config.replace(re, `const ${name}$1= ${value};`);
  };
  if (profile === 'lab') {
    set('NR_ALLOW_PRIVATE_HOSTS', 'true');
    set('NR_CONNECT_TIMEOUT', '2');
    set('NR_REQUEST_TIMEOUT', '2');
    for (const name of ['NR_RATE_COLLECT_MISS', 'NR_RATE_ARTICLE_MISS', 'NR_RATE_SYNC', 'NR_RATE_SYNC_CREATE']) set(name, '[100000, 600]');
  }
  for (const [name, value] of Object.entries(overrides)) set(name, value);
  writeFileSync(configFile, config);
  return dir;
}

/** Start `php -S`. Resolves once the server answers. */
export async function startPhp({ docroot, router, port, workers = 4 }) {
  port ??= await freePort();
  const proc = spawn(PHP, ['-d', 'display_errors=stderr', '-d', 'log_errors=1', '-S', `127.0.0.1:${port}`, '-t', docroot, router], {
    cwd: docroot,
    env: { ...process.env, PHP_CLI_SERVER_WORKERS: String(workers) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const log = [];
  proc.stderr.on('data', (d) => {
    const s = String(d);
    log.push(s);
    // PHP fatals / warnings in a request are a test failure in themselves
    if (/PHP (Fatal|Parse|Warning|Deprecated|Notice)/.test(s)) process.stderr.write(`[php ${port}] ${s}`);
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`php -S exited (${proc.exitCode}): ${log.join('')}`);
    try { await fetch(url + '/'); break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { proc.kill(); throw new Error(`php -S did not start on ${url}`); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    port,
    /** PHP errors/warnings logged by the server so far */
    phpErrors: () => log.join('').split('\n').filter((l) => /PHP (Fatal|Parse|Warning|Deprecated|Notice)/.test(l)),
    stop: () => new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', resolve);
      proc.kill();
    }),
  };
}

export function startFixtures(opts = {}) {
  return startPhp({ docroot: join(ROOT, 'tests/fixtures/www'), router: join(ROOT, 'tests/fixtures/router.php'), ...opts });
}

/** Sandbox + API server. `stop()` also removes the sandbox. */
export async function startApi(profile = 'lab', overrides = {}) {
  const dir = makeSandbox(profile, overrides);
  const server = await startPhp({ docroot: dir, router: join(dir, 'router.php') });
  return {
    ...server,
    dir,
    stop: async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}
