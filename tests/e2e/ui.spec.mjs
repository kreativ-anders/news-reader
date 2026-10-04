// Reading list UI: sources sidebar with folders, feed context, day groups, authors, search palette, shortcuts, layout.
// Gherkin: gherkin/reading_list.feature, gherkin/sources.feature, gherkin/search.feature, gherkin/keyboard_accessibility.feature
import { test, expect, FX } from './fixtures.mjs';

test.beforeEach(async ({ app }) => {
  await app.open();
  await app.follow(`${FX()}/feeds/rss.xml`);
});

test('one feed: no sources tree; two feeds: tree with counts', async ({ app, page }) => {
  await app.go('inbox');
  await expect(page.locator('#srcSec')).toBeHidden();
  await app.follow(`${FX()}/feeds/atom.xml`);
  await app.go('inbox');
  await expect(page.locator('#srcSec')).toBeVisible();
  await expect(page.locator('#feedNav [data-filter]')).toHaveCount(2);
  await expect(page.locator('#feedNav [title="Fixture Atom"] .badge')).toHaveText('3');
});

test('narrow screens: the Sources drawer lists feeds with counts and filters the view @mobile', async ({ app, page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await app.follow(`${FX()}/feeds/atom.xml`);
  await app.go('inbox');
  await expect(page.locator('#filter')).toHaveCount(0);
  // INFO: five slots in the bottom bar with Later in the middle
  const slots = await page.locator('.nav > button').evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => e.id || e.dataset.view));
  expect(slots).toEqual(['srcMenu', 'inbox', 'later', 'done', 'feeds']);

  await page.locator('#srcMenu').click();
  const drawer = page.locator('#srcDrawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-filter=""]')).toBeFocused();
  await expect(drawer.locator('[data-filter=""] .badge')).toHaveText('7');
  await expect(drawer.locator('[title="Fixture Atom"] .badge')).toHaveText('3');
  // INFO: every count sits in its own row, right of the name – not pinned like the bottom-bar badge
  const rows = await drawer.locator('[data-filter]').evaluateAll((els) => els.map((b) => {
    const r = b.getBoundingClientRect(), n = b.querySelector('.nm').getBoundingClientRect(), c = b.querySelector('.badge').getBoundingClientRect();
    return c.top >= r.top && c.bottom <= r.bottom && c.left >= n.right;
  }));
  expect(rows).toEqual(rows.map(() => true));
  await drawer.locator('[title="Fixture Atom"]').click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('#view h1 .crumb')).toContainText('Fixture Atom');
  await expect(app.cards()).toHaveCount(3);
  await expect(page.locator('#srcMenu')).toHaveClass(/\bon\b/);

  // Esc closes and returns focus to the button; "All feeds" clears the filter
  await page.locator('#srcMenu').click();
  await expect(drawer.locator('[title="Fixture Atom"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.locator('#srcMenu')).toBeFocused();
  await page.locator('#srcMenu').click();
  await drawer.locator('[data-filter=""]').click();
  await expect(app.cards()).toHaveCount(7);

  // from Feeds, the drawer filters the inbox
  await app.go('feeds');
  await page.locator('#srcMenu').click();
  await drawer.locator('[title="Fixture Blog"]').click();
  await expect(page.locator('[data-view="inbox"]').first()).toBeVisible();
  await expect(app.cards()).toHaveCount(4);
});

test('desktop: no Sources button in the sidebar', async ({ app, page }) => {
  await expect(page.locator('#srcMenu')).toBeHidden();
});

test('folders: assign, filter by folder, feed context', async ({ app, page }) => {
  await app.follow(`${FX()}/feeds/atom.xml`);
  const row = page.locator('.feedrow', { has: page.locator('.t', { hasText: 'Fixture Atom' }) });
  await row.locator('[data-feed-act="folder"]').click();
  await page.locator('#folderIn').fill('Tech');
  await page.locator('#folderIn').press('Enter');
  await expect(page.locator('.fold-title')).toContainText(['Tech']);

  await app.go('inbox');
  const folder = page.locator('#feedNav [data-filter="g:Tech"]');
  await expect(folder.locator('.badge')).toHaveText('3');
  await folder.click();
  await expect(page.locator('#view h1 .crumb')).toContainText('Tech');
  await expect(app.cards()).toHaveCount(3);
  await expect(page.locator('#view .ctx')).toBeVisible();

  await page.locator('#feedNav [title="Fixture Blog"]').click();
  await expect(app.cards()).toHaveCount(4);
  const ctx = page.locator('#view .ctx');
  await expect(ctx.locator('[data-feed-act="remove"]')).toBeVisible();

  // the folder survives a reload (synced feed record)
  await page.reload();
  await expect(page.locator('#feedNav [data-filter="g:Tech"]')).toBeVisible();
});

test('posts are grouped by day and show their author', async ({ app, page }) => {
  await app.go('inbox');
  await expect(page.locator('#view .day-h').first()).toBeVisible();
  const sum = await page.locator('#view .day-h b').allTextContents();
  expect(sum.reduce((a, n) => a + Number(n), 0)).toBe(4);
  await expect(app.card('Second post').locator('.by')).toHaveText('Jane Doe');
});

