// Gherkin: gherkin/executable/vault_records.feature
// Source: app/js/db.js (validRecord, MAX_SKEW_MS)
import assert from 'node:assert/strict';
import { validRecord, MAX_SKEW_MS } from '../../app/js/db.js';
import { runFeature } from '../support/gherkin.mjs';

// INFO: JSON plus the two numbers JSON cannot write
const value = (s) => (s === 'NaN' ? NaN : s === 'Infinity' ? Infinity : JSON.parse(s));
const record = (w, kind, data, extra = {}) => ({ kind, id: 'r1', updatedAt: w.now, data, ...extra });

runFeature('gherkin/executable/vault_records.feature', (s) => {
  s.step('it is now {int}', (w, now) => { w.now = now; });

  s.step(/^an? "([^"]+)" record arrives with data (.+?) and "([^"]+)" set to (\S+)$/, (w, kind, data, field, v) => {
    w.record = record(w, kind, { ...value(data), [field]: value(v) });
  });
  s.step(/^an? "([^"]+)" record arrives with data (?!.* and "[^"]+" set to )(.+)$/, (w, kind, data) => {
    w.record = record(w, kind, value(data));
  });
  s.step(/^an "item" record with id (.+) arrives$/, (w, id) => {
    w.record = record(w, 'item', { s: 'new' }, { id: id === 'of 201 characters' ? 'x'.repeat(201) : value(id) });
  });
  s.step(/^the value (.+) arrives as a record$/, (w, v) => { w.record = value(v); });
  s.step(/^an item is changed at (.+)$/, (w, at) => {
    const updatedAt = { 'one day from now': w.now + MAX_SKEW_MS, 'one day and 1 ms from now': w.now + MAX_SKEW_MS + 1 }[at] ?? value(at);
    w.record = record(w, 'item', { s: 'new' }, { updatedAt });
  });

  s.step('the record is accepted', (w) => assert.equal(validRecord(w.record, w.now), true, JSON.stringify(w.record)));
  s.step('the record is dropped', (w) => assert.equal(validRecord(w.record, w.now), false, JSON.stringify(w.record)));
});
