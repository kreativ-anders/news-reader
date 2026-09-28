// Onboarding, history, privacy of incoming links, "Not interested" list, clearing Done, keyboard switch, error texts.
import { test, expect, FX } from './fixtures.mjs';

const item = (page, id) => page.evaluate((key) => new Promise((resolve, reject) => {
  const req = indexedDB.open('news');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const get = req.result.transaction('records').objectStore('records').get(['item', key]);
    get.onsuccess = () => { resolve(get.result ?? null); req.result.close(); };
    get.onerror = () => reject(get.error);
  };
}), id);

test('first run explains the three decisions and leads into the address field @mobile', async ({ app, page }) => {
  await app.open();
  await expect(page.locator('.empty.onboard')).toContainText('Not interested');
  await expect(page.locator('#startImport')).toBeVisible();
  // INFO: the decision words stay bold words in the sentence, and the buttons form a spaced row – not blocks or glued buttons
  expect(await page.locator('.onboard > span strong').evaluateAll((els) => els.map((e) => getComputedStyle(e).display))).toEqual(['inline', 'inline', 'inline']);
  const row = await page.locator('.onboard .row').evaluate((r) => {
    const [a, b] = [...r.children].map((e) => e.getBoundingClientRect());
    return { display: getComputedStyle(r).display, gap: getComputedStyle(r).columnGap, sameTop: Math.abs(a.top - b.top) < 1 || a.bottom <= b.top };
  });
  expect(row).toEqual({ display: 'flex', gap: '8px', sameTop: true });
  await page.locator('.onboard [data-view="feeds"]').click();
  await expect(page.locator('#addUrl')).toBeFocused();
  await expect(page.locator('#addUrl')).toHaveAttribute('type', 'text');
});

test('pairing keys and shared URLs leave the address bar before any other script runs', async ({ app, page }) => {
  await page.goto(app.url('?add=' + encodeURIComponent(`${FX()}/blog/`)));
  expect(await page.evaluate(() => location.search)).toBe('');
  await expect(page.locator('#addUrl')).toHaveValue(`${FX()}/blog/`);
  await page.goto('about:blank');
  // INFO: "interactive" fires before any module script – only the inline script can have removed the key by then
  await page.addInitScript(() => document.addEventListener('readystatechange', () => { if (document.readyState === 'interactive') window.hashAtParse = location.hash; }));
  await page.goto(app.url('#pair=not-a-valid-key'));
  expect(await page.evaluate(() => window.hashAtParse)).toBe('');
  expect(await page.evaluate(() => location.hash)).toBe('');
  // INFO: while the app is open, a pairing link only changes the hash
  await page.evaluate(() => { location.hash = 'pair=still-not-a-key'; });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
});

test('browser Back returns to the previous view', async ({ app, page }) => {
  await app.open();
  await app.go('later');
  await app.go('feeds');
  await page.goBack();
  await expect(page.locator('[data-view="later"][aria-current="page"]').first()).toBeVisible();
  await page.goBack();
  await expect(page.locator('[data-view="inbox"][aria-current="page"]').first()).toBeVisible();
});

test('friendly error text in the app language, raw message in the tooltip', async ({ app, page }) => {
  await app.open();
  const err = (await app.follow(`${FX()}/empty/`)).locator('.err');
  await expect(err).toContainText('couldn’t find any posts');
  await expect(err).toHaveAttribute('title', /.+/);
  await expect(page.locator('#addUrl')).toHaveAttribute('aria-invalid', 'true');
});

test('"Not interested" list brings a post back; clearing Done keeps it counted as read', async ({ app, page }) => {
  await app.open();
  await app.follow(`${FX()}/feeds/atom.xml`);
  await app.go('inbox');
  await app.card('Atom entry three').locator('[data-act="dismissed"]').click();
  await app.go('done');
  await page.locator('#view [data-view="dismissed"]').click();
  const skipped = app.card('Atom entry three');
  await expect(skipped).toHaveCount(1);
  await skipped.locator('[data-act="new"]').click();
  await expect(app.cards()).toHaveCount(0);

  await app.go('inbox');
  const first = app.cards().first();
  const id = await first.getAttribute('data-id');
  await first.locator('[data-act="later"]').click();
  await app.go('later');
  await app.cards().first().locator('[data-act="done"]').click();
  await app.go('done');
  await page.locator('#clearDone').click();
  await page.locator('#dlgOk').click();
  await expect(app.cards()).toHaveCount(0);
  const r = await item(page, id);
  expect(r.data.s).toBe('done');
  expect(r.data.h).toBe(1);
});

test('single-key shortcuts can be switched off', async ({ app, page }) => {
  await app.open('#settings');
  await page.locator('#keysSel').selectOption('off');
  await page.keyboard.press('Escape');
  await page.locator('#view h1').focus();
  await page.keyboard.press('2');
  await expect(page.locator('[data-view="settings"][aria-current="page"]').first()).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.locator('#palette')).toBeVisible();
});
