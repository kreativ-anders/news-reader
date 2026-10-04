// Time-based cleanup (src/gc.php): retention periods hold without cron (lab profile).
// Gherkin: gherkin/collector_cache.feature, gherkin/sync_server.feature
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { servers, assertError } from './helpers.mjs';

const s = servers('lab');
const full = servers('lab', { NR_SYNC_MAX_VAULTS: '2' });

const DAY = 86400;
const token = () => randomBytes(32).toString('base64url');
const blob = () => Buffer.concat([Buffer.from('NRS1'), Buffer.from([0]), randomBytes(64)]);
const vaultFile = (ctx, t) => {
  const id = createHash('sha256').update(t).digest('hex');
  return join(ctx.api.dir, 'var/sync', id.slice(0, 2), `${id}.vault`);
};
const createVault = async (ctx) => {
  const t = token();
  const r = await ctx.get('/api/sync', { method: 'PUT', body: blob(), headers: { Authorization: `Bearer ${t}`, 'If-None-Match': '*' } });
  return { t, r };
};
const age = (file, days) => {
  const past = Date.now() / 1000 - days * DAY;
  utimesSync(file, past, past);
};
// INFO: pretend the last cleanup of a directory ran long ago
const due = (ctx, dir) => {
  const marker = join(ctx.api.dir, 'var', dir, '.gc');
  writeFileSync(marker, '0');
  age(marker, 1);
};

describe('time-based cleanup', () => {
  it('expired vaults are deleted on the next request, at most once per interval', async () => {
    const { t: expired } = await createVault(s);
    age(vaultFile(s, expired), 181);
    const { t: active } = await createVault(s);
    age(vaultFile(s, active), 179);

    due(s, 'sync');
    assertError(await s.get('/api/sync'), 401, 'UNAUTHORIZED'); // INFO: any request triggers the cleanup
    assert.ok(!existsSync(vaultFile(s, expired)), 'expired vault deleted');
    assert.ok(existsSync(vaultFile(s, active)), 'active vault kept');

    age(vaultFile(s, active), 181);
    await s.get('/api/sync');
    assert.ok(existsSync(vaultFile(s, active)), 'no second run within the interval');
  });

  it('cache and rate-limit files expire, too', async () => {
    mkdirSync(join(s.api.dir, 'var/rate'), { recursive: true });
    const cacheFile = join(s.api.dir, 'var/cache', 'a'.repeat(64) + '.json');
    const rateFile = join(s.api.dir, 'var/rate', 'b'.repeat(64));
    writeFileSync(cacheFile, '{}');
    writeFileSync(rateFile, '0 0');
    age(cacheFile, 15);
    age(rateFile, 3);

    due(s, 'cache');
    due(s, 'rate');
    assert.equal((await s.get('/api/collect')).status, 400);
    assert.ok(!existsSync(cacheFile), 'cache file deleted after 14 days');
    assert.ok(!existsSync(rateFile), 'rate-limit counter deleted after 2 days');
  });
});

describe('server full', () => {
  it('expired vaults do not count against NR_SYNC_MAX_VAULTS', async () => {
    const { t: first } = await createVault(full);
    assert.equal((await createVault(full)).r.status, 201);
    assertError((await createVault(full)).r, 507, 'SERVER_FULL');

    age(vaultFile(full, first), 181);
    assert.equal((await createVault(full)).r.status, 201);
    assert.ok(!existsSync(vaultFile(full, first)));
  });
});
