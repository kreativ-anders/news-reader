// Landing site: every language page loads, is consistent for SEO and has no broken local links.
import { test, expect, API } from './fixtures.mjs';

const PAGES = [['/', 'en'], ['/de/', 'de'], ['/fr/', 'fr'], ['/it/', 'it'], ['/es/', 'es']];

for (const [path, lang] of PAGES) {
  test(`${path} loads and is consistent @mobile`, async ({ page }) => {
    const res = await page.goto(API() + path);
    expect(res.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(6);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`${lang === 'en' ? '/' : `/${lang}/`}$`));
    await expect(page.locator('#langSel')).toHaveValue(lang);
    // no untranslated markers
    for (const el of await page.locator('[data-i18n]').all()) {
      await expect(el).not.toHaveText(await el.getAttribute('data-i18n'));
    }
  });

  test(`${path}: all local links and assets resolve`, async ({ page, request }) => {
    await page.goto(API() + path);
    const urls = await page.evaluate(() => [...new Set(
      [...document.querySelectorAll('a[href], link[href], script[src], img[src], source[srcset]')]
        .map((el) => el.href || el.src || '')
        .filter((u) => u.startsWith(location.origin))
        .map((u) => u.split('#')[0]),
    )]);
    expect(urls.length).toBeGreaterThan(5);
    for (const url of urls) {
      if (url.includes('/api/')) continue;
      const r = await request.get(url);
      expect(r.status(), url).toBeLessThan(400);
    }
  });
}

test('language switcher navigates to the language URL', async ({ page }) => {
  await page.goto(API() + '/');
  await page.locator('#langSel').selectOption('de');
  await expect(page).toHaveURL(/\/de\/$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
});

test('theme toggle cycles and is shared with the app', async ({ page }) => {
  await page.goto(API() + '/');
  const btn = page.locator('#themeBtn');
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    await btn.click();
    seen.add(await btn.getAttribute('data-mode'));
  }
  expect([...seen].sort()).toEqual(['auto', 'dark', 'light']);
  await page.goto(API() + '/app/');
  await expect(page.locator('#view')).not.toBeEmpty();
});

test('"Open News" leads to the app', async ({ page }) => {
  await page.goto(API() + '/');
  await page.locator('a[href="app/"]').first().click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.locator('.nav')).toBeVisible();
});

test('sitemap and robots are valid', async ({ request }) => {
  const sitemap = await (await request.get(API() + '/sitemap.xml')).text();
  expect((sitemap.match(/<url>/g) || []).length).toBe(5);
  expect((await request.get(API() + '/robots.txt')).status()).toBe(200);
});
