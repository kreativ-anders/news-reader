// Gherkin: gherkin/executable/safe_output.feature
// Source: app/js/util.js (esc, httpUrl, hostOf)
import assert from 'node:assert/strict';
import { esc, httpUrl, hostOf } from '../../app/js/util.js';
import { runFeature } from '../support/gherkin.mjs';

// INFO: values are written as JSON in the spec, so escapes, null and numbers stay exact
runFeature('gherkin/executable/safe_output.feature', (s) => {
  s.step(/^the app checks the address (.+)$/, (w, json) => { w.url = httpUrl(JSON.parse(json)); });
  s.step('the app checks no address', (w) => { w.url = httpUrl(undefined); });
  s.step('the address is blocked', (w) => assert.equal(w.url, ''));
  s.step('the address {string} is used', (w, url) => assert.equal(w.url, url));

  s.step(/^the app escapes the text (.+)$/, (w, json) => { w.html = esc(JSON.parse(json)); });
  s.step('the app escapes nothing', (w) => { w.html = esc(null); });
  s.step(/^the HTML is (.+)$/, (w, json) => assert.equal(w.html, JSON.parse(json)));

  s.step('the host of {string} is {string}', (w, url, host) => assert.equal(hostOf(url), host));
});
