// News boots, every view renders, languages and themes work – without a single JS error.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, API } from './fixtures.mjs';
import { startApi } from '../support/servers.mjs';

test.describe('boot', () => {
  test('empty app: every view and the settings render @mobile', async ({ app, page }) => {
    await app.open();
    await expect(page).toHaveTitle('News');
    await expect(page.locator('#syncPill')).toHaveAttribute('data-state', 'local');
    for (const view of ['later', 'done', 'feeds', 'settings', 'inbox']) {
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

  test('old links to the removed Read now view open Later', async ({ app, page }) => {
    await app.open('#reading');
    await expect(page.locator('[data-view="later"][aria-current="page"]').first()).toBeVisible();
    await expect(page.locator('[data-view="reading"]')).toHaveCount(0);
  });

  test('keyboard view switching 1–4', async ({ app, page }) => {
    await app.open();
    for (const [key, view] of [['2', 'later'], ['3', 'done'], ['4', 'feeds'], ['1', 'inbox']]) {
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

  // INFO: own server – changing sw.js on the shared one would hand every other test an update
  test('a new version found on return offers a reload (toast and settings)', async ({ page }) => {
    const own = await startApi('lab');
    try {
      await page.goto(own.url + '/app/#settings');
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload();
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      await expect(page.locator('[data-reload]')).toHaveCount(0);
      // INFO: lets the browser's own check after the reload finish first, so only the app's check can find the change
      await page.waitForTimeout(2000);
      const sw = join(own.dir, 'app/sw.js');
      writeFileSync(sw, readFileSync(sw, 'utf8').replace(/const VERSION = '[^']+'/, "const VERSION = 'news-next'"));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(page.locator('#toast')).toContainText('A new version of News is ready');
      await expect(page.locator('[data-reload]')).toBeVisible();
      await page.locator('#toast button').click();
      await expect(page.locator('#view h1')).toBeVisible();
      await expect(page.locator('[data-reload]')).toHaveCount(0);
    } finally {
      await own.stop();
    }
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
