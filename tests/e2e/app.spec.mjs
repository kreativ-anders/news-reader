// News boots, every view renders, languages and themes work – without a single JS error.
import { test, expect, API } from './fixtures.mjs';

test.describe('boot', () => {
  test('empty app: every view and the settings render @mobile', async ({ app, page }) => {
    await app.open();
    await expect(page).toHaveTitle('News');
    await expect(page.locator('#syncPill')).toHaveAttribute('data-state', 'local');
    for (const view of ['reading', 'later', 'done', 'feeds', 'settings', 'inbox']) {
      await page.locator(`[data-view="${view}"]`).first().click();
      await expect(page.locator('#view')).not.toBeEmpty();
      await expect(page.locator('#view h1, #view .empty').first()).toBeVisible();
    }
  });

  test('deep links open views (#later, #feeds, #settings)', async ({ app, page }) => {
    for (const view of ['later', 'feeds', 'settings']) {
      await page.goto('about:blank'); // a hash change alone does not reload the app
      await app.open(`#${view}`);
      await expect(page.locator(`[data-view="${view}"][aria-current="page"]`).first()).toBeVisible();
    }
  });

  test('keyboard view switching 1–5', async ({ app, page }) => {
    await app.open();
    for (const [key, view] of [['2', 'reading'], ['3', 'later'], ['4', 'done'], ['5', 'feeds'], ['1', 'inbox']]) {
      await page.keyboard.press(key);
      await expect(page.locator(`[data-view="${view}"][aria-current="page"]`).first()).toBeVisible();
    }
  });

  test('server test in settings reaches the Collector', async ({ app, page }) => {
    await app.open('#settings');
    await page.locator('#serverTest').click();
    await expect(page.locator('#serverResult')).not.toBeEmpty();
    await expect(page.locator('#serverResult .err')).toHaveCount(0);
  });

  test('service worker registers and serves the app offline', async ({ app, page, context }) => {
    await app.open();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#view')).not.toBeEmpty();
    await expect(page.locator('.nav [data-view="inbox"]')).toBeVisible();
    await context.setOffline(false);
  });
});

test.describe('languages', () => {
  for (const [lang, inbox] of [['en', 'Inbox'], ['de', null], ['fr', null], ['it', null], ['es', null]]) {
    test(`${lang}: all static labels translated`, async ({ page }) => {
      await page.addInitScript((l) => localStorage.setItem('nr.lang', l), lang);
      await page.goto(`${API()}/app/`);
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      if (inbox) await expect(page.locator('.nav [data-view="inbox"] span')).toHaveText(inbox);
      // no raw keys like "nav.inbox" left in the UI
      for (const el of await page.locator('[data-i18n]').all()) {
        const key = await el.getAttribute('data-i18n');
        await expect(el).not.toHaveText(key);
      }
      for (const view of ['feeds', 'settings']) {
        await page.locator(`[data-view="${view}"]`).first().click();
        await expect(page.locator('#view')).not.toContainText(/\b(feeds|settings|sync|nav|err|toast|act)\.[a-z_]+\b/);
      }
    });
  }

  test('language switch in settings re-renders the UI', async ({ app, page }) => {
    await app.open('#settings');
    await page.locator('#langSel').selectOption('de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  });
});

test('theme: light / dark / auto are applied and remembered', async ({ app, page }) => {
  await app.open('#settings');
  await page.locator('#themeSel').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('[data-view="settings"]').first().click();
  await page.locator('#themeSel').selectOption('auto');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
});
