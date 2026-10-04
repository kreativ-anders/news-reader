// Sync hardening: forged device records, the upload size limit, local-only housekeeping.
// Gherkin: gherkin/sync.feature, gherkin/devices.feature, gherkin/retention.feature
import { test, expect, API, App } from './fixtures.mjs';

async function paired(browser, key) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${API()}/app/#pair=${key}`);
  await expect(page.locator('#dlg')).toBeVisible();
  await page.locator('#dlgOk').click();
  await expect(page.locator('#syncPill')).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
  return { ctx, page, app: new App(page) };
}

// INFO: waits for a completed round, not just for the pill (which may still show the previous "ok")
async function syncNow(page) {
  const app = new App(page);
  const before = await app.kv('lastSync');
  await page.locator('#syncPill').click();
  await expect.poll(() => app.kv('lastSync'), { timeout: 15_000 }).toBeGreaterThan(before || 0);
}

async function createVault(app, page) {
  await app.open('#settings');
  await page.locator('#createVault').click();
  await expect(page.locator('#syncPill')).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
  return app.kv('vaultKey');
}

const records = (page) => page.evaluate(async (u) => (await import(u)).getAll('records'), `${API()}/app/js/db.js`);

test('a device cannot escape its removal with a future timestamp or a swapped public key', async ({ app, page, browser }) => {
  const key = await createVault(app, page);
  const b = await paired(browser, key);
  const c = await paired(browser, key);
  await syncNow(page);
  const [aId, bId, cId] = await Promise.all([app.kv('deviceId'), b.app.kv('deviceId'), c.app.kv('deviceId')]);

  // C (malicious): own record far in the future, B's public key replaced by its own
  await c.page.evaluate(async ({ bId, cId, dbUrl }) => {
    const db = await import(dbUrl);
    const own = await db.get('records', ['device', cId]);
    const victim = await db.get('records', ['device', bId]);
    await db.putLocal([{ ...own, updatedAt: 9e15 }, { ...victim, data: { ...victim.data, pub: own.data.pub }, updatedAt: Date.now() }]);
  }, { bId, cId, dbUrl: `${API()}/app/js/db.js` });
  await syncNow(c.page);
  await syncNow(page);

  const seen = await page.evaluate(async ({ cId, base }) => {
    const db = await import(`${base}/db.js`);
    const { Sync } = await import(`${base}/sync.js`);
    const s = new Sync();
    return {
      cAt: (await db.get('records', ['device', cId])).updatedAt,
      flagged: (await s.devices()).filter((d) => d.pubChanged).map((d) => d.id),
      holders: (await s.keyHolders([cId])).map((d) => d.id),
    };
  }, { cId, base: `${API()}/app/js` });
  expect(seen.cAt).toBeLessThan(Date.now() + 864e5);
  expect(seen.flagged).toEqual([bId]);
  expect(seen.holders).toEqual([aId]);

  await page.locator('[data-view="inbox"]').first().click();
  await page.locator('[data-view="settings"]').first().click();
  await page.locator(`#devices [data-device="${cId}"] [data-device-act="remove"]`).click();
  await page.locator('#dlgOk').click();
  await expect(page.locator('#toast')).toBeVisible({ timeout: 15_000 });
  expect(await app.kv('vaultKey')).not.toBe(key);
  expect(await app.kv('revoked')).toEqual([cId]);

  // neither C nor the key it planted under B's id gets the new key
  for (const d of [c, b]) {
    await d.page.locator('#syncPill').click();
    await expect(d.page.locator('#dlgTitle')).toHaveText('This device was removed', { timeout: 15_000 });
    expect(await d.app.kv('vaultKey')).toBeNull();
  }
  const own = (await records(page)).find((r) => r.kind === 'device' && r.id === cId);
  expect(own.data.r).toBe(1);
  await b.ctx.close();
  await c.ctx.close();
});

test('an upload over the size limit drops the oldest finished items and retries once', async ({ app, page }) => {
  await createVault(app, page);
  const old = Date.now() - 20 * 864e5;
  await page.evaluate(async ({ old, dbUrl }) => {
    const db = await import(dbUrl);
    const recs = [{ kind: 'item', id: 'keep', updatedAt: old - 10, data: { s: 'later', t: 'Keep' } }];
    for (let i = 0; i < 5; i++) recs.push({ kind: 'item', id: `done${i}`, updatedAt: old + i, data: { s: 'done', t: `T${i}` } });
    await db.putLocal(recs);
  }, { old, dbUrl: `${API()}/app/js/db.js` });

  let puts = 0;
  await page.route('**/api/sync', (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    if (puts++) return route.continue();
    return route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Vault larger than 1000000 bytes.' } }) });
  });
  await syncNow(page);
  expect(puts).toBe(2);
  const ids = (await records(page)).filter((r) => r.kind === 'item').map((r) => r.id).sort();
  expect(ids).toEqual(['done1', 'done2', 'done3', 'done4', 'keep']);
  expect(await app.pending()).toBe(0);
});

test('local-only mode prunes old dismissed items at start and keeps no outbox', async ({ app, page }) => {
  await app.open();
  await page.evaluate(async (dbUrl) => {
    const db = await import(dbUrl);
    const old = Date.now() - 31 * 864e5;
    await db.putLocal([
      { kind: 'item', id: 'old', updatedAt: old, data: { s: 'dismissed', f: 'f1' } },
      { kind: 'item', id: 'recent', updatedAt: Date.now(), data: { s: 'dismissed', f: 'f1' } },
      { kind: 'item', id: 'later', updatedAt: old, data: { s: 'later' } },
    ]);
    await db.kvDel('lastMaintain');
  }, `${API()}/app/js/db.js`);
  expect(await app.pending()).toBe(3);
  await app.open();
  const ids = (await records(page)).map((r) => r.id).sort();
  expect(ids).toEqual(['later', 'recent']);
  expect(await app.pending()).toBe(0);
  expect(await app.kv('lastMaintain')).toBeGreaterThan(0);
});
