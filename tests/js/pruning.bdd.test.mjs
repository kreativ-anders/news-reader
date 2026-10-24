// Gherkin: gherkin/executable/pruning.feature
// Source: app/js/sync.js (prunable, slim, carried, snapshot, syncFill)
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { prunable, slim, carried, snapshot, syncFill } from '../../app/js/sync.js';
import { runFeature } from '../support/gherkin.mjs';

const NOW = 1_800_000_000_000;
const DAY = 864e5;
const RECORDS = {
  'unfollowed feed': { kind: 'feed', data: { url: 'u', d: 1 } },
  'followed feed': { kind: 'feed', data: { url: 'u' } },
  device: { kind: 'device', data: {} },
};
const iso = (ts) => new Date(ts).toISOString();
const post = (feedId, ts, n = 1) => ({ id: 'e' + n, feedId, url: 'https://x', title: 'Title', image: 'https://img', publishedAt: iso(ts), firstSeen: NOW });
const followed = (feedId) => ({ kind: 'feed', id: feedId, updatedAt: NOW, data: { url: 'u' } });
const travels = (w) => carried(w.entries, w.records, NOW);
const CASES = {
  'already has a decision': (w) => w.records.push({ kind: 'item', id: 'e1', updatedAt: NOW, data: { s: 'dismissed' } }),
  'belongs to a feed I do not follow': (w) => { w.records[0].data.d = 1; },
  'was published 14 days ago': (w) => { w.entries[0].publishedAt = iso(NOW - 14 * DAY); },
  'has no date': (w) => { w.entries[0].publishedAt = null; },
  'is dated in the future': (w) => { w.entries[0].publishedAt = iso(NOW + 3600e3); w.entries[0].firstSeen = NOW + 7200e3; },
  'is dated after this device saw it': (w) => { w.entries[0].firstSeen = NOW - 4 * DAY; },
};

// INFO: deterministic heavy reader – random ids and image names do not compress, like real ones
const SEALING = 4 + 1 + 12 + 16; // magic + flags + IV + GCM tag, around the gzip of the snapshot
function heavyReader(decisions) {
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const rid = (n) => Array.from({ length: n }, () => (rnd() * 36 | 0).toString(36)).join('');
  const words = 'climate council budget vote river school police match season report study market energy price housing election court health water train city region minister team record festival museum company workers strike storm'.split(' ');
  const feeds = Array.from({ length: 66 }, (_, i) => ({ id: rid(13), host: `news${i}.example.org` }));
  const story = (i) => {
    const f = feeds[i % feeds.length];
    const t = Array.from({ length: 6 + (rnd() * 8 | 0) }, () => words[rnd() * words.length | 0]).join(' ');
    return { f: f.id, t, u: `https://${f.host}/2026/${t.replaceAll(' ', '-')}-${rid(6)}`, i: `https://cdn.${f.host}/img/${rid(24)}.jpg`, p: iso(NOW - rnd() * 14 * DAY) };
  };
  const records = feeds.map((f) => ({ kind: 'feed', id: f.id, updatedAt: NOW - 90 * DAY, data: { url: `https://${f.host}/feed`, title: f.host, since: NOW - 200 * DAY, added: NOW - 200 * DAY } }));
  for (let n = 0; n < decisions; n++) {
    const x = rnd(), s = x < 0.6 ? 'dismissed' : x < 0.85 ? 'done' : x < 0.95 ? 'new' : 'later';
    const keep = { dismissed: 29, new: 29, done: 179, later: 999 }[s];
    records.push({ kind: 'item', id: rid(13), updatedAt: Math.round(NOW - rnd() * keep * DAY), data: { s, ...story(n) } });
  }
  const entries = Array.from({ length: 1000 }, (_, n) => {
    const p = story(n);
    return { id: rid(13), feedId: p.f, url: p.u, title: p.t, image: p.i, publishedAt: p.p, firstSeen: NOW };
  });
  return [...records.filter((r) => !prunable(r, NOW)), ...carried(entries, records, NOW)];
}

