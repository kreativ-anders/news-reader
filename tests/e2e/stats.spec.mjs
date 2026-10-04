// Small numbers from data the device already has: posting rhythm, read rate, quiet feeds, reading time.
// Gherkin: gherkin/sources.feature
import { test, expect, FX } from './fixtures.mjs';

test.beforeEach(async ({ app }) => {
  await app.open();
  await app.follow(`${FX()}/feeds/rss.xml`);
});

test('Feeds header sums up the posts a week of all feeds', async ({ app, page }) => {
  await app.follow(`${FX()}/feeds/atom.xml`);
  await expect(page.locator('#view .vh p')).toHaveText(/You follow 2 feeds · ≈ \d+ posts a week/);
});

test('a folder shows the rhythm of its feeds', async ({ app, page }) => {
  await app.follow(`${FX()}/feeds/atom.xml`);
  for (const title of ['Fixture Blog', 'Fixture Atom']) {
    await page.locator('.feedrow', { has: page.locator('.t', { hasText: title }) }).locator('[data-feed-act="folder"]').click();
    await page.locator('#folderIn').fill('Tech');
    await page.locator('#folderIn').press('Enter');
    await expect(page.locator('.fold-title')).toContainText(['Tech']);
  }
  await app.go('inbox');
  await page.locator('#feedNav [data-filter="g:Tech"]').click();
  await expect(page.locator('#view .ctx')).toHaveText(/Folder with 2 feeds · ≈ \d+ posts a week/);
});

test('a feed that went quiet shows its last post', async ({ app, page }) => {
  await app.follow(`${FX()}/feeds/quiet.xml`);
  const row = page.locator('.feedrow', { has: page.locator('.t', { hasText: 'Quiet Blog' }) });
  await expect(row.locator('.st')).toContainText('last post');
  const busy = page.locator('.feedrow', { has: page.locator('.t', { hasText: 'Fixture Blog' }) });
  await expect(busy.locator('.st')).toContainText('posts a week');
});

test('the read rate only counts decisions of the last 30 days', async ({ app, page }) => {
  const feed = await page.locator('.feedrow').first().getAttribute('data-feed');
  // INFO: 6 old "done" records would tilt the rate to 55 % – "not interested" of that age is already pruned
  await page.evaluate((f) => new Promise((resolve, reject) => {
    const now = Date.now(), old = now - 60 * 864e5;
    const req = indexedDB.open('news');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('records', 'readwrite');
      const st = tx.objectStore('records');
      for (let i = 0; i < 6; i++) st.put({ kind: 'item', id: `old-${i}`, data: { s: 'done', f, t: `Old ${i}` }, updatedAt: old });
      for (let i = 0; i < 5; i++) st.put({ kind: 'item', id: `new-${i}`, data: { s: 'dismissed', f, t: `New ${i}` }, updatedAt: now });
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), feed);
  await page.reload();
  await app.go('feeds');
  await expect(page.locator('.feedrow').first().locator('.st')).toContainText('you read 0%');
});

test('Later shows how long its offline copies take to read', async ({ app, page }) => {
  await app.go('inbox');
  await app.card('Newest post with full text').locator('[data-act="later"]').click();
  await app.go('later');
  await expect(app.card('Newest post with full text').locator('.offline')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#view .vh p')).toContainText(/≈ \d+ min to read offline/);
});
