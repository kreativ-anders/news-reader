// Gherkin: gherkin/executable/refresh_rhythm.feature
// Source: app/js/feeds.js (openWait)
import assert from 'node:assert/strict';
import { openWait } from '../../app/js/feeds.js';
import { runFeature } from '../support/gherkin.mjs';

runFeature('gherkin/executable/refresh_rhythm.feature', (s) => {
  s.step('a feed posts {int} times a week', (w, n) => { w.perWeek = n; });
  s.step('opening the app checks it once its last fetch is older than {int} minutes', (w, min) => assert.equal(Math.round(openWait(w.perWeek) / 60000), min));
});
