// app/js/feeds.js – pure helpers. feedId() is part of the sync format: changing it orphans every synced feed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeUrl, extractUrl, feedId, pool, buildOpml } from '../../app/js/feeds.js';

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('example.com/blog'), 'https://example.com/blog');
  assert.equal(normalizeUrl('  HTTP://Example.COM/A#frag '), 'http://example.com/A');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('ftp://example.com/x'), '');
  assert.equal(normalizeUrl('javascript:alert(1)'), '');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl(null), '');
  assert.equal(normalizeUrl('http://'), '');
});

test('extractUrl (share sheet text)', () => {
  assert.equal(extractUrl('Look at this: https://example.com/post?id=1). Nice!'), 'https://example.com/post?id=1');
  assert.equal(extractUrl('no link here'), '');
  assert.equal(extractUrl(undefined), '');
});

test('feedId is stable (sync compatibility)', () => {
  // Pinned values – if this fails, existing vaults would get duplicate feeds.
  assert.equal(feedId('https://example.com/feed'), 'fkpzfzrvmzd');
  assert.equal(feedId('example.com/feed/'), 'fkpzfzrvmzd', 'scheme and trailing slash do not matter');
  assert.equal(feedId('https://EXAMPLE.com/feed#x'), 'fkpzfzrvmzd', 'host case and fragment do not matter');
  assert.notEqual(feedId('https://example.com/feed2'), feedId('https://example.com/feed'));
  assert.match(feedId('https://a.test/'), /^f[0-9a-z]+$/);
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
