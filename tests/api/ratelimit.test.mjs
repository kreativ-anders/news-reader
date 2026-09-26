// Rate limits of the Collector and the article endpoint (lab profile with tiny limits).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { servers, assertError } from './helpers.mjs';

const s = servers('lab', { NR_RATE_COLLECT_MISS: '[3, 600]', NR_RATE_ARTICLE_MISS: '[2, 600]' });

describe('rate limits', () => {
  it('Collector: only upstream fetches count; cache hits stay free; 429 + Retry-After', async () => {
    const feed = s.fx.url + '/feeds/rss.xml';
    for (let i = 0; i < 3; i++) assert.equal((await s.collect(`${feed}?miss=${i}`)).status, 200);
    // cache hits do not count
    for (let i = 0; i < 5; i++) assert.equal((await s.collect(`${feed}?miss=0`)).header('x-collector-cache'), 'HIT');
    const limited = await s.collect(`${feed}?miss=99`);
    assertError(limited, 429, 'RATE_LIMITED');
    assert.ok(Number(limited.header('retry-after')) > 0);
  });

  it('Articles: page fetches limited, feed full text stays free', async () => {
    const feedUrl = s.fx.url + '/feeds/rss.xml?miss=0';
    const entry = (await s.collect(feedUrl)).json.entries[0];
    const art = (u, extra = '') => s.get(`/api/article?url=${encodeURIComponent(u)}${extra}`);
    assert.equal((await art(s.fx.url + '/article/second.html')).status, 200);
    assert.equal((await art(s.fx.url + '/article/oldest.html')).status, 200);
    assertError(await art(s.fx.url + '/article/relative.html'), 429, 'RATE_LIMITED');
    const fromFeed = await art(entry.url, `&feed=${encodeURIComponent(feedUrl)}&id=${entry.id}`);
    assert.equal(fromFeed.status, 200);
    assert.equal(fromFeed.json.article.source, 'feed');
    assert.equal((await art(s.fx.url + '/article/second.html')).header('x-collector-cache'), 'HIT', 'cached copy still served');
  });
});
