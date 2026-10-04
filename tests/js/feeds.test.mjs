// app/js/feeds.js – pure helpers. feedId() is part of the sync format: changing it orphans every synced feed.
// Gherkin: gherkin/feeds.feature
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeUrl, extractUrl, pool, buildOpml } from '../../app/js/feeds.js';

// INFO: addresses, share texts, feed ids and titles are specified in gherkin/executable/feed_identity.feature
test('missing input yields an empty address or link', () => {
  assert.equal(normalizeUrl(null), '');
  assert.equal(extractUrl(undefined), '');
});

test('pool: limit, order and errors', async () => {
  let running = 0, max = 0;
  const out = await pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++; max = Math.max(max, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    if (n === 3) throw new Error('boom');
    return n * 2;
  });
  assert.equal(max, 2);
  assert.deepEqual(out.map((r) => (r.ok ? r.value : r.error.message)), [2, 4, 'boom', 8, 10, 12]);
  assert.deepEqual(await pool([], 4, async () => 1), []);
});

test('buildOpml escapes and lists every feed', () => {
  const xml = buildOpml([{ url: 'https://a.test/feed?x=1&y=2', title: 'A <b>"quoted"</b>' }, { url: 'https://b.test/rss' }]);
  assert.match(xml, /^<\?xml version="1.0"/);
  assert.ok(xml.includes('xmlUrl="https://a.test/feed?x=1&amp;y=2"'));
  assert.ok(xml.includes('title="A &lt;b&gt;&quot;quoted&quot;&lt;/b&gt;"'));
  assert.ok(xml.includes('title="https://b.test/rss"'), 'URL as fallback title');
  assert.equal((xml.match(/<outline /g) || []).length, 2);
});

test('buildOpml nests feeds in folders', () => {
  const xml = buildOpml([{ url: 'https://a.test/feed', title: 'A', g: 'Tech & Co' }, { url: 'https://b.test/feed', title: 'B' }, { url: 'https://c.test/feed', title: 'C', g: 'Tech & Co' }]);
  assert.match(xml, /<outline text="Tech &amp; Co" title="Tech &amp; Co">\s*<outline [^>]*xmlUrl="https:\/\/a\.test\/feed"\/>\s*<outline [^>]*xmlUrl="https:\/\/c\.test\/feed"\/>\s*<\/outline>/);
  assert.equal((xml.match(/xmlUrl=/g) || []).length, 3);
});
