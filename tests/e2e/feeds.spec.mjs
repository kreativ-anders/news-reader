// Following, refreshing, unfollowing feeds; OPML; share target / bookmarklet.
import { test, expect, API, FX } from './fixtures.mjs';

test('follow a website → discovered feed, entries in the inbox @mobile', async ({ app, page }) => {
  await app.open();
  const result = await app.follow(`${FX()}/blog/`);
  await expect(result.locator('.pill')).toHaveAttribute('title', 'discovered');
  await expect(result).toContainText('Fixture Blog');
  await expect(page.locator('.feedrow')).toHaveCount(1);
  await app.go('inbox');
  await expect(app.cards()).toHaveCount(4);
  await expect(app.badge('inbox')).toHaveText('4');
  await expect(page).toHaveTitle('(4) News');
  await expect(app.cards().first()).toContainText('Newest post with full text');
});

test('every resolution strategy can be followed', async ({ app, page }) => {
  await app.open();
  for (const [path, strategy] of [['/feeds/atom.xml', 'direct'], ['/guess/', 'guessed'], ['/news/', 'sitemap'], ['/magazine/', 'html-article'], ['/jsonld/', 'html-jsonld'], ['/links/', 'html-links']]) {
    const result = await app.follow(FX() + path);
    await expect(result.locator('.pill'), path).toHaveAttribute('title', strategy);
  }
  await expect(page.locator('.feedrow')).toHaveCount(6);
  await app.go('inbox');
  // /guess/ finds the same Atom feed as /feeds/atom.xml → same entry ids, shown once
  await expect(app.cards()).toHaveCount(3 + 4 + 3 + 3 + 3);
});

test('errors are shown, not thrown', async ({ app, page }) => {
  await app.open();
  await expect((await app.follow(`${FX()}/empty/`)).locator('.err')).toBeVisible();
  await expect((await app.follow(`${FX()}/missing`)).locator('.err')).toHaveAttribute('title', /404/);
  await app.follow(`${FX()}/feeds/rdf.xml`);
  await expect((await app.follow(`${FX()}/feeds/rdf.xml`)).locator('.err')).toBeVisible(); // already following
  await expect(page.locator('.feedrow')).toHaveCount(1);
});

test('refresh, rename and unfollow a feed', async ({ app, page }) => {
  await app.open();
  await app.follow(`${FX()}/feeds/rdf.xml`);
  const row = page.locator('.feedrow').first();
  await row.locator('[data-feed-act="refresh"]').click();
  await expect(row.locator('.pill')).toHaveAttribute('title', 'direct');

  await row.locator('[data-feed-act="rename"]').click();
  await page.locator('#askIn').fill('Renamed feed');
  await page.locator('#dlgOk').click();
  await expect(row.locator('.t')).toHaveText('Renamed feed');

  await row.locator('[data-feed-act="remove"]').click();
  await page.locator('#dlgOk').click();
  await expect(page.locator('.feedrow')).toHaveCount(0);
  await app.go('inbox');
  await expect(app.cards()).toHaveCount(0);
});

test('refresh all (r) keeps entries and states', async ({ app, page }) => {
  await app.open();
  await app.follow(`${FX()}/feeds/atom.xml`);
  await app.go('inbox');
  await app.card('Atom entry three').locator('[data-act="later"]').click();
  await page.keyboard.press('r');
  await expect(page.locator('#refreshBtn')).not.toHaveAttribute('aria-busy', 'true');
  await expect(app.cards()).toHaveCount(2);
  await expect(app.badge('later')).toHaveText('1');
});

test('refresh: at most two fetches at once; a feed turned away with BUSY is fetched again after Retry-After', async ({ app, page }) => {
  await app.open();
  for (const f of ['rdf.xml', 'atom.xml', 'rss.xml']) await app.follow(`${FX()}/feeds/${f}`);
  let open = 0, most = 0, atom = 0;
  await page.route('**/api/collect?**', async (route) => {
    if (decodeURIComponent(route.request().url()).includes('/feeds/atom.xml') && !atom++) {
      return route.fulfill({ status: 503, headers: { 'Retry-After': '1' }, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BUSY', message: 'Too many upstream fetches are running – try again shortly.' } }) });
    }
    most = Math.max(most, ++open);
    await new Promise((r) => setTimeout(r, 200));
    try { await route.continue(); } finally { open--; }
  });
  await page.keyboard.press('r');
  await expect(app.toast()).toContainText('1 feed will be checked again');
  await expect.poll(() => atom, { timeout: 10_000 }).toBe(2);
  await expect.poll(async () => Object.values(await app.kv('fetchState')).every((st) => st.ok && !st.retry)).toBe(true);
  expect(most).toBeLessThanOrEqual(2);
});

test('OPML export and import', async ({ app, page, browser }) => {
  await app.open();
  await app.follow(`${FX()}/feeds/rdf.xml`);
  await app.follow(`${FX()}/feeds/atom.xml`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#opmlOut').click()]);
  const path = await download.path();

  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  const errors = [];
  other.on('pageerror', (e) => errors.push(e.message));
  await other.goto(`${API()}/app/#feeds`);
  await other.locator('#opmlIn').setInputFiles(path);
  await expect(other.locator('.feedrow')).toHaveCount(2, { timeout: 15_000 });
  await expect(other.locator('#opmlResult')).not.toBeEmpty();
  expect(errors).toEqual([]);
  await ctx.close();
});

test('share target / bookmarklet prefill the follow form', async ({ app, page }) => {
  const shared = `${FX()}/blog/`;
  await app.open(`?add=${encodeURIComponent(shared)}`);
  await expect(page.locator('[data-view="feeds"][aria-current="page"]').first()).toBeVisible();
  await expect(page.locator('#addUrl')).toHaveValue(shared);
  expect(page.url()).not.toContain('add='); // cleaned from the address bar

  await app.open(`?text=${encodeURIComponent(`Look at ${shared} please`)}`);
  await expect(page.locator('#addUrl')).toHaveValue(shared);
});
