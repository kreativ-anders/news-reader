// Reading list UI: sources sidebar with folders, feed context, day groups, authors, search palette, shortcuts, layout.
import { test, expect, FX } from './fixtures.mjs';

test.beforeEach(async ({ app }) => {
  await app.open();
  await app.follow(`${FX()}/feeds/rss.xml`);
});

test('one feed: no sources tree; two feeds: tree with counts', async ({ app, page }) => {
  await app.go('inbox');
  await expect(page.locator('#srcSec')).toBeHidden();
  await app.follow(`${FX()}/feeds/atom.xml`);
  await app.go('inbox');
  await expect(page.locator('#srcSec')).toBeVisible();
  await expect(page.locator('#feedNav [data-filter]')).toHaveCount(2);
  await expect(page.locator('#feedNav [title="Fixture Atom"] .badge')).toHaveText('3');
});

test('folders: assign, filter by folder, feed context', async ({ app, page }) => {
  await app.follow(`${FX()}/feeds/atom.xml`);
  const row = page.locator('.feedrow', { has: page.locator('.t', { hasText: 'Fixture Atom' }) });
  await row.locator('[data-feed-act="folder"]').click();
  await page.locator('#folderIn').fill('Tech');
  await page.locator('#folderIn').press('Enter');
  await expect(page.locator('.fold-title')).toContainText(['Tech']);

  await app.go('inbox');
  const folder = page.locator('#feedNav [data-filter="g:Tech"]');
  await expect(folder.locator('.badge')).toHaveText('3');
  await folder.click();
  await expect(page.locator('#view h1 .crumb')).toContainText('Tech');
  await expect(app.cards()).toHaveCount(3);
  await expect(page.locator('#view .ctx')).toBeVisible();

  await page.locator('#feedNav [title="Fixture Blog"]').click();
  await expect(app.cards()).toHaveCount(4);
  const ctx = page.locator('#view .ctx');
  await expect(ctx.locator('[data-feed-act="remove"]')).toBeVisible();

  // the folder survives a reload (synced feed record)
  await page.reload();
  await expect(page.locator('#feedNav [data-filter="g:Tech"]')).toBeVisible();
});

test('posts are grouped by day and show their author', async ({ app, page }) => {
  await app.go('inbox');
  await expect(page.locator('#view .day-h').first()).toBeVisible();
  const sum = await page.locator('#view .day-h b').allTextContents();
  expect(sum.reduce((a, n) => a + Number(n), 0)).toBe(4);
  await expect(app.card('Second post').locator('.by')).toHaveText('Jane Doe');
});

test('search palette jumps to a post, a feed and a view', async ({ app, page }) => {
  await app.go('inbox');
  await page.keyboard.press('/');
  await expect(page.locator('#palette')).toBeVisible();
  await page.locator('#palIn').fill('oldest');
  await page.locator('#palIn').press('Enter');
  await expect(page.locator('#palette')).toBeHidden();
  await expect(app.card('Oldest post')).toHaveClass(/\bkb\b/);

  await page.keyboard.press('Control+k');
  await page.locator('#palIn').fill('later');
  await expect(page.locator('#palList [aria-selected="true"]')).toContainText('Later');
  await page.locator('#palIn').press('Enter');
  await expect(page.locator('[data-view="later"][aria-current="page"]').first()).toBeVisible();

  await page.locator('#searchBtn').click();
  await page.locator('#palIn').fill('nothing matches this');
  await expect(page.locator('#palList .none')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette')).toBeHidden();
});

test('? lists the shortcuts, v switches to the compact layout', async ({ app, page }) => {
  await app.go('inbox');
  await page.keyboard.press('?');
  await expect(page.locator('#dlg .keys')).toBeVisible();
  await page.locator('#dlgOk').click();
  await page.keyboard.press('v');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(app.card('Second post').locator('.sum')).toBeHidden();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
});
