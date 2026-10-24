// /api/sync – storage, CORS and races of the encrypted-vault protocol from the README (lab profile).
// Gherkin: gherkin/sync_server.feature
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { servers } from './helpers.mjs';

const s = servers('lab');
const token = () => randomBytes(32).toString('base64url'); // 43 chars, like HKDF output in sync.js
const blob = (n = 64) => Buffer.concat([Buffer.from('NRS1'), Buffer.from([0]), randomBytes(12 + Math.max(16, n))]);
const sync = (tok, init = {}) => s.get('/api/sync', { ...init, headers: { Authorization: `Bearer ${tok}`, ...(init.headers || {}) } });

// INFO: create/read/update/delete, auth, preconditions and forwards are specified in gherkin/executable/sync_protocol.feature
describe('sync protocol', () => {
  it('stored under sha256(token) – the token never touches the disk', async () => {
    const t = token();
    await sync(t, { method: 'PUT', body: blob(), headers: { 'If-None-Match': '*' } });
    const id = createHash('sha256').update(t).digest('hex');
    assert.ok(existsSync(join(s.api.dir, 'var/sync', id.slice(0, 2), `${id}.vault`)));
    const names = readdirSync(join(s.api.dir, 'var/sync'), { recursive: true }).map(String);
    assert.ok(!names.some((n) => n.includes(t)));
  });

  it('CORS preflight exposes ETag and the size limit', async () => {
    const r = await s.get('/api/sync', { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.match(r.header('access-control-allow-headers'), /Authorization/);
    assert.match(r.header('access-control-allow-headers'), /If-Match/);
    assert.equal((await sync(token())).header('access-control-expose-headers'), 'ETag, X-Sync-Max-Bytes');
  });

  it('concurrent creates: exactly one wins', async () => {
    const t = token();
    const all = await Promise.all(Array.from({ length: 6 }, () => sync(t, { method: 'PUT', body: blob(), headers: { 'If-None-Match': '*' } })));
    const codes = all.map((r) => r.status).sort();
    assert.deepEqual(codes, [201, 412, 412, 412, 412, 412]);
  });
});
