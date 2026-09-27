// INFO: sync client – record validation of vault data, future-timestamp guard, pruning, slim records, gzip cap
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { validRecord, MAX_SKEW_MS } from '../../app/js/db.js';
import { prunable, slim, gunzip } from '../../app/js/sync.js';

const NOW = 1_800_000_000_000;
const DAY = 864e5;
const item = (data, updatedAt = NOW) => ({ kind: 'item', id: 'i1', updatedAt, data });
const feed = (data, updatedAt = NOW) => ({ kind: 'feed', id: 'f1', updatedAt, data });
const device = (data, updatedAt = NOW) => ({ kind: 'device', id: 'd1', updatedAt, data });

test('valid records of every kind pass', () => {
  assert.ok(validRecord(feed({ url: 'https://example.org/feed', title: 'X', g: 'News', since: 1, added: 2 }), NOW));
  assert.ok(validRecord(feed({ url: 'https://example.org/feed', title: undefined, d: 1 }), NOW));
  for (const s of ['new', 'reading', 'later', 'done', 'dismissed']) assert.ok(validRecord(item({ s, f: 'f1', t: 'T', u: 'https://x', i: 'https://y', p: '2026-01-01T00:00:00Z' }), NOW), s);
  assert.ok(validRecord(item({ s: 'new' }), NOW));
  assert.ok(validRecord(device({ name: 'Phone', platform: 'iPhone', since: 1, seen: 2, pub: 'abc', r: 1 }), NOW));
  assert.ok(validRecord(item({ s: 'done', extra: { future: true } }), NOW), 'unknown fields are kept');
});

test('malformed records are rejected', () => {
  const bad = [
    null, 42, 'x', [], {},
    { kind: 'other', id: 'x', updatedAt: NOW, data: {} },
    { kind: 'item', id: 7, updatedAt: NOW, data: { s: 'new' } },
    { kind: 'item', id: '', updatedAt: NOW, data: { s: 'new' } },
    { kind: 'item', id: 'x'.repeat(201), updatedAt: NOW, data: { s: 'new' } },
    { kind: '__proto__', id: 'x', updatedAt: NOW, data: {} },
    item(null), item([]), item({ s: 'bogus' }), item({ s: 'done', t: 5 }), item({ s: 'done', u: {} }), item({ s: 'done', f: ['f'] }),
    feed({}), feed({ url: 5 }), feed({ url: 'u', since: 'x' }), feed({ url: 'u', added: Infinity }), feed({ url: 'u', d: 'yes' }), feed({ url: 'u', title: {} }),
    device({ pub: 5 }), device({ seen: NaN }), device({ name: [] }), device({ r: 2 }),
  ];
  for (const r of bad) assert.equal(validRecord(r, NOW), false, JSON.stringify(r));
});

test('timestamps: finite, not negative, at most one day ahead', () => {
  for (const t of [NaN, Infinity, -1, 9e15, '1', null, NOW + MAX_SKEW_MS + 1]) assert.equal(validRecord(item({ s: 'new' }, t), NOW), false, String(t));
  assert.ok(validRecord(item({ s: 'new' }, NOW + MAX_SKEW_MS), NOW));
  assert.ok(validRecord(item({ s: 'new' }, 0), NOW));
});

test('pruning periods: dismissed/new 30 days, done/unfollowed feeds/devices 180 days, the rest never', () => {
  const age = (d) => NOW - d * DAY;
  assert.equal(prunable(item({ s: 'dismissed' }, age(29)), NOW), false);
  assert.equal(prunable(item({ s: 'dismissed' }, age(30)), NOW), true);
  assert.equal(prunable(item({ s: 'new' }, age(31)), NOW), true);
  assert.equal(prunable(item({ s: 'done' }, age(100)), NOW), false);
  assert.equal(prunable(item({ s: 'done' }, age(181)), NOW), true);
  assert.equal(prunable(item({ s: 'later' }, age(999)), NOW), false);
  assert.equal(prunable(item({ s: 'reading' }, age(999)), NOW), false);
  assert.equal(prunable(feed({ url: 'u', d: 1 }, age(181)), NOW), true);
  assert.equal(prunable(feed({ url: 'u' }, age(999)), NOW), false);
  assert.equal(prunable(device({}, age(181)), NOW), true);
  assert.equal(prunable(item({ s: 'dismissed' }, NOW + DAY), NOW), false);
});

test('slim: dismissed items keep state, feed, title and URL; "new" only the state', () => {
  const full = { s: 'dismissed', f: 'f1', t: 'Title', u: 'https://x', p: '2026-01-01', i: 'https://img' };
  assert.deepEqual(slim(item(full)).data, { s: 'dismissed', f: 'f1', t: 'Title', u: 'https://x' });
  assert.deepEqual(slim(item({ ...full, s: 'new' })).data, { s: 'new' });
  assert.deepEqual(slim(item({ ...full, s: 'done' })).data, { ...full, s: 'done' });
  const r = item(full);
  slim(r);
  assert.equal(r.data.i, 'https://img', 'the input stays untouched');
  assert.equal(slim(feed({ url: 'u' })).data.url, 'u');
});

test('gunzip stops at the byte limit (gzip bomb)', async () => {
  const small = new TextEncoder().encode('{"v":1}');
  assert.deepEqual(await gunzip(gzipSync(small)), small);
  const bomb = gzipSync(Buffer.alloc(4 << 20));
  assert.ok(bomb.length < 10_000);
  await assert.rejects(gunzip(bomb, 1 << 20), (e) => e.code === 'format');
  assert.equal((await gunzip(bomb, 8 << 20)).length, 4 << 20);
});
