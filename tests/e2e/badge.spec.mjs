// Number on the app icon: the setting, the permission hint for Safari/iOS, and the background check in the service worker.
// Gherkin: gherkin/app_badge.feature
import { test, expect, FX } from './fixtures.mjs';

// INFO: records what the app asks the icon to show (0 = cleared)
const recordBadge = (page) => page.addInitScript(() => {
  window.__badge = [];
  const set = (n) => { window.__badge.push(n); return Promise.resolve(); };
  Object.defineProperty(navigator, 'setAppBadge', { value: set, configurable: true });
  Object.defineProperty(navigator, 'clearAppBadge', { value: () => set(0), configurable: true });
});
const lastBadge = (page) => page.evaluate(() => window.__badge.at(-1));

test('the icon shows the Inbox number and can be switched off', async ({ app, page }) => {
  await recordBadge(page);
  await app.open();
  await app.follow(`${FX()}/feeds/rss.xml`);
  await app.go('inbox');
  const n = Number(await app.badge('inbox').first().textContent());
  expect(n).toBeGreaterThan(0);
  await expect.poll(() => lastBadge(page)).toBe(n);

  await app.go('settings');
  const sel = page.locator('#badgeSel');
  await expect(sel).toHaveValue('on');
  // INFO: Chromium shows the number without asking – no permission hint
  await expect(page.locator('#badgeHint')).toHaveCount(0);
  await sel.selectOption('off');
  await expect.poll(() => lastBadge(page)).toBe(0);
  await expect(page.locator('#badgeSel')).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('news.badge'))).toBe('off');

  await page.locator('#badgeSel').selectOption('on');
  await expect.poll(() => lastBadge(page)).toBe(n);
});

test('without periodic sync (Safari, iOS) the settings ask for notification permission on click only', async ({ app, page }) => {
  await recordBadge(page);
  await page.addInitScript(() => {
    delete window.PeriodicSyncManager;
    window.__perm = 'default';
    window.__asked = 0;
    Object.defineProperty(Notification, 'permission', { get: () => window.__perm, configurable: true });
    Notification.requestPermission = () => { window.__asked++; window.__perm = 'granted'; return Promise.resolve('granted'); };
  });
  await app.open('#settings');
  const hint = page.locator('#badgeHint');
  await expect(hint).toContainText('notifications');
  await expect(page.locator('#badgeSel')).toHaveAttribute('aria-describedby', 'badgeHint');
  expect(await page.evaluate(() => window.__asked)).toBe(0);

  await page.locator('#badgeAllow').click();
  await expect(hint).toHaveCount(0);
  await expect(page.locator('#badgeAllow')).toHaveCount(0);
  await expect(page.locator('#badgeSel')).toBeFocused();
  expect(await page.evaluate(() => window.__asked)).toBe(1);
});

test('blocked notifications explain where to allow them, without a button', async ({ app, page }) => {
  await page.addInitScript(() => {
    delete window.PeriodicSyncManager;
    Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true });
  });
  await app.open('#settings');
  await expect(page.locator('#badgeHint')).toContainText('blocked');
  await expect(page.locator('#badgeAllow')).toHaveCount(0);
});

test('the background check adds posts this device has not seen to the icon number', async ({ app, page, context }) => {
  await app.open();
  await app.follow(`${FX()}/feeds/rss.xml`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // INFO: as if the sources had new posts since the last refresh – the device forgets its entries, the app left 2 on the icon
  const n = await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('news');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['entries', 'kv'], 'readwrite');
      const count = tx.objectStore('entries').count();
      tx.objectStore('entries').clear();
      const kv = tx.objectStore('kv');
      kv.put({ k: 'lastRefresh', v: 1 });
      kv.put({ k: 'fetchState', v: {} });
      kv.put({ k: 'badge', v: 2 });
      tx.oncomplete = () => { db.close(); resolve(count.result); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  expect(n).toBeGreaterThan(0);

  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await sw.evaluate(() => {
    self.__badge = [];
    Object.defineProperty(self.navigator, 'setAppBadge', { value: (v) => { self.__badge.push(v); return Promise.resolve(); }, configurable: true });
  });

  const cdp = await context.newCDPSession(page);
  const registered = new Promise((resolve) => cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
    const r = registrations.find((x) => x.scopeURL.endsWith('/app/') && !x.isDeleted);
    if (r) resolve(r.registrationId);
  }));
  await cdp.send('ServiceWorker.enable');
  const registrationId = await registered;
  await cdp.send('ServiceWorker.dispatchPeriodicSyncEvent', { origin: new URL(page.url()).origin, registrationId, tag: 'badge' });
  await expect.poll(() => sw.evaluate(() => self.__badge), { timeout: 15_000 }).toEqual([2 + n]);
});
