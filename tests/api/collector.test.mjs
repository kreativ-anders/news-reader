// /api/collect – resolution strategies, errors, cache and HTTP contract (lab profile: private hosts allowed).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { servers, assertCollectorShape, assertError } from './helpers.mjs';

const s = servers('lab');

describe('service', () => {
  it('without url: service info (used by News → Settings → Test)', async () => {
    const r = await s.get('/api/collect');
    assert.equal(r.status, 400);
    assert.equal(r.json.service, 'collector');
    assert.equal(r.json.sync, true);
    assert.match(r.json.version, /^\d+\.\d+\.\d+$/);
    assert.equal((await s.get('/api/')).json.service, 'collector', '/api/ alias');
  });

  it('CORS, content type and methods', async () => {
    const r = await s.get('/api/collect');
    assert.equal(r.header('access-control-allow-origin'), '*');
    assert.match(r.header('content-type'), /^application\/json/);
    assert.equal(r.header('x-content-type-options'), 'nosniff');
    assert.equal((await s.get('/api/collect', { method: 'OPTIONS' })).status, 204);
    assertError(await s.get('/api/collect', { method: 'POST' }), 405, 'METHOD_NOT_ALLOWED');
  });

  it('unknown endpoint → 404 JSON', async () => {
    assertError(await s.get('/api/nope'), 404, 'NOT_FOUND');
  });
});

describe('resolution strategies', () => {
  const cases = [
    ['/feeds/rss.xml', 'direct', 'rss', 4],
    ['/feeds/atom.xml', 'direct', 'atom', 3],
    ['/feeds/rdf.xml', 'direct', 'rdf', 2],
    ['/redirect-2', 'direct', 'rss', 4],
    ['/blog/', 'discovered', 'rss', 4],
    ['/guess/', 'guessed', 'atom', 3],
    ['/news/', 'sitemap', 'sitemap', 4],
    ['/jsonld/', 'html-jsonld', 'html', 3],
    ['/magazine/', 'html-article', 'html', 3],
    ['/links/', 'html-links', 'html', 3],
  ];
  for (const [path, strategy, type, count] of cases) {
    it(`${path} → ${strategy}`, async () => {
      const r = await s.collect(s.fx.url + path);
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assertCollectorShape(r.json);
      assert.equal(r.json.source.strategy, strategy);
      assert.equal(r.json.source.type, type);
      assert.equal(r.json.entries.length, count);
      assert.equal(r.json.source.inputUrl, s.fx.url + path);
    });
  }

  it('scheme is optional', async () => {
    const r = await s.collect(s.fx.url.replace('http://', '') + '/feeds/rdf.xml');
    // defaults to https:// – the fixture server only speaks http, so this must fail cleanly
    assertError(r, 422, 'UPSTREAM_FETCH_FAILED');
  });

  it('sitemap: slug titles replaced by link titles from the page', async () => {
    const r = await s.collect(s.fx.url + '/news/');
    const titles = r.json.entries.map((e) => e.title);
    assert.ok(titles.includes('Company opens a new office in Berlin'));
    assert.ok(titles.includes('Product Launch Day'), 'slug title for links not on the page');
  });

  it('html-links: missing dates filled from the sitemap', async () => {
    const r = await s.collect(s.fx.url + '/links/');
    const first = r.json.entries.find((e) => e.url.endsWith('/links/first-undated-story'));
    assert.ok(first.updatedAt, 'date from sitemap');
  });

  it('platform without feeds → PLATFORM_NO_FEED (platform is never contacted)', async () => {
    const r = await s.collect('https://x.com/someone');
    assertError(r, 422, 'PLATFORM_NO_FEED');
    assert.equal(r.json.error.rule, 'x-twitter');
  });
});

