// Rate limits of the Collector and the article endpoint (lab profile with tiny limits).
// Gherkin: gherkin/server_protection.feature
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

describe('IPv6 /48 and global buckets', () => {
  // INFO: php -S only listens on 127.0.0.1 – the limiter runs in the sandbox with faked client addresses
  const hits = (code) => JSON.parse(execFileSync(process.env.PHP_BIN || 'php', ['-r', `
    require 'src/config.php'; require 'src/response.php'; require 'src/ratelimit.php';
    $out = [];
    ${code}
    echo json_encode($out);`], { cwd: s.api.dir, encoding: 'utf8' }));

  it('many /64s of one /48 hit the /48 limit', () => {
    const r = hits(`for ($i = 0; $i < 6; $i++) {
      $_SERVER['REMOTE_ADDR'] = sprintf('2001:db8:aa:%x::1', $i);
      $out[] = nr_rate_hit_wide('t48', [2, 600], [4, 600]) === 0;
    }`);
    assert.deepEqual(r, [true, true, true, true, false, false]);
  });

  it('a /64 limit still applies inside a /48; IPv4 clients have no /48 bucket', () => {
    const r = hits(`$_SERVER['REMOTE_ADDR'] = '2001:db8:bb:1::1';
      for ($i = 0; $i < 3; $i++) $out[] = nr_rate_hit_wide('t64', [2, 600], [100, 600]) === 0;
      for ($i = 0; $i < 3; $i++) { $_SERVER['REMOTE_ADDR'] = '203.0.113.' . $i; $out[] = nr_rate_hit_wide('t4', [1, 600], [1, 600]) === 0; }`);
    assert.deepEqual(r, [true, true, false, true, true, true]);
  });

  it('the global sync-create bucket counts all clients together', () => {
    const r = hits(`for ($i = 0; $i < 4; $i++) {
      $_SERVER['REMOTE_ADDR'] = '198.51.100.' . $i;
      $out[] = nr_rate_hit('tall', [3, 600], '*') === 0;
    }`);
    assert.deepEqual(r, [true, true, true, false]);
  });
});
