// Gherkin: gherkin/executable/feed_identity.feature
// Source: app/js/feeds.js (normalizeUrl, extractUrl, feedId, cleanTitle)
import assert from 'node:assert/strict';
import { normalizeUrl, extractUrl, feedId, cleanTitle } from '../../app/js/feeds.js';
import { runFeature } from '../support/gherkin.mjs';

runFeature('gherkin/executable/feed_identity.feature', (s) => {
  s.step('I normalise the address {string}', (w, input) => { w.address = normalizeUrl(input); });
  s.step('the address is {string}', (w, address) => assert.equal(w.address, address));
  s.step('the address is empty', (w) => assert.equal(w.address, ''));

  s.step('I extract the link from {string}', (w, text) => { w.link = extractUrl(text); });
  s.step('the link is {string}', (w, link) => assert.equal(w.link, link));
  s.step('the link is empty', (w) => assert.equal(w.link, ''));

  s.step('the feed id of {string} is {string}', (w, url, id) => assert.equal(feedId(url), id));
  s.step('the feed ids of {string} and {string} differ', (w, a, b) => assert.notEqual(feedId(a), feedId(b)));
  s.step('the feed id of {string} looks like a feed id', (w, url) => assert.match(feedId(url), /^f[0-9a-z]+$/));

  s.step('I clean the feed title {string}', (w, title) => { w.title = cleanTitle(title); });
  s.step('the title is {string}', (w, title) => assert.equal(w.title, title));
});
