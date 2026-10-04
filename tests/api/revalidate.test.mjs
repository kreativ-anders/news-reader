// ETag/304 for cached responses, conditional upstream refresh, cache size budget (lab profile).
// Gherkin: gherkin/collector_cache.feature
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { servers } from './helpers.mjs';

const s = servers('lab', { NR_REFRESH_MIN_AGE: '0', NR_CACHE_MAX_BYTES: '200000' });

describe('ETag / If-None-Match', () => {
  it('collect: a cached response is answered with 304 while it is unchanged', async () => {
    const url = s.fx.url + '/feeds/rss.xml?etag=1';
    const first = await s.collect(url);
    const etag = first.header('etag');
    assert.match(etag, /^W\/"[0-9a-f]{32}"$/);
    const hit = await s.collect(url);
    assert.equal(hit.header('x-collector-cache'), 'HIT');
    const tag = hit.header('etag');
    const again = await s.get(`/api/collect?url=${encodeURIComponent(url)}`, { headers: { 'If-None-Match': tag } });
    assert.equal(again.status, 304);
    assert.equal(again.text, '');
    assert.equal(again.header('etag'), tag);
    const other = await s.get(`/api/collect?url=${encodeURIComponent(url)}&limit=2`, { headers: { 'If-None-Match': tag } });
    assert.equal(other.status, 200, 'another limit is another representation');
  });

  it('article: page copies and feed full texts carry an ETag', async () => {
    const art = (u, init) => s.get(`/api/article?url=${encodeURIComponent(u)}`, init);
    const u = s.fx.url + '/article/second.html';
    await art(u);
    const hit = await art(u);
    assert.equal(hit.header('x-collector-cache'), 'HIT');
    const r = await art(u, { headers: { 'If-None-Match': hit.header('etag') } });
    assert.equal(r.status, 304);
  });
});

describe('conditional upstream refresh', () => {
  it('a refresh answered with 304 by the source keeps the entries and bumps cachedAt', async () => {
    const url = s.fx.url + '/etag-feed';
    const first = await s.collect(url);
    assert.equal(first.status, 200, first.text.slice(0, 200));
    await new Promise((r) => setTimeout(r, 1100));
    const refreshed = await s.collect(url, '&refresh=1');
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.header('x-collector-cache'), 'REVALIDATED');
    assert.deepEqual(refreshed.json.entries, first.json.entries);
    assert.ok(refreshed.json.meta.cachedAt > first.json.meta.cachedAt, 'cachedAt bumped');
    assert.equal(refreshed.json.upstream, undefined, 'validators stay on the server');
  });
});

describe('cache size budget', () => {
  it('the GC deletes the oldest cache files beyond NR_CACHE_MAX_BYTES', async () => {
    const dir = join(s.api.dir, 'var/cache');
    const now = Date.now() / 1000;
    const names = [];
    for (let i = 0; i < 6; i++) {
      const f = join(dir, `${'0'.repeat(63)}${i}.json`);
      writeFileSync(f, 'x'.repeat(60000));
      utimesSync(f, now - 86400 * (6 - i), now - 86400 * (6 - i)); // f0 oldest
      names.push(f);
    }
    rmSync(join(dir, '.gc'), { force: true });
    await s.collect(s.fx.url + '/feeds/rss.xml?etag=1');
    for (let i = 0; i < 50 && existsSync(names[0]); i++) await new Promise((r) => setTimeout(r, 100));
    const total = readdirSync(dir).filter((n) => !n.startsWith('.')).length;
    assert.ok(!existsSync(names[0]) && !existsSync(names[1]) && !existsSync(names[2]), 'oldest removed');
    assert.ok(existsSync(names[5]), 'newest kept');
    assert.ok(total > 0);
  });
});
