// INFO: sync client – gzip cap for sync data from other devices
// Gherkin: gherkin/sync.feature
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { gunzip } from '../../app/js/sync.js';

// INFO: record validation and pruning are specified in gherkin/executable/vault_records.feature and pruning.feature
test('gunzip stops at the byte limit (gzip bomb)', async () => {
  const small = new TextEncoder().encode('{"v":1}');
  assert.deepEqual(await gunzip(gzipSync(small)), small);
  const bomb = gzipSync(Buffer.alloc(4 << 20));
  assert.ok(bomb.length < 10_000);
  await assert.rejects(gunzip(bomb, 1 << 20), (e) => e.code === 'format');
  assert.equal((await gunzip(bomb, 8 << 20)).length, 4 << 20);
});
