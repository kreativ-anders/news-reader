// /api/sync – the encrypted-vault protocol from the README (lab profile).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { servers, assertError } from './helpers.mjs';

const s = servers('lab');
const token = () => randomBytes(32).toString('base64url'); // 43 chars, like HKDF output in sync.js
const blob = (n = 64) => Buffer.concat([Buffer.from('NRS1'), Buffer.from([0]), randomBytes(12 + Math.max(16, n))]);
const sync = (tok, init = {}) => s.get('/api/sync', { ...init, headers: { Authorization: `Bearer ${tok}`, ...(init.headers || {}) } });

describe('sync protocol', () => {
  it('full lifecycle: 404 → create → 304 → update → conflict → delete', async () => {
    const t = token();
    assertError(await sync(t), 404, 'NOT_FOUND');

    const b1 = blob();
    const created = await sync(t, { method: 'PUT', body: b1, headers: { 'If-None-Match': '*' } });
    assert.equal(created.status, 201, created.text);
    const etag1 = created.header('etag');
    assert.match(etag1, /^"[0-9a-f]{32}"$/);
    assert.equal(created.json.etag, etag1);
    assert.equal(created.json.bytes, b1.length);

    const got = await s.get('/api/sync', { headers: { Authorization: `Bearer ${t}` } });
    assert.equal(got.status, 200);
    assert.equal(got.header('etag'), etag1);
    assert.equal(got.header('cache-control'), 'no-store');
    const raw = Buffer.from(await (await fetch(s.api.url + '/api/sync', { headers: { Authorization: `Bearer ${t}` } })).arrayBuffer());
    assert.ok(raw.equals(b1), 'blob round-trips byte for byte');

    assert.equal((await sync(t, { headers: { 'If-None-Match': etag1 } })).status, 304);
    assert.equal((await sync(t, { headers: { 'If-None-Match': `W/${etag1}` } })).status, 304);

    assertError(await sync(t, { method: 'PUT', body: blob(), headers: { 'If-None-Match': '*' } }), 412, 'CONFLICT');
    const b2 = blob();
    const updated = await sync(t, { method: 'PUT', body: b2, headers: { 'If-Match': etag1 } });
    assert.equal(updated.status, 200);
    const etag2 = updated.header('etag');
    assert.notEqual(etag2, etag1);

    // another device still has etag1 → conflict, server tells the current ETag
    const stale = await sync(t, { method: 'PUT', body: blob(), headers: { 'If-Match': etag1 } });
    assertError(stale, 412, 'CONFLICT');
    assert.equal(stale.header('etag'), etag2);

    assertError(await sync(t, { method: 'DELETE', headers: { 'If-Match': etag1 } }), 412, 'CONFLICT');
    assert.equal((await sync(t, { method: 'DELETE' })).status, 204);
    assertError(await sync(t), 404, 'NOT_FOUND');
    assertError(await sync(t, { method: 'DELETE' }), 404, 'NOT_FOUND');
  });

  it('stored under sha256(token) – the token never touches the disk', async () => {
    const t = token();
    await sync(t, { method: 'PUT', body: blob(), headers: { 'If-None-Match': '*' } });
    const id = createHash('sha256').update(t).digest('hex');
    assert.ok(existsSync(join(s.api.dir, 'var/sync', id.slice(0, 2), `${id}.vault`)));
    const names = readdirSync(join(s.api.dir, 'var/sync'), { recursive: true }).map(String);
    assert.ok(!names.some((n) => n.includes(t)));
  });

  it('auth is required and strict', async () => {
    assertError(await s.get('/api/sync'), 401, 'UNAUTHORIZED');
    assertError(await sync('short'), 401, 'UNAUTHORIZED');
    assertError(await sync(token() + 'x'), 401, 'UNAUTHORIZED');
    assertError(await s.get('/api/sync', { headers: { Authorization: `Basic ${token()}` } }), 401, 'UNAUTHORIZED');
    assertError(await sync('../../../../etc/passwd/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 401, 'UNAUTHORIZED');
  });

  it('writes need a precondition and a valid blob', async () => {
    const t = token();
    assertError(await sync(t, { method: 'PUT', body: blob() }), 428, 'PRECONDITION_REQUIRED');
    assertError(await sync(t, { method: 'PUT', body: '{"plain":"json"}', headers: { 'If-None-Match': '*' } }), 400, 'INVALID_BODY');
    assertError(await sync(t, { method: 'PUT', body: Buffer.from('NRS1'), headers: { 'If-None-Match': '*' } }), 400, 'INVALID_BODY');
    assertError(await sync(t, { method: 'PUT', body: blob(1_000_100), headers: { 'If-None-Match': '*' } }), 413, 'PAYLOAD_TOO_LARGE');
    assertError(await sync(t, { method: 'POST', body: blob() }), 405, 'METHOD_NOT_ALLOWED');
  });

  it('CORS preflight exposes ETag', async () => {
    const r = await s.get('/api/sync', { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.match(r.header('access-control-allow-headers'), /Authorization/);
    assert.match(r.header('access-control-allow-headers'), /If-Match/);
    assert.equal((await sync(token())).header('access-control-expose-headers'), 'ETag');
  });

  it('concurrent creates: exactly one wins', async () => {
    const t = token();
    const all = await Promise.all(Array.from({ length: 6 }, () => sync(t, { method: 'PUT', body: blob(), headers: { 'If-None-Match': '*' } })));
    const codes = all.map((r) => r.status).sort();
    assert.deepEqual(codes, [201, 412, 412, 412, 412, 412]);
  });
});

describe('key change forward', () => {
  it('an "NRF1" forward may replace a vault, other magics are refused', async () => {
    const t = token();
    const created = await sync(t, { method: 'PUT', body: blob(), headers: { 'If-None-Match': '*' } });
    assert.equal(created.status, 201);
    const forward = Buffer.concat([Buffer.from('NRF1'), Buffer.from([0]), randomBytes(12 + 64)]);
    const moved = await sync(t, { method: 'PUT', body: forward, headers: { 'If-Match': created.header('etag') } });
    assert.equal(moved.status, 200, moved.text);
    const raw = Buffer.from(await (await fetch(s.api.url + '/api/sync', { headers: { Authorization: `Bearer ${t}` } })).arrayBuffer());
    assert.equal(raw.subarray(0, 4).toString(), 'NRF1');
    const other = Buffer.concat([Buffer.from('NRX1'), Buffer.from([0]), randomBytes(12 + 64)]);
    assertError(await sync(t, { method: 'PUT', body: other, headers: { 'If-Match': moved.header('etag') } }), 400, 'INVALID_BODY');
  });

  it('a forward is final – a removed device cannot replace or delete it', async () => {
    const t = token();
    const created = await sync(t, { method: 'PUT', body: blob(), headers: { 'If-None-Match': '*' } });
    const forward = () => Buffer.concat([Buffer.from('NRF1'), Buffer.from([0]), randomBytes(12 + 64)]);
    const moved = await sync(t, { method: 'PUT', body: forward(), headers: { 'If-Match': created.header('etag') } });
    assert.equal(moved.status, 200, moved.text);
    const etag = moved.header('etag');

    assertError(await sync(t, { method: 'PUT', body: blob(), headers: { 'If-Match': etag } }), 410, 'FORWARDED');
    assertError(await sync(t, { method: 'PUT', body: forward(), headers: { 'If-Match': etag } }), 410, 'FORWARDED');
    assertError(await sync(t, { method: 'DELETE' }), 410, 'FORWARDED');
    assertError(await sync(t, { method: 'DELETE', headers: { 'If-Match': etag } }), 410, 'FORWARDED');

    const got = await sync(t);
    assert.equal(got.status, 200);
    assert.equal(got.header('etag'), etag, 'the forward is untouched');
  });
});
