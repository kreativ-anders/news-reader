// Shared E2E fixtures:
//   - every page is watched for crashes: uncaught exceptions, unhandled rejections and console errors
//     fail the test (expected HTTP 4xx noise of the Collector is allowed)
//   - `app` helpers to drive the News PWA
import { test as base, expect } from '@playwright/test';

export const API = () => process.env.NR_E2E_API;
export const FX = () => process.env.NR_E2E_FIXTURES;

const ALLOWED_CONSOLE = [
  /Failed to load resource: the server responded with a status of (4\d\d|50[234])/, // Collector / article errors, PHP down
  /Failed to load resource: net::ERR_(INTERNET_DISCONNECTED|CONNECTION_REFUSED)/, // offline / unreachable-server tests
  /images\.example\.org/,                                                       // fixture thumbnails that do not exist
];

const PIRSCH = 'https://api.pirsch.io/**';

export const test = base.extend({
  // tests stay offline: the Pirsch analytics script is answered with an empty stub, and its URL is recorded
  context: async ({ context }, use) => {
    await context.route(PIRSCH, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await use(context);
  },

  crashes: [async ({ context }, use) => {
    const problems = [];
    // only our own pages (app + site) – articles opened from the fixture "internet" may do what they want
    const ours = (page) => page.url().startsWith(API()) || page.url() === 'about:blank';
    const watch = (page) => {
      page.on('pageerror', (err) => { if (ours(page)) problems.push(`pageerror: ${err.message}\n${err.stack || ''}`); });
      page.on('console', (msg) => {
        if (msg.type() !== 'error' || !ours(page)) return;
        const text = msg.text();
        if (ALLOWED_CONSOLE.some((re) => re.test(text) || re.test(msg.location()?.url || ''))) return;
        problems.push(`console.error: ${text} (${msg.location()?.url || ''})`);
      });
    };
    context.pages().forEach(watch);
    context.on('page', watch);
    await use(problems);
    expect(problems, 'the page must not crash or log errors').toEqual([]);
  }, { auto: true }],

  app: async ({ page }, use) => {
    await use(new App(page));
  },
});

export { expect };

export class App {
  constructor(page) { this.page = page; }

  url(path = '') { return `${API()}/app/${path}`; }

  async open(path = '') {
    await this.page.goto(this.url(path));
    await expect(this.page.locator('#view')).not.toBeEmpty();
    return this;
  }

  view(name) { return this.page.locator(`.nav [data-view="${name}"]`); }

  async go(name) {
    await this.page.locator(`[data-view="${name}"]`).first().click();
    await expect(this.page.locator(`[data-view="${name}"][aria-current="page"]`).first()).toBeVisible();
  }

  cards() { return this.page.locator('#view .card'); }

  card(title) { return this.page.locator('#view .card', { has: this.page.getByRole('link', { name: title, exact: true }) }); }

  badge(view) { return this.page.locator(`[data-count="${view}"]`); }

  /** Follow a feed through the Feeds view; resolves with the result line. */
  async follow(url) {
    await this.go('feeds');
    await this.page.locator('#addUrl').fill(url);
    await this.page.locator('#addForm button[type="submit"]').click();
    const result = this.page.locator('#addResult');
    await expect(result).not.toHaveText(/…|\.\.\./, { timeout: 15_000 });
    await expect(result.locator('.pill, .err')).toBeVisible({ timeout: 15_000 });
    return result;
  }

  /** Read a value from the app's IndexedDB kv store. */
  kv(key) {
    return this.page.evaluate((k) => new Promise((resolve, reject) => {
      const req = indexedDB.open('news');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const get = req.result.transaction('kv').objectStore('kv').get(k);
        get.onsuccess = () => { resolve(get.result?.v ?? null); req.result.close(); };
        get.onerror = () => reject(get.error);
      };
    }), key);
  }

  /** Write a value into the app's IndexedDB kv store – the app reads it on its next start. */
  setKv(key, value) {
    return this.page.evaluate(([k, v]) => new Promise((resolve, reject) => {
      const req = indexedDB.open('news');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ k, v });
        tx.oncomplete = () => { resolve(); req.result.close(); };
        tx.onerror = () => reject(tx.error);
      };
    }), [key, value]);
  }

  /** Make every feed's last fetch look `ms` older and the last refresh long ago (next start refreshes). */
  async ageFetches(ms) {
    const st = await this.kv('fetchState');
    for (const s of Object.values(st)) s.at -= ms;
    await this.setKv('fetchState', st);
    await this.setKv('lastRefresh', 0);
  }

  /** Number of local changes not yet pushed to the sync server. */
  pending() {
    return this.page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('news');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const c = req.result.transaction('outbox').objectStore('outbox').count();
        c.onsuccess = () => { resolve(c.result); req.result.close(); };
        c.onerror = () => reject(c.error);
      };
    }));
  }

  toast() { return this.page.locator('#toast'); }
}
