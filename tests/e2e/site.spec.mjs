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

test('every site page loads Pirsch analytics, the app none; site links to the pay-what-you-want page', async ({ page }) => {
  for (const path of ['/', '/de/privacy.html', '/it/imprint.html', '/es/thanks.html', '/docs/api/']) {
    await page.goto(API() + path);
    await expect(page.locator('script#pianjs[src="https://api.pirsch.io/pa.js"]'), path).toHaveCount(1);
    await expect(page.locator('script[src$="track.js"]'), path).toHaveCount(1);
  }
  await page.goto(API() + '/app/');
  await expect(page.locator('#view')).not.toBeEmpty();
  await expect(page.locator('script#pianjs')).toHaveCount(0);
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).not.toContain('pirsch');
  await page.goto(API() + '/');
  await expect(page.locator('a[href^="https://buy.stripe.com/"]')).toHaveCount(2);
});

test('theme toggle is named by its action and says the current mode', async ({ page }) => {
  await page.goto(API() + '/de/');
  const btn = page.locator('#themeBtn');
  await expect(btn).toHaveAccessibleName('Design wechseln – aktuell automatisch');
  await btn.click();
  await expect(btn).toHaveAccessibleName('Design wechseln – aktuell hell');
});

test('site events carry fixed values only', async ({ page }) => {
  await page.addInitScript(() => {
    window.__events = [];
    window.pirsch = (name, opts) => { window.__events.push([name, opts.meta]); return Promise.resolve(); };
  });
  await page.goto(API() + '/de/');
  await page.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest('a')) e.preventDefault(); }));
  await page.locator('header a[href$="app/"]').click();
  await page.locator('#faq summary').first().click();
  await page.locator('#themeBtn').click();
  const events = () => page.evaluate(() => window.__events);
  await expect.poll(events).toContainEqual(['Open app', { lang: 'de', position: 'header' }]);
  await expect.poll(events).toContainEqual(['FAQ', { lang: 'de', question: 'what_is_news' }]);
  expect((await events()).find(([n]) => n === 'Theme')[1].mode).toMatch(/^(auto|light|dark)$/);
});

// INFO: one accent – orange is a surface (with dark text) in both themes, never text or icon on a light ground
for (const scheme of ['light', 'dark']) {
  test(`one accent colour, readable in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(API() + '/');
    const found = await page.evaluate(() => {
      const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => [r, g, b].map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
      const bg = lum(rgb(getComputedStyle(document.body).backgroundColor));
      const colours = new Set(), low = [];
      for (const el of document.querySelectorAll('main *')) {
        const cs = getComputedStyle(el);
        const [r, g, b] = rgb(cs.color);
        // warm, saturated text colours = the accent family
        if (r - b > 90 && r >= g) colours.add(cs.color);
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const onPage = cs.backgroundColor === 'rgba(0, 0, 0, 0)' && !el.closest('.vconsole,.terminal,.btn,.pill,.d-nav em,.vnum,.vtrack');
        if (own && onPage && r - b > 90) {
          const l = lum([r, g, b]), ratio = (Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05);
          if (ratio < 4.5) low.push(`${el.className || el.tagName}: ${ratio.toFixed(2)}`);
        }
      }
      return { colours: [...colours], low };
    });
    expect(found.colours.length).toBeLessThanOrEqual(1);
    expect(found.low).toEqual([]);
  });
}

test('the hero preview mirrors the app: day group, teasers, five tabs', async ({ page }) => {
  await page.goto(API() + '/de/');
  const d = page.locator('.device');
  await expect(d.locator('.d-day')).toContainText('Heute');
  await expect(d.locator('.d-card p')).toHaveCount(3);
  await expect(d.locator('.d-nav > span')).toHaveCount(5);
  await expect(d.locator('.d-sync')).toContainText('Synchron');
});
