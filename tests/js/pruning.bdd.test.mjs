// Gherkin: gherkin/executable/pruning.feature
// Source: app/js/sync.js (prunable, slim, carried)
import assert from 'node:assert/strict';
import { prunable, slim, carried } from '../../app/js/sync.js';
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
});
