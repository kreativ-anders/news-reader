// The item flow: inbox → read now / later / not interested → done, undo, keyboard, swipe.
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
  // read again → "Read now"
  await app.card('Second post').locator('[data-act="reading"]').click();
  await expect(app.badge('reading')).toHaveText('1');
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

test('clear inbox dismisses everything shown', async ({ app, page }) => {
  await page.locator('#clearInbox').click();
  await expect(app.cards()).toHaveCount(0);
  await expect(app.badge('inbox')).toHaveText('');
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
