// Shared URL cache: cached errors, bounded lock waits, stale copies (lab profile).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROOT } from '../support/servers.mjs';
import { servers, assertError } from './helpers.mjs';

const s = servers('lab', { NR_LOCK_WAIT: '0.5' });
const article = (url) => s.get(`/api/article?url=${encodeURIComponent(url)}`);
const SCHEMA = Number(readFileSync(join(ROOT, 'src/config.php'), 'utf8').match(/const NR_CACHE_SCHEMA\s*=\s*(\d+)/)[1]);

// INFO: same key as nr_cache_path() – callers pass URLs that are already normalized
const cacheFile = (normUrl, ns = '') => join(s.api.dir, 'var/cache', createHash('sha256').update((ns ? ns + '|' : '') + normUrl).digest('hex') + '.json');

describe('cached errors', () => {
  it('a temporary upstream failure is cached briefly', async () => {
    const url = 'http://127.0.0.1:1/feed';
    const first = await s.collect(url);
    assertError(first, 422, 'UPSTREAM_FETCH_FAILED');
    assert.equal(first.json.meta.cached, false);

    const again = await s.collect(url);
    assertError(again, 422, 'UPSTREAM_FETCH_FAILED');
    assert.equal(again.header('x-collector-cache'), 'HIT');
    const maxAge = Number(again.header('cache-control').match(/max-age=(\d+)/)[1]);
    assert.ok(maxAge > 0 && maxAge <= 120, `short max-age, got ${maxAge}`);
  });

  it('a permanent upstream error (404) is not cached by the Collector', async () => {
    await s.collect(s.fx.url + '/missing');
    const again = await s.collect(s.fx.url + '/missing');
    assertError(again, 422, 'UPSTREAM_HTTP_ERROR');
    assert.equal(again.json.meta.cached, false);
  });

  it('article: an upstream 5xx is cached briefly, with its status', async () => {
    const r = await article(s.fx.url + '/server-error');
    assertError(r, 422, 'UPSTREAM_HTTP_ERROR');
    assert.equal(r.json.error.upstreamStatus, 500);
    const entry = JSON.parse(readFileSync(cacheFile(s.fx.url + '/server-error', 'article'), 'utf8'));
    assert.equal(entry.ttl, 120);
    assert.equal((await article(s.fx.url + '/server-error')).header('x-collector-cache'), 'HIT');
  });
});

describe('concurrent fetches of one URL', () => {
  it('a waiting request gives up after NR_LOCK_WAIT with 503 BUSY', async () => {
    const url = s.fx.url + '/slow';
    const first = s.collect(url);
    await new Promise((r) => setTimeout(r, 300));
    const second = await s.collect(url);
    assertError(second, 503, 'BUSY');
    assert.equal(second.header('retry-after'), '10');
    assertError(await first, 422, 'UPSTREAM_FETCH_FAILED');
  });
});

describe('stale article copies', () => {
  it('a failed re-fetch keeps and serves the older copy', async () => {
    const url = s.fx.url + '/empty/';
    const file = cacheFile(s.fx.url + '/empty', 'article');
    const old = {
      article: { url, title: 'Kept', byline: null, siteName: null, lang: null, publishedAt: null, image: null, content: '<p>kept</p>', words: 1, source: 'page', partial: false },
      cachedAt: Math.floor(Date.now() / 1000) - 30 * 86400,
      schema: SCHEMA,
    };
    writeFileSync(file, JSON.stringify(old));

    const r = await article(url);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.header('x-collector-cache'), 'STALE');
    assert.equal(r.json.article.title, 'Kept');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), old, 'the cache entry is not replaced by the error');
  });
});
