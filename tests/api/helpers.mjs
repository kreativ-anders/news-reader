import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { startApi, startFixtures } from '../support/servers.mjs';

/**
 * Start fixture + API servers for one test file.
 * @returns {{api: object, fx: object, collect: Function, get: Function}} – filled in before()
 */
export function servers(profile = 'lab', overrides = {}) {
  const ctx = {};
  before(async () => {
    [ctx.fx, ctx.api] = await Promise.all([startFixtures(), startApi(profile, overrides)]);
  });
  after(async () => {
    const errors = [...(ctx.api?.phpErrors() || []), ...(ctx.fx?.phpErrors() || [])];
    await Promise.all([ctx.api?.stop(), ctx.fx?.stop()]);
    assert.deepEqual(errors, [], 'PHP logged errors/warnings during the tests');
  });
  ctx.get = async (path, init) => {
    const res = await fetch(ctx.api.url + path, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { res, status: res.status, json, text, header: (h) => res.headers.get(h) };
  };
  ctx.collect = (url, params = '') => ctx.get(`/api/collect?url=${encodeURIComponent(url)}${params}`);
  return ctx;
}

/** Response shape documented in the README ("Response"). Breaking it breaks every client. */
export function assertCollectorShape(json) {
  assert.equal(typeof json, 'object');
  for (const k of ['inputUrl', 'url', 'type', 'strategy', 'rule', 'feedUrl', 'title', 'siteUrl', 'icon']) assert.ok(k in json.source, `source.${k}`);
  assert.match(json.source.type, /^(rss|rdf|atom|html|sitemap|wordpress)$/);
  for (const k of ['siteUrl', 'icon']) if (json.source[k] !== null) assert.match(json.source[k], /^https?:\/\//, `source.${k}`);
  assert.match(json.source.strategy, /^(rule|direct|discovered|guessed|sitemap|html-jsonld|html-article|html-links|client)$/);
  assert.ok(Array.isArray(json.entries));
  for (const e of json.entries) {
    assert.deepEqual(Object.keys(e).sort(), ['author', 'id', 'image', 'publishedAt', 'summary', 'title', 'updatedAt', 'url'], 'entry keys (content must be stripped)');
    assert.match(e.id, /^[0-9a-f]{64}$/);
    assert.match(e.url, /^https?:\/\//);
    assert.equal(typeof e.title, 'string');
    for (const d of ['publishedAt', 'updatedAt']) if (e[d] !== null) assert.match(e[d], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  }
  for (const k of ['count', 'fetchedAt', 'cached', 'stale', 'cachedAt', 'nextRefreshAfter', 'version']) assert.ok(k in json.meta, `meta.${k}`);
  assert.equal(json.meta.count, json.entries.length);
}

export function assertError(r, status, code) {
  assert.equal(r.status, status, `HTTP status (${r.text.slice(0, 200)})`);
  assert.equal(r.json?.error?.code, code);
  assert.equal(typeof r.json.error.message, 'string');
}
