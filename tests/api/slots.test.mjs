// Upstream fetch slots: slow sources must not tie up every PHP worker (lab profile, one slot).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { servers, assertError } from './helpers.mjs';

const s = servers('lab', { NR_UPSTREAM_SLOTS: '1' });

describe('upstream slots', () => {
  it('while all slots are busy, a cache miss gets 503 BUSY + Retry-After; cache hits are served', async () => {
    const cachedUrl = s.fx.url + '/feeds/rss.xml?slots=hit';
    assert.equal((await s.collect(cachedUrl)).status, 200);
    const slow = s.collect(s.fx.url + '/slow');
    await new Promise((r) => setTimeout(r, 300));
    const busy = await s.collect(s.fx.url + '/feeds/rss.xml?slots=miss');
    assertError(busy, 503, 'BUSY');
    assert.equal(busy.header('retry-after'), '10');
    const art = await s.get(`/api/article?url=${encodeURIComponent(s.fx.url + '/article/second.html')}`);
    assertError(art, 503, 'BUSY');
    assert.equal((await s.collect(cachedUrl)).header('x-collector-cache'), 'HIT');
    await slow;
    assert.equal((await s.collect(s.fx.url + '/feeds/rss.xml?slots=miss')).status, 200, 'slot released');
  });
});
