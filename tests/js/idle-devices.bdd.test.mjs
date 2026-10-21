// Gherkin: gherkin/executable/idle_devices.feature
// Source: app/js/sync.js (isIdleDevice)
import assert from 'node:assert/strict';
import { isIdleDevice } from '../../app/js/sync.js';
import { runFeature } from '../support/gherkin.mjs';

const NOW = 1_800_000_000_000;
const DAY = 864e5;
const OWN = 'own';
const device = (id, data) => ({ kind: 'device', id, data: { name: 'Phone', platform: 'Phone', pub: 'p', ...data } });

runFeature('gherkin/executable/idle_devices.feature', (s) => {
  s.step(/^(another|this) device last active (-?\d+) days ago$/, (w, who, days) => {
    w.device = device(who === 'this' ? OWN : 'other', { since: NOW - 1000 * DAY, seen: NOW - Number(days) * DAY });
  });
  s.step('another device paired {int} days ago without last activity', (w, days) => {
    w.device = device('other', { since: NOW - days * DAY });
  });
  s.step('another device without any date', (w) => { w.device = device('other', {}); });
  s.step(/^it is (active|inactive)$/, (w, verdict) => assert.equal(isIdleDevice(w.device, OWN, NOW), verdict === 'inactive'));
});
