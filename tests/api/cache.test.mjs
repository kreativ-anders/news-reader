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

describe('one entry per source', () => {
  it('addresses that lead to the same feed share its entry, each with its own source', async () => {
    const feedUrl = s.fx.url + '/feeds/rss.xml';
    const direct = await s.collect(feedUrl);
    assert.equal(direct.header('x-collector-cache'), 'MISS');
    const page = await s.collect(s.fx.url + '/pretender/');
    assert.equal(page.json.source.strategy, 'discovered');
    assert.equal(page.json.source.icon, s.fx.url + '/pretender/icon.png');

    const content = JSON.parse(readFileSync(cacheFile(feedUrl), 'utf8'));
    assert.ok(!('source' in content), 'the shared entry holds no source');
    assert.equal(JSON.parse(readFileSync(cacheFile(s.fx.url + '/pretender', 'src'), 'utf8')).key, feedUrl);

    const again = await s.collect(feedUrl);
    assert.equal(again.header('x-collector-cache'), 'HIT');
    assert.equal(again.json.meta.cachedAt, page.json.meta.cachedAt, 'the feed is served from the entry the page refreshed');
    assert.equal(again.json.source.inputUrl, feedUrl);
    assert.equal(again.json.source.icon, s.fx.url + '/blog/icon.png', 'a page cannot plant its icon for the feed');
    assert.deepEqual(again.json.entries, page.json.entries);
  });

  it('full text is found through any address of the feed', async () => {
    const page = await s.collect(s.fx.url + '/pretender/');
    const e = page.json.entries[0];
    const r = await s.get(`/api/article?url=${encodeURIComponent(e.url)}&feed=${encodeURIComponent(s.fx.url + '/pretender/')}&id=${e.id}`);
    assert.equal(r.header('x-article-source'), 'feed');
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

describe('stale feed copies', () => {
  const plant = (url) => {
    writeFileSync(cacheFile(url, 'src'), JSON.stringify({
      key: url,
      source: { inputUrl: url, url, feedUrl: url, type: 'rss', strategy: 'direct', title: 'Kept' },
      cachedAt: Math.floor(Date.now() / 1000) - 2 * 86400,
      schema: SCHEMA,
    }));
    writeFileSync(cacheFile(url), JSON.stringify({
      entries: [{ id: 'e1', url: url + '#1', title: 'Kept entry' }],
      meta: { fetchedAt: new Date().toISOString() },
      cachedAt: Math.floor(Date.now() / 1000) - 2 * 86400,
      schema: SCHEMA,
    }));
    return url;
  };

  it('a failed refresh serves the older copy and says why, with the upstream status', async () => {
    const r = await s.collect(plant(s.fx.url + '/missing?stale'));
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.header('x-collector-cache'), 'STALE');
    assert.equal(r.json.meta.stale, true);
    assert.equal(r.json.entries[0].title, 'Kept entry');
    assert.deepEqual(r.json.meta.lastError, { code: 'UPSTREAM_HTTP_ERROR', message: 'The source returned HTTP 404.', upstreamStatus: 404 });
  });

  it('a fetch failure without an HTTP status has no upstreamStatus', async () => {
    const r = await s.collect(plant('http://127.0.0.1:1/feed?stale'));
    assert.equal(r.header('x-collector-cache'), 'STALE');
    assert.equal(r.json.meta.lastError.code, 'UPSTREAM_FETCH_FAILED');
    assert.ok(!('upstreamStatus' in r.json.meta.lastError));
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