describe('errors', () => {
  it('invalid / unsupported URLs', async () => {
    assertError(await s.collect('http://'), 400, 'INVALID_URL');
    const ftp = await s.collect('ftp://example.org/feed');
    assert.equal(ftp.status, 400);
    assert.match(ftp.json.error.code, /^(INVALID_URL|UNSUPPORTED_URL)$/);
    const creds = await s.collect('https://user:pass@example.org/feed');
    assert.equal(creds.status, 400, 'URLs with credentials are refused');
    assertError(await s.collect('javascript:alert(1)'), 400, 'INVALID_URL');
  });

  it('upstream errors', async () => {
    assertError(await s.collect(s.fx.url + '/missing'), 422, 'UPSTREAM_HTTP_ERROR');
    assert.equal((await s.collect(s.fx.url + '/server-error')).json.error.upstreamStatus, 500);
    assert.equal((await s.collect(s.fx.url + '/forbidden')).json.error.upstreamStatus, 403);
    assertError(await s.collect(s.fx.url + '/loop'), 422, 'TOO_MANY_REDIRECTS');
    assertError(await s.collect(s.fx.url + '/too-large'), 422, 'UPSTREAM_TOO_LARGE');
    assertError(await s.collect(s.fx.url + '/slow'), 422, 'UPSTREAM_FETCH_FAILED');
    assertError(await s.collect('http://127.0.0.1:1/feed'), 422, 'UPSTREAM_FETCH_FAILED');
  });

  it('no feed → NO_FEED_DETECTED with the probed URLs', async () => {
    const r = await s.collect(s.fx.url + '/empty/');
    assertError(r, 422, 'NO_FEED_DETECTED');
    assert.ok(Array.isArray(r.json.error.tried) && r.json.error.tried.length > 0);
    assert.ok(r.json.error.tried.length <= 12 + 4, 'probes are capped');
    assertError(await s.collect(s.fx.url + '/text.txt'), 422, 'NO_FEED_DETECTED');
  });

  it('"no feed" is cached (protects the source)', async () => {
    const r = await s.collect(s.fx.url + '/empty/');
    assert.equal(r.header('x-collector-cache'), 'HIT');
    assert.equal(r.json.meta.cached, true);
  });
});

describe('cache', () => {
  it('MISS → HIT, limit, full text stripped', async () => {
    const url = s.fx.url + '/feeds/rss.xml?cache-test';
    const first = await s.collect(url);
    assert.equal(first.header('x-collector-cache'), 'MISS');
    assert.equal(first.json.meta.cached, false);
    const second = await s.collect(url, '&limit=2');
    assert.equal(second.header('x-collector-cache'), 'HIT');
    assert.equal(second.json.meta.cached, true);
    assert.equal(second.json.entries.length, 2);
    assert.deepEqual(second.json.entries.map((e) => e.id), first.json.entries.slice(0, 2).map((e) => e.id), 'stable ids');
    assert.match(second.header('cache-control'), /max-age=\d+/);
  });

  it('refresh=1 is ignored for young cache entries', async () => {
    const url = s.fx.url + '/feeds/atom.xml?refresh-test';
    await s.collect(url);
    const r = await s.collect(url, '&refresh=1');
    assert.equal(r.header('x-collector-cache'), 'HIT');
  });

  it('limit is clamped to 1..100', async () => {
    assert.equal((await s.collect(s.fx.url + '/feeds/rss.xml', '&limit=0')).json.entries.length, 1);
    assert.equal((await s.collect(s.fx.url + '/feeds/rss.xml', '&limit=abc')).json.entries.length, 1);
  });

  it('parallel requests for one URL all succeed', async () => {
    const url = s.fx.url + '/magazine/?parallel';
    const all = await Promise.all(Array.from({ length: 6 }, () => s.collect(url)));
    for (const r of all) assert.equal(r.status, 200);
  });
});

describe('regressions (formerly known issues)', () => {
  it('Atom <title type="html"> is returned as text without markup', async () => {
    const r = await s.collect(s.fx.url + '/feeds/atom.xml');
    assert.equal(r.json.entries[1].title, 'Atom entry two');
  });

  it('JSON-LD listings keep the page order (README: "HTML sources keep the page order")', async () => {
    const r = await s.collect(s.fx.url + '/jsonld/');
    assert.deepEqual(r.json.entries.map((e) => e.title), ['JSON-LD post one', 'JSON-LD post two', 'JSON-LD post three']);
  });
});
