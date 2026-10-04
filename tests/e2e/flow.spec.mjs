// The item flow: inbox → read now / later / not interested → done, undo, keyboard, swipe.
// Gherkin: gherkin/item_flow.feature
import { test, expect, FX } from './fixtures.mjs';

test.beforeEach(async ({ app }) => {
  await app.open();
  await app.follow(`${FX()}/feeds/rss.xml`);
  await app.go('inbox');
  await expect(app.cards()).toHaveCount(4);
});

test('later and not interested, with undo', async ({ app, page }) => {
  await app.card('Second post').locator('[data-act="later"]').click();
  await expect(app.cards()).toHaveCount(3);
  await expect(app.badge('later')).toHaveText('1');

  await app.card('Oldest post').locator('[data-act="dismissed"]').click();
  await expect(app.cards()).toHaveCount(2);
  await app.toast().getByRole('button').click(); // undo
  await expect(app.cards()).toHaveCount(3);
  await expect(app.card('Oldest post')).toBeVisible();

  await app.go('later');
  await expect(app.card('Second post')).toBeVisible();
  await app.card('Second post').locator('[data-act="dismissed"]').click();
  await expect(app.cards()).toHaveCount(0);
  await expect(app.badge('later')).toHaveText('');
});

test('read now opens the original in a new tab and marks it done', async ({ app, page, context }) => {
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    app.card('Second post').locator('[data-act="reading"]').click(),
  ]);
  await popup.waitForLoadState();
  expect(popup.url()).toBe(`${FX()}/article/second.html`);
  await popup.close();
  await page.bringToFront();
  await expect(app.card('Second post')).toHaveCount(0, { timeout: 10_000 });
  await app.go('done');
  await expect(app.card('Second post')).toBeVisible();
  // read again opens the original once more – the post stays in Done
  const [again] = await Promise.all([
    context.waitForEvent('page'),
    app.card('Second post').locator('[data-act="reading"]').click(),
  ]);
  await again.close();
  await page.bringToFront();
  await expect(app.card('Second post')).toBeVisible();
  await expect(app.badge('later')).toHaveText('');
});

test('posts in the old "reading" state (synced from older devices) show up in Later', async ({ app, page }) => {
  const id = await app.card('Second post').getAttribute('data-id');
  await page.evaluate((id) => new Promise((resolve, reject) => {
    const req = indexedDB.open('news');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('records', 'readwrite');
      tx.objectStore('records').put({ kind: 'item', id, data: { s: 'reading' }, updatedAt: Date.now() });
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), id);
  await page.reload();
  await expect(app.badge('later')).toHaveText('1');
  await app.go('later');
  await expect(app.card('Second post')).toBeVisible();
  await app.card('Second post').locator('[data-act="done"]').click();
  await expect(app.cards()).toHaveCount(0);
});

test('mark all done in Later', async ({ app, page }) => {
  for (const title of ['Second post', 'Oldest post', 'Relative link post']) await app.card(title).locator('[data-act="later"]').click();
  await expect(app.badge('later')).toHaveText('3');
  await app.go('later');
  await page.locator('#laterAllDone').click();
  await expect(app.cards()).toHaveCount(0);
  await app.go('done');
  await expect(app.cards()).toHaveCount(3);
  // clear done → dismissed (with confirmation)
  await page.locator('#clearDone').click();
  await page.locator('#dlgOk').click();
  await expect(app.cards()).toHaveCount(0);
});

test('keyboard: j/k select, l later, x not interested, u undo', async ({ app, page }) => {
  await page.locator('#view').focus();
  await page.keyboard.press('j');
  await page.keyboard.press('l');
  await expect(app.badge('later')).toHaveText('1');
  await expect(app.cards()).toHaveCount(3);
  await page.keyboard.press('x');
  await expect(app.cards()).toHaveCount(2);
  await page.keyboard.press('u');
  await expect(app.cards()).toHaveCount(3);
});

test('clear inbox sits below the list and dismisses everything shown', async ({ app, page }) => {
  // INFO: users read top to bottom and clear at the end – the button must follow the last post
  const after = await page.locator('#clearInbox').evaluate((b) => [...document.querySelectorAll('#view .card')].every((a) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
  expect(after).toBe(true);
  await page.locator('#clearInbox').click();
  await expect(app.cards()).toHaveCount(0);
  await expect(app.badge('inbox')).toHaveText('');
});

test('the undo toast never covers clear inbox at the end of the list @mobile', async ({ app, page }) => {
  // INFO: the toast used to float over the last buttons – clearing had to wait until it was gone
  await page.setViewportSize({ width: 390, height: 520 });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await app.card('Oldest post').locator('[data-act="later"]').click();
  await expect(app.toast()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const [btn, toast] = await Promise.all([page.locator('#clearInbox').boundingBox(), app.toast().boundingBox()]);
  expect(btn.y + btn.height).toBeLessThanOrEqual(toast.y);
  await page.locator('#clearInbox').click();
  await expect(app.cards()).toHaveCount(0);
  await expect(app.toast()).toContainText('3 posts marked not interested');
});

test('state survives a reload (IndexedDB)', async ({ app, page }) => {
  await app.card('Second post').locator('[data-act="later"]').click();
  await expect(app.badge('later')).toHaveText('1');
  await page.reload();
  await expect(app.badge('later')).toHaveText('1');
  await expect(app.cards()).toHaveCount(3);
});

test('swipe right = later, swipe left = not interested @mobile', async ({ app, page }) => {
  const swipe = (title, dx) => app.card(title).evaluate((card, dx) => {
    const r = card.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ev = (type, cx) => card.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', pointerId: 7, clientX: cx, clientY: y, isPrimary: true }));
    ev('pointerdown', x);
    for (let i = 1; i <= 10; i++) ev('pointermove', x + (dx * i) / 10);
    ev('pointerup', x + dx);
  }, dx);
  await swipe('Second post', 150);
  await expect(app.badge('later')).toHaveText('1');
  await swipe('Oldest post', -150);
  await expect(app.cards()).toHaveCount(2);
});
