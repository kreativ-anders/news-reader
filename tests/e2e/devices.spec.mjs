// Paired devices: list, rename, remove with key rotation (lock-out), manual key change, self-announced unpair.
// Gherkin: gherkin/devices.feature
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, API, FX, App } from './fixtures.mjs';

const rows = (page) => page.locator('#devices .device');

async function pair(browser, key) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${API()}/app/#pair=${key}`);
  await expect(page.locator('#dlg')).toBeVisible();
  await page.locator('#dlgOk').click();
  return { ctx, page, app: new App(page) };
}

async function paired(browser, key) {
  const d = await pair(browser, key);
  await expect(d.page.locator('#syncPill')).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
  return d;
}

async function syncNow(page) {
  await page.locator('#syncPill').click();
  await expect(page.locator('#syncPill')).toHaveAttribute('data-state', /ok|local/, { timeout: 15_000 });
}

async function openSettings(app) {
  await app.go('inbox');
  await app.go('settings');
}

async function createVault(app, page) {
  await app.open('#settings');
  await page.locator('#createVault').click();
  await expect(page.locator('#syncPill')).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
  return app.kv('vaultKey');
}

test('devices are listed and renamed; removing one locks it out with a new key', async ({ app, page, browser }) => {
  const oldKey = await createVault(app, page);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().locator('.pill')).toBeVisible();
  await expect(rows(page).first().locator('[data-device-act="remove"]')).toHaveCount(0);

  const b = await paired(browser, oldKey);
  const c = await paired(browser, oldKey);
  await syncNow(page);
  await openSettings(app);
  await expect(rows(page)).toHaveCount(3);

  const bId = await b.app.kv('deviceId');
  const cId = await c.app.kv('deviceId');
  const row = (id) => page.locator(`#devices [data-device="${id}"]`);

  await row(bId).locator('[data-device-act="rename"]').click();
  await page.locator('#askIn').fill('Phone');
  await page.locator('#dlgOk').click();
  await expect(row(bId).locator('.t')).toHaveText('Phone');
  await expect.poll(() => app.pending(), { timeout: 15_000 }).toBe(0);

  await row(cId).locator('[data-device-act="remove"]').click();
  await page.locator('#dlgOk').click();
  await expect(page.locator('#toast')).toBeVisible({ timeout: 15_000 });
  await expect(rows(page)).toHaveCount(2);
  const newKey = await app.kv('vaultKey');
  expect(newKey).not.toBe(oldKey);

  // B follows the forward to the new key and keeps syncing, incl. the new name
  await syncNow(b.page);
  await expect.poll(() => b.app.kv('vaultKey'), { timeout: 15_000 }).toBe(newKey);
  await expect(b.page.locator('#syncPill')).toHaveAttribute('data-state', 'ok');
  await openSettings(b.app);
  await expect(rows(b.page)).toHaveCount(2);
  await expect(rows(b.page).filter({ has: b.page.locator('.pill') }).locator('.t')).toContainText('Phone');

  // C finds no key for itself and unpairs
  await c.page.locator('#syncPill').click();
  await expect(c.page.locator('#dlgTitle')).toHaveText('This device was removed', { timeout: 15_000 });
  await expect(c.page.locator('#syncPill')).toHaveAttribute('data-state', 'local');
  expect(await c.app.kv('vaultKey')).toBeNull();

  // the old location only holds an encrypted forward
  if (process.env.NR_E2E_API_DIR) {
    const dir = join(process.env.NR_E2E_API_DIR, 'var/sync');
    const magics = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.vault'))
      .map((f) => readFileSync(join(dir, f)).subarray(0, 4).toString());
    expect(magics).toContain('NRF1');
  }
  await b.ctx.close();
  await c.ctx.close();
});

test('changing the key keeps devices in sync and invalidates old pairing links', async ({ app, page, browser }) => {
  const oldKey = await createVault(app, page);
  await app.follow(`${FX()}/feeds/atom.xml`);
  await syncNow(page);
  await expect.poll(() => app.pending(), { timeout: 15_000 }).toBe(0);
  const b = await paired(browser, oldKey);

  await syncNow(page);
  await openSettings(app);
  await page.locator('#rotateKey').click();
  await page.locator('#dlgOk').click();
  await expect.poll(() => app.kv('vaultKey'), { timeout: 15_000 }).not.toBe(oldKey);
  const newKey = await app.kv('vaultKey');

  // B changes something after the key change → it lands in the new vault
  await syncNow(b.page);
  await expect.poll(() => b.app.kv('vaultKey'), { timeout: 15_000 }).toBe(newKey);
  await b.app.go('inbox');
  await expect(b.app.cards()).toHaveCount(3, { timeout: 15_000 });
  await expect(b.page.locator('#refreshBtn')).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(async () => {
    await b.app.card('Atom entry one').locator('[data-act="later"]').click({ timeout: 2_000 });
    await expect(b.app.badge('later')).toHaveText('1', { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await syncNow(b.page);
  await expect.poll(() => b.app.pending(), { timeout: 15_000 }).toBe(0);

  await syncNow(page);
  await expect(app.badge('later')).toHaveText('1', { timeout: 15_000 });

  // a stale pairing link no longer grants access
  const d = await pair(browser, oldKey);
  await expect(d.page.locator('#dlgTitle')).toHaveText('This sync key is no longer valid', { timeout: 15_000 });
  await expect(d.page.locator('#syncPill')).toHaveAttribute('data-state', 'local');
  expect(await d.app.kv('vaultKey')).toBeNull();
  await b.ctx.close();
  await d.ctx.close();
});

test('unpairing announces itself to the other devices', async ({ app, page, browser }) => {
  const key = await createVault(app, page);
  const b = await paired(browser, key);

  await syncNow(page);
  await openSettings(app);
  await expect(rows(page)).toHaveCount(2);

  await b.app.go('settings');
  await b.page.locator('#leaveVault').click();
  await b.page.locator('#dlgOk').click();
  await expect(b.page.locator('#syncPill')).toHaveAttribute('data-state', 'local');
  await b.ctx.close();

  await syncNow(page);
  await expect(rows(page)).toHaveCount(1);
});
