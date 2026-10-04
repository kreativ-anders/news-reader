// Gherkin: gherkin/executable/sync_protocol.feature
// Source: src/sync.php via /api/sync (lab profile)
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { runFeature } from '../support/gherkin.mjs';
import { servers } from './helpers.mjs';

const s = servers('lab');
const token = () => randomBytes(32).toString('base64url'); // 43 chars, like HKDF output in sync.js
const sealed = (magic = 'NRS1', n = 64) => Buffer.concat([Buffer.from(magic), Buffer.from([0]), randomBytes(12 + Math.max(16, n))]);
const BODIES = {
  'a plain JSON body': () => '{"plain":"json"}',
  'nothing but the magic': () => Buffer.from('NRS1'),
};
const CREDENTIALS = {
  'no authorization': () => ({}),
  'the bearer token "short"': () => ({ Authorization: 'Bearer short' }),
  'a token one character too long': () => ({ Authorization: `Bearer ${token()}x` }),
  'a valid token as Basic authorization': () => ({ Authorization: `Basic ${token()}` }),
  'a file path as bearer token': () => ({ Authorization: 'Bearer ../../../../etc/passwd/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
};

// INFO: remembers the ETag of every successful write like a device does; "the first ETag" is the one from creating
async function call(w, init = {}, headers = { Authorization: `Bearer ${w.token}` }) {
  const res = await fetch(s.api.url + '/api/sync', { ...init, headers: { ...headers, ...init.headers } });
  const body = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(body.toString()); } catch { /* blob */ }
  w.res = { status: res.status, header: (h) => res.headers.get(h), body, json };
  if (init.method === 'PUT' && res.ok) {
    w.previous = w.etag;
    w.etag = res.headers.get('etag');
    w.first ??= w.etag;
    w.sent = init.body;
  }
}
const put = (w, body, conditional) => call(w, { method: 'PUT', body, headers: conditional });
const etag = (w, which) => (which === 'the first ETag' ? w.first : w.etag);

runFeature('gherkin/executable/sync_protocol.feature', (st) => {
  st.step('a new sync key', (w) => { w.token = token(); });
  st.step('the device created the sync data', async (w) => {
    await put(w, sealed(), { 'If-None-Match': '*' });
    assert.equal(w.res.status, 201);
  });

  st.step(/^the device reads the sync data$/, (w) => call(w));
  st.step(/^the device reads the sync data with (its ETag|its ETag marked as weak)$/, (w, which) =>
    call(w, { headers: { 'If-None-Match': which.endsWith('weak') ? `W/${w.etag}` : w.etag } }));

  st.step(/^the device creates the sync data$/, (w) => put(w, sealed(), { 'If-None-Match': '*' }));
  st.step(/^the device creates the sync data with (a plain JSON body|nothing but the magic|a blob of (\d+) bytes)$/, (w, body, size) =>
    put(w, size ? sealed('NRS1', Number(size)) : BODIES[body](), { 'If-None-Match': '*' }));
  st.step(/^the device (?:uploads|uploaded) the sync data with (its ETag|the first ETag)$/, (w, which) => put(w, sealed(), { 'If-Match': etag(w, which) }));
  st.step(/^the device (?:uploads|uploaded) a forward with its ETag$/, (w) => put(w, sealed('NRF1'), { 'If-Match': w.etag }));
  st.step('the device uploads a blob starting with {string} with its ETag', (w, magic) => put(w, sealed(magic), { 'If-Match': w.etag }));
  st.step('the device uploads the sync data without a precondition', (w) => put(w, sealed()));

  st.step(/^the device deletes the sync data$/, (w) => call(w, { method: 'DELETE' }));
  st.step(/^the device deletes the sync data with (its ETag|the first ETag)$/, (w, which) => call(w, { method: 'DELETE', headers: { 'If-Match': etag(w, which) } }));
  st.step('the device posts to the sync data', (w) => call(w, { method: 'POST', body: sealed() }));
  st.step(/^a device asks with (.+)$/, (w, credentials) => call(w, {}, CREDENTIALS[credentials]()));

  st.step(/^the answer is (\d+)$/, (w, status) => assert.equal(w.res.status, Number(status), w.res.body.toString().slice(0, 200)));
  st.step(/^the answer is (\d+) "([A-Z_]+)"$/, (w, status, code) => {
    assert.equal(w.res.status, Number(status), w.res.body.toString().slice(0, 200));
    assert.equal(w.res.json?.error?.code, code);
    assert.equal(typeof w.res.json.error.message, 'string');
  });
  st.step('the answer carries a new ETag', (w) => {
    assert.match(w.res.header('etag'), /^"[0-9a-f]{32}"$/);
    assert.equal(w.res.json.etag, w.res.header('etag'));
    assert.notEqual(w.etag, w.previous);
  });
  st.step('the answer reports the uploaded size', (w) => assert.equal(w.res.json.bytes, w.sent.length));
  st.step('the answer is the uploaded blob, byte for byte', (w) => {
    assert.ok(w.res.body.equals(w.sent));
    assert.equal(w.res.header('etag'), w.etag);
  });
  st.step('the answer is not cached', (w) => assert.equal(w.res.header('cache-control'), 'no-store'));
  st.step('the answer names the current ETag', (w) => assert.equal(w.res.header('etag'), w.etag));
  st.step('the stored blob starts with {string}', async (w, magic) => {
    const { etag: known } = w;
    await call(w);
    assert.equal(w.res.body.subarray(0, 4).toString(), magic);
    assert.equal(w.res.header('etag'), known);
  });
  st.step('the stored sync data is still the forward', async (w) => {
    await call(w);
    assert.equal(w.res.status, 200);
    assert.equal(w.res.header('etag'), w.etag, 'the forward is untouched');
    assert.equal(w.res.body.subarray(0, 4).toString(), 'NRF1');
  });
});
