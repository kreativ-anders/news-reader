// Offline reading: "Later" items are saved as readable copies and open in the reader without network.
// Gherkin: gherkin/offline.feature
import { test, expect, FX } from './fixtures.mjs';

test('later item is saved and opens in the offline reader', async ({ app, page, context }) => {
  await app.open();
  await app.follow(`${FX()}/feeds/rss.xml`);
  await app.go('inbox');
  await app.card('Newest post with full text').locator('[data-act="later"]').click();
  await app.card('Second post').locator('[data-act="later"]').click();
  await app.go('later');
  // offline copies: feed full text (no page fetch) and extracted page
  await expect(app.card('Newest post with full text').locator('.offline')).toBeVisible({ timeout: 15_000 });
  await expect(app.card('Second post').locator('.offline')).toBeVisible({ timeout: 15_000 });

  await context.setOffline(true);
  await app.card('Newest post with full text').getByRole('link').click();
  const reader = page.locator('.reader');
  await expect(reader).toBeVisible();
  await expect(reader.locator('h1')).toHaveText('Newest post with full text');
  await expect(reader.locator('.reader-body')).toContainText('full text of the long article');
  await expect(reader.locator('.reader-body script')).toHaveCount(0);

  // closed before the end → stays in Later
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);
  await expect(app.card('Newest post with full text')).toBeVisible();

  // read to the end → done
  await app.card('Second post').getByRole('link').click();
  await expect(reader).toBeVisible();
  await reader.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await reader.locator('.reader-x').click();
  await expect(reader).toHaveCount(0);
  await expect(app.card('Second post')).toHaveCount(0);
  await expect(app.badge('later')).toHaveText('1');
  await context.setOffline(false);
});

test('offline changes are kept and the app stays usable', async ({ app, page, context }) => {
  await app.open();
  await app.follow(`${FX()}/feeds/rdf.xml`);
  await app.go('inbox');
  await context.setOffline(true);
  await app.card('RDF item one').locator('[data-act="later"]').click();
  await expect(app.badge('later')).toHaveText('1');
  await page.keyboard.press('r'); // refresh while offline must not crash
  await expect(app.toast()).toBeVisible();
  await context.setOffline(false);
});
