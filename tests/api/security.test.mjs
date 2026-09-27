// Production configuration (strict profile): SSRF protection, rate limits, blocked paths.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { servers, assertError } from './helpers.mjs';

const s = servers('strict');

describe('SSRF (production config)', () => {
  it('private, loopback and metadata addresses are refused by both endpoints', async () => {
    for (const url of [s.fx.url + '/feeds/rss.xml', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.1/', 'http://0.0.0.0/']) {
      const r = await s.collect(url);
      assert.equal(r.status, 400, url);
      assert.match(r.json.error.code, /^(FORBIDDEN_HOST|DNS_FAILED)$/, url);
      const a = await s.get(`/api/article?url=${encodeURIComponent(url)}`);
      assert.equal(a.status, 400, url);
    }
  });

  it('only web ports are allowed (NR_ALLOWED_PORTS)', async () => {
    for (const url of ['http://example.org:22/', 'http://example.org:6379/', 'https://example.org:25/feed']) {
      assertError(await s.collect(url), 400, 'FORBIDDEN_HOST');
    }
  });

  it('unresolvable host → DNS_FAILED', async () => {
    assertError(await s.collect('https://does-not-exist.invalid/feed'), 400, 'DNS_FAILED');
  });
});

describe('rate limits (production config)', () => {
  it('Sync: at most 5 new vaults per IP and day', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const body = Buffer.concat([Buffer.from('NRS1'), Buffer.from([0]), randomBytes(40)]);
      const r = await s.get('/api/sync', { method: 'PUT', body, headers: { Authorization: `Bearer ${randomBytes(32).toString('base64url')}`, 'If-None-Match': '*' } });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
  });

  it('only a salted hash of the IP is stored', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = `${s.api.dir}/var/rate`;
    for (const f of readdirSync(dir)) {
      if (f === '.salt' || f === '.gc') continue; // INFO: .gc holds the time of the last cleanup (src/gc.php)
      assert.match(f, /^[0-9a-f]{64}$/);
      assert.ok(!readFileSync(`${dir}/${f}`, 'utf8').includes('127.0.0.1'));
    }
  });
});

describe('never served', () => {
  for (const path of ['/src/config.php', '/src/sync.php', '/var/rate/.salt', '/tools/build-i18n.php', '/.gitignore', '/.git/config']) {
    it(path, async () => {
      const r = await s.get(path);
      assert.equal(r.status, 404);
      assert.ok(!r.text.includes('<?php'));
    });
  }
});
