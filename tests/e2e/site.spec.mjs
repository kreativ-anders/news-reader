// Landing site: every language page loads, is consistent for SEO and has no broken local links.
import { test, expect, API } from './fixtures.mjs';

const LANGS = ['en', 'de', 'fr', 'it', 'es'];
const PAGES = ['', 'privacy.html', 'imprint.html', 'thanks.html']
  .flatMap((page) => LANGS.map((lang) => [`/${lang === 'en' ? '' : lang + '/'}${page}`, lang]));

for (const [path, lang] of PAGES) {
  test(`${path} loads and is consistent @mobile`, async ({ page }) => {
    const res = await page.goto(API() + path);
    expect(res.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(6);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`${path.replace(/\./g, '\\.')}$`));
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

test('API docs page loads and links resolve', async ({ page, request }) => {
  const res = await page.goto(API() + '/docs/api/');
  expect(res.status()).toBe(200);
  await expect(page.locator('h1')).toHaveText('API');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/docs\/api\/$/);
  const urls = await page.evaluate(() => [...new Set(
    [...document.querySelectorAll('a[href], link[href]')].map((el) => el.href).filter((u) => u.startsWith(location.origin)),
  )]);
  for (const url of urls) expect((await request.get(url)).status(), url).toBeLessThan(400);
});

test('sitemap and robots are valid', async ({ request }) => {
  const sitemap = await (await request.get(API() + '/sitemap.xml')).text();
  expect((sitemap.match(/<url>/g) || []).length).toBe(17); // 5 languages × (index, privacy, imprint) + app + API docs
  expect(sitemap).toMatch(/\/de\/privacy\.html<\/loc>/);
  expect(sitemap).not.toMatch(/thanks\.html/);
  expect(sitemap).toMatch(/\/app\/<\/loc>/);
  expect(sitemap).toMatch(/\/docs\/api\/<\/loc>/);
  expect((await request.get(API() + '/robots.txt')).status()).toBe(200);
});

test.describe('thanks page (Stripe return URL) follows the visitor language', () => {
  test.describe('German browser', () => {
    test.use({ locale: 'de-DE' });
    test('/thanks.html → /de/thanks.html', async ({ page }) => {
      await page.goto(API() + '/thanks.html');
      await expect(page).toHaveURL(/\/de\/thanks\.html$/);
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    });
    test('an explicit English choice (?lang=en) stays English', async ({ page }) => {
      await page.goto(API() + '/thanks.html?lang=en');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    });
  });

  test('a saved language wins over the page language', async ({ page }) => {
    await page.goto(API() + '/');
    await page.evaluate(() => localStorage.setItem('nr.lang', 'fr'));
    await page.goto(API() + '/de/thanks.html');
    await expect(page).toHaveURL(/\/fr\/thanks\.html$/);
    await page.evaluate(() => localStorage.setItem('nr.lang', 'en'));
    await page.goto(API() + '/fr/thanks.html');
    await expect(page).toHaveURL(/\/thanks\.html\?lang=en$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('an English browser stays on /thanks.html', async ({ page }) => {
    await page.goto(API() + '/thanks.html');
    await expect(page).toHaveURL(/\/thanks\.html$/);
    await expect(page.locator('h1')).toHaveText('Thank you!');
  });
});

test('legal links stay in the page language, the switcher keeps the page', async ({ page }) => {
  await page.goto(API() + '/de/');
  await expect(page.locator('footer a[href$="privacy.html"]')).toHaveAttribute('href', './privacy.html');
  await page.locator('footer a[href$="imprint.html"]').click();
  await expect(page).toHaveURL(/\/de\/imprint\.html$/);
  await expect(page.locator('h1')).toHaveText('Impressum');
  await page.locator('#langSel').selectOption('es');
  await expect(page).toHaveURL(/\/es\/imprint\.html$/);
});

test('every page loads Pirsch analytics and links to the pay-what-you-want page', async ({ page }) => {
  for (const path of ['/', '/de/privacy.html', '/it/imprint.html', '/es/thanks.html', '/docs/api/', '/app/']) {
    await page.goto(API() + path);
    await expect(page.locator('script#pianjs[src="https://api.pirsch.io/pa.js"]'), path).toHaveCount(1);
  }
  await page.goto(API() + '/');
  await expect(page.locator('a[href^="https://buy.stripe.com/"]')).toHaveCount(2);
});