test('search palette jumps to a post, a feed and a view', async ({ app, page }) => {
  await app.go('inbox');
  await page.keyboard.press('/');
  await expect(page.locator('#palette')).toBeVisible();
  await page.locator('#palIn').fill('oldest');
  await page.locator('#palIn').press('Enter');
  await expect(page.locator('#palette')).toBeHidden();
  await expect(app.card('Oldest post')).toHaveClass(/\bkb\b/);

  await page.keyboard.press('Control+k');
  await page.locator('#palIn').fill('later');
  await expect(page.locator('#palList [aria-selected="true"]')).toContainText('Later');
  await page.locator('#palIn').press('Enter');
  await expect(page.locator('[data-view="later"][aria-current="page"]').first()).toBeVisible();

  await page.locator('#searchBtn').click();
  await page.locator('#palIn').fill('nothing matches this');
  await expect(page.locator('#palList .none')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette')).toBeHidden();
});

test('? lists the shortcuts, v switches to the compact layout', async ({ app, page }) => {
  await app.go('inbox');
  await page.keyboard.press('?');
  await expect(page.locator('#dlg .keys')).toBeVisible();
  await page.locator('#dlgOk').click();
  await page.keyboard.press('v');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(app.card('Second post').locator('.sum')).toBeHidden();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
});

test.describe('card actions stay accessible although they appear on hover', () => {
  test('screen readers: card named by its title, actions described by it', async ({ app }) => {
    await app.go('inbox');
    const c = app.card('Second post');
    await expect(c).toHaveAccessibleName('Second post');
    await expect(c).toHaveAccessibleDescription(/Fixture Blog.*Jane Doe/);
    const later = c.locator('[data-act="later"]');
    await expect(later).toHaveAccessibleName('Later');
    await expect(later).toHaveAccessibleDescription('Second post');
    await expect(later).toHaveAttribute('aria-keyshortcuts', 'l');
  });

  test('keyboard: j/k move the focus, focus stays on the list after an action', async ({ app, page }) => {
    await app.go('inbox');
    await page.locator('#view').focus();
    await page.keyboard.press('j');
    const first = app.cards().first();
    await expect(first).toBeFocused();
    await expect(first.locator('[data-act="later"]')).toHaveCSS('opacity', '1');
    await page.keyboard.press('j');
    await expect(app.cards().nth(1)).toBeFocused();
    const next = await app.cards().nth(2).getAttribute('data-id');
    await page.keyboard.press('l');
    await expect(page.locator(`#view .card[data-id="${next}"]`)).toBeFocused();
    // Tab reaches the hidden buttons, and they show up while focused
    await app.cards().first().locator('h3 a').focus();
    await page.keyboard.press('Tab');
    await expect(app.cards().first().locator('[data-act="reading"]')).toBeFocused();
    await expect(app.cards().first().locator('[data-act="later"]')).toHaveCSS('opacity', '1');
  });

  test('icon actions hidden without hover, "Read now" always shown; all visible in forced colours and with "always"', async ({ app, page }) => {
    await app.go('inbox');
    await page.mouse.move(0, 0);
    await expect(app.card('Second post').locator('[data-act="reading"]')).toHaveCSS('opacity', '1');
    const acts = app.card('Second post').locator('[data-act="later"]');
    await expect(acts).toHaveCSS('opacity', '0');
    await page.emulateMedia({ forcedColors: 'active' });
    await expect(acts).toHaveCSS('opacity', '1');
    await page.emulateMedia({ forcedColors: 'none' });
    await app.go('settings');
    await page.locator('#actsSel').selectOption('always');
    await app.go('inbox');
    await page.mouse.move(0, 0);
    await expect(app.card('Second post').locator('[data-act="later"]')).toHaveCSS('opacity', '1');
  });

  test('palette announces the number of results', async ({ page }) => {
    await page.keyboard.press('/');
    await page.locator('#palIn').fill('post');
    await expect(page.locator('#palStatus')).toHaveText('4 results');
  });
});

test('a long teaser opens with its chevron or a click on the text; a short one has no chevron', async ({ app, page }) => {
  await app.follow(`${FX()}/feeds/long.xml`);
  await app.go('inbox');
  await expect(app.card('Second post').locator('[data-sum]')).toBeHidden();
  const card = app.card('A post with a long teaser');
  const toggle = card.getByRole('button', { name: 'Full teaser' });
  const clamped = () => card.locator('.sum').evaluate((p) => p.scrollHeight > p.clientHeight + 1);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await clamped()).toBe(true);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await clamped()).toBe(false);
  await card.locator('.sum').click();                       // the text itself collapses it again
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await card.locator('.sum').click();
  await app.go('later'); await app.go('inbox');              // stays open when the list re-renders
  await expect(app.card('A post with a long teaser').getByRole('button', { name: 'Full teaser' })).toHaveAttribute('aria-expanded', 'true');
});

test('text fields have visible labels', async ({ app, page }) => {
  await app.go('feeds');
  await expect(page.getByLabel('Website or feed URL')).toHaveAttribute('id', 'addUrl');
  await expect(page.locator('label[for="addUrl"]')).toBeVisible();
  await app.go('settings');
  for (const id of ['serverUrl', 'joinKey']) await expect(page.locator(`label[for="${id}"]`)).toBeVisible();
  await expect(page.getByLabel('Sync key')).toHaveAttribute('id', 'joinKey');
});
