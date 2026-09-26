// /api/article – offline copies for "Later" (lab profile).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { servers, assertError } from './helpers.mjs';

const s = servers('lab');
const article = (url, extra = '') => s.get(`/api/article?url=${encodeURIComponent(url)}${extra}`);

function assertArticleShape(a) {
  for (const k of ['url', 'title', 'byline', 'siteName', 'lang', 'publishedAt', 'image', 'content', 'words', 'source', 'partial']) assert.ok(k in a, `article.${k}`);
  assert.match(a.source, /^(feed|page)$/);
  assert.equal(typeof a.content, 'string');
  assert.ok(!/<script|onerror|onclick|javascript:/i.test(a.content), 'sanitized');
}

describe('article', () => {
  it('without url: service info', async () => {
    const r = await s.get('/api/article');
    assert.equal(r.status, 400);
    assert.equal(r.json.service, 'article');
  });

  it('full text from the cached feed (no page fetch)', async () => {
    const feedUrl = s.fx.url + '/feeds/rss.xml';
    const feed = await s.collect(feedUrl);
    const entry = feed.json.entries[0];
    assert.equal(entry.title, 'Newest post with full text');
    const r = await article(entry.url, `&feed=${encodeURIComponent(feedUrl)}&id=${entry.id}`);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.header('x-article-source'), 'feed');
    assertArticleShape(r.json.article);
    assert.equal(r.json.article.source, 'feed');
    assert.equal(r.json.article.siteName, 'Fixture Blog');
    assert.match(r.json.article.content, /<h2>Full text<\/h2>/);
  });

  it('extracted from the page, then cached', async () => {
    const url = s.fx.url + '/article/full.html';
    const r = await article(url);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assertArticleShape(r.json.article);
    assert.equal(r.json.article.source, 'page');
    assert.equal(r.json.article.title, 'A long read for offline reading');
    assert.equal(r.json.article.partial, false);
    assert.ok(r.json.article.words > 200);
    assert.equal(r.header('x-collector-cache'), 'MISS');
    assert.equal((await article(url)).header('x-collector-cache'), 'HIT');
  });

  it('paywall → partial', async () => {
    const r = await article(s.fx.url + '/article/paywall.html');
    assert.equal(r.json.article.partial, true);
  });

  it('errors', async () => {
    assertError(await article('not a url'), 400, 'INVALID_URL');
    assertError(await article('ftp://example.org/x'), 400, 'INVALID_URL');
    assertError(await article(s.fx.url + '/missing'), 422, 'UPSTREAM_HTTP_ERROR');
    assertError(await article(s.fx.url + '/feeds/atom.xml'), 422, 'NOT_AN_ARTICLE');
    assertError(await article(s.fx.url + '/empty/'), 422, 'NO_CONTENT');
    assertError(await s.get('/api/article?url=x', { method: 'PUT' }), 405, 'METHOD_NOT_ALLOWED');
  });
});
