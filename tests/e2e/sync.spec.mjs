// End-to-end encrypted sync between two devices (two browser contexts) through the real PHP server.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, API, FX, App } from './fixtures.mjs';

test('pair two devices, sync feeds and item states both ways', async ({ app, page, browser }) => {
  // device A: follow a feed, save one item, create a vault
  await app.open();
  await app.follow(`${FX()}/feeds/atom.xml`);
  await app.go('inbox');
  await app.card('Atom entry one').locator('[data-act="later"]').click();
  await expect(app.badge('later')).toHaveText('1'); // committed before the vault is created
  await app.go('settings');
  await page.locator('#createVault').click();
  await expect(page.locator('#syncPill')).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
  await expect(page.locator('#qr')).toHaveCount(0); // INFO: no QR code – a scanned link opens the browser, not the installed app
  await expect(page.locator('#copyLink')).toBeVisible();
  const key = await app.kv('vaultKey');
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // device B: pairing link
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const errorsB = [];
  pageB.on('pageerror', (e) => errorsB.push(e.message));
  const b = new App(pageB);
  await pageB.goto(`${API()}/app/#pair=${key}`);
  await expect(pageB.locator('#dlg')).toBeVisible(); // "Pair this device?" confirmation
  await pageB.locator('#dlgOk').click();
  await expect(pageB.locator('#syncPill')).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
  await expect(b.badge('later')).toHaveText('1', { timeout: 15_000 });
  await b.go('feeds');
  await expect(pageB.locator('.feedrow')).toHaveCount(1);
  await expect(pageB.locator('.feedrow .t')).toHaveText('Fixture Atom');

  // B changes something → A sees it after syncing
  await b.go('inbox');
  await expect(b.cards()).toHaveCount(2, { timeout: 15_000 });
  // pairing triggers a feed refresh – wait until the list is stable before clicking
  await expect(pageB.locator('#refreshBtn')).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await b.card('Atom entry three').locator('[data-act="dismissed"]').click();
  await expect(b.cards()).toHaveCount(1);
  // local changes wait ~20 s – leaving the page (hidden) sends them at once
  expect(await b.pending()).toBeGreaterThan(0);
  await pageB.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
  });
  await expect.poll(() => b.pending(), { timeout: 15_000 }).toBe(0);
  await expect(pageB.locator('#syncPill')).toHaveAttribute('data-state', 'ok');

  await page.locator('#syncPill').click(); // sync now
  await expect(page.locator('#syncPill')).toHaveAttribute('data-state', 'ok');
  await app.go('inbox');
  await expect(app.cards()).toHaveCount(1, { timeout: 15_000 });

  // the server only holds ciphertext
  const vaultDir = join(process.env.NR_E2E_API_DIR || '', 'var/sync');
  if (process.env.NR_E2E_API_DIR) {
    const files = readdirSync(vaultDir, { recursive: true }).map(String).filter((f) => f.endsWith('.vault'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const blob = readFileSync(join(vaultDir, f));
      expect(['NRS1', 'NRF1']).toContain(blob.subarray(0, 4).toString());
      expect(blob.includes('atom')).toBe(false);
      expect(blob.includes(key)).toBe(false);
    }
  }

  // unpair B: local only again
  await b.go('settings');
  await pageB.locator('#leaveVault').click();
  await pageB.locator('#dlgOk').click();
  await expect(pageB.locator('#syncPill')).toHaveAttribute('data-state', 'local');
  expect(errorsB).toEqual([]);
  await ctxB.close();
});

test('join with an invalid key shows an error', async ({ app, page }) => {
  await app.open('#settings');
  await page.locator('#joinKey').fill('not-a-key');
  await page.locator('#joinForm button[type="submit"]').click();
  await expect(page.locator('#syncResult .err')).toBeVisible();
  await expect(page.locator('#joinKey')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#joinKey')).toBeFocused();
});

test('copy the pairing link on one device, paste it on another', async ({ app, page, browser }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await app.open('#settings');
  await page.locator('#createVault').click();
  await expect(page.locator('#syncPill')).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
  await page.locator('#copyLink').click();
  await expect(page.locator('#toast')).toContainText('Pairing link copied');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(`${API()}/app/#pair=${await app.kv('vaultKey')}`);

  const ctxB = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const pageB = await ctxB.newPage();
  await pageB.goto(`${API()}/app/#settings`);
  await pageB.evaluate((text) => navigator.clipboard.writeText(text), link);
  await pageB.locator('#pasteKey').click();
  await expect(pageB.locator('#joinKey')).toHaveValue(link);
  await expect(pageB.locator('#dlg')).toBeVisible();
  await pageB.locator('#dlgOk').click();
  await expect(pageB.locator('#syncPill')).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
  await ctxB.close();
});

test('paste with a denied clipboard asks to paste by hand', async ({ app, page }) => {
  await app.open('#settings');
  await page.evaluate(() => { navigator.clipboard.readText = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
  await page.locator('#pasteKey').click();
  await expect(page.locator('#syncResult')).toHaveText('Couldn’t read the clipboard – paste the link into the field yourself.');
  await expect(page.locator('#joinKey')).toBeFocused();
});

test('unreachable sync server is reported, not thrown', async ({ app, page }) => {
  await app.open('#settings');
  await page.locator('#serverUrl').fill('https://127.0.0.1:59999/');
  await page.locator('#serverForm button[type="submit"]').click();
  await page.locator('#createVault').click();
  await expect(page.locator('#syncPill')).toHaveAttribute('data-state', /unreachable|error/, { timeout: 25_000 });
});