runFeature('gherkin/executable/pruning.feature', (s) => {
  s.step('an item in state {string} last changed {int} days ago', (w, state, days) => {
    w.record = { kind: 'item', id: 'i1', updatedAt: NOW - days * DAY, data: { s: state } };
  });
  s.step(/^an? (unfollowed feed|followed feed|device) last changed (-?\d+) days ago$/, (w, kind, days) => {
    w.record = { ...RECORDS[kind], id: 'r1', updatedAt: NOW - Number(days) * DAY };
  });
  s.step(/^it is (kept|pruned)$/, (w, verdict) => assert.equal(prunable(w.record, NOW), verdict === 'pruned'));

  s.step('an item in state {string} with feed, title, address, date and image', (w, state) => {
    w.record = { kind: 'item', id: 'i1', updatedAt: NOW, data: { s: state, f: 'f1', t: 'Title', u: 'https://x', p: '2026-01-01', i: 'https://img' } };
  });
  s.step('it is slimmed for the sync data', (w) => { w.slim = slim(w.record); });
  s.step(/^its data is (.+)$/, (w, json) => assert.deepEqual(w.slim.data, JSON.parse(json)));
  s.step('the local item still has its image', (w) => assert.equal(w.record.data.i, 'https://img'));
  s.step('it is unchanged', (w) => assert.deepEqual(w.slim, w.record));

  s.step('an unsorted post of a followed feed {string} published {int} days ago', (w, feedId, days) => {
    w.entries = [post(feedId, NOW - days * DAY)];
    w.records = [followed(feedId)];
  });
  s.step('an unsorted post that travels with the sync data', (w) => {
    [w.record] = carried([post('f1', NOW - DAY)], [followed('f1')], NOW);
  });
  s.step(/^the post (.+)$/, (w, c) => CASES[c](w));
  s.step('it travels with the sync data', (w) => assert.deepEqual(travels(w).map((r) => r.id), ['e1']));
  s.step('it does not travel with the sync data', (w) => assert.deepEqual(travels(w), []));
  s.step(/^its sync data is (.+)$/, (w, json) => {
    assert.deepEqual(travels(w)[0].data, JSON.parse(json.replace('<published>', w.entries[0].publishedAt)));
  });
  s.step('its sync record is dated when the post was published, so any decision made after seeing it wins', (w) => {
    assert.equal(travels(w)[0].updatedAt, Date.parse(w.entries[0].publishedAt));
  });
  s.step('{int} unsorted posts of a followed feed published within the last days', (w, n) => {
    w.entries = Array.from({ length: n }, (_, i) => post('f1', NOW - (i + 1) * 60e3, i));
    w.records = [followed('f1')];
  });
  s.step('the newest {int} travel with the sync data', (w, n) => {
    assert.deepEqual(travels(w).map((r) => r.id), w.entries.slice(0, n).map((e) => e.id));
  });

  s.step(/^(\d+) decisions within the pruning periods: .+$/, (w, n) => { w.records = heavyReader(Number(n)); });
  s.step('the sealed sync data stays below {int} bytes', (w, max) => {
    const size = gzipSync(JSON.stringify(snapshot(w.records, NOW))).length + SEALING;
    assert.ok(size < max, `${size} bytes`);
  });

  s.step(/^the sync data has (\d+) bytes and the server allows (\d+|nothing \(old server\))$/, (w, bytes, max) => {
    w.fill = syncFill({ bytes: Number(bytes), max: max.startsWith('nothing') ? undefined : Number(max) });
  });
  s.step('this device has not read or written sync data yet', (w) => { w.fill = syncFill(null); });
  s.step('it is shown as {int} % full', (w, percent) => assert.equal(w.fill.percent, percent));
  s.step(/^it (is shown|is not shown) as nearly full$/, (w, verdict) => assert.equal(w.fill.nearlyFull, verdict === 'is shown'));
  s.step('no fill level is shown', (w) => assert.equal(w.fill, null));
});
