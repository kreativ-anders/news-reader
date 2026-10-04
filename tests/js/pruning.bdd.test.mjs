// Gherkin: gherkin/executable/pruning.feature
// Source: app/js/sync.js (prunable, slim)
import assert from 'node:assert/strict';
import { prunable, slim } from '../../app/js/sync.js';
import { runFeature } from '../support/gherkin.mjs';

const NOW = 1_800_000_000_000;
const DAY = 864e5;
const RECORDS = {
  'unfollowed feed': { kind: 'feed', data: { url: 'u', d: 1 } },
  'followed feed': { kind: 'feed', data: { url: 'u' } },
  device: { kind: 'device', data: {} },
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
});
