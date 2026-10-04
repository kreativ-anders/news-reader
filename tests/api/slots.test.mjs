// Upstream fetch slots: slow sources must not tie up every PHP worker (lab profile, one slot).
// Gherkin: gherkin/server_protection.feature
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { servers, assertError } from './helpers.mjs';

// INFO: a small collect limit shows that BUSY answers are not counted against it
const s = servers('lab', { NR_UPSTREAM_SLOTS: '1', NR_RATE_COLLECT_MISS: '[3, 600]' });

describe('upstream slots', () => {
  it('while all slots are busy, a cache miss gets 503 BUSY + Retry-After; cache hits are served', async () => {
    const cachedUrl = s.fx.url + '/feeds/rss.xml?slots=hit';
    assert.equal((await s.collect(cachedUrl)).status, 200);
    const slow = s.collect(s.fx.url + '/slow');
    await new Promise((r) => setTimeout(r, 300));
    const busy = await s.collect(s.fx.url + '/feeds/rss.xml?slots=miss');
    assertError(busy, 503, 'BUSY');
    assert.equal(busy.header('retry-after'), '10');
    for (let i = 0; i < 4; i++) assertError(await s.collect(s.fx.url + `/feeds/rss.xml?slots=busy${i}`), 503, 'BUSY');
    const art = await s.get(`/api/article?url=${encodeURIComponent(s.fx.url + '/article/second.html')}`);
    assertError(art, 503, 'BUSY');
    assert.equal((await s.collect(cachedUrl)).header('x-collector-cache'), 'HIT');
    await slow;
    assert.equal((await s.collect(s.fx.url + '/feeds/rss.xml?slots=miss')).status, 200, 'slot released, BUSY answers did not use up the rate limit');
  });
});
