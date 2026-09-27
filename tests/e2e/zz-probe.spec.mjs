import { test, FX } from './fixtures.mjs';
for (const scheme of ['dark', 'light']) test('shots ' + scheme, async ({ app, page }) => {
  await page.emulateMedia({ colorScheme: scheme });
  await app.open(); await page.screenshot({ path: '/private/tmp/claude-501/-Users-manuel-Exchange-GitHub-news-reader/59137b96-5a89-4990-911c-571d9bc0d9af/scratchpad/v2-empty-' + scheme + '.png' });
  await app.follow(FX() + '/feeds/rss.xml'); await app.follow(FX() + '/feeds/long.xml'); await app.go('inbox'); await page.mouse.move(0, 0);
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-manuel-Exchange-GitHub-news-reader/59137b96-5a89-4990-911c-571d9bc0d9af/scratchpad/v2-inbox-' + scheme + '.png' });
  await page.getByRole('button', { name: 'Show full teaser' }).click(); await page.mouse.move(0, 0);
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-manuel-Exchange-GitHub-news-reader/59137b96-5a89-4990-911c-571d9bc0d9af/scratchpad/v2-open-' + scheme + '.png', clip: { x: 360, y: 150, width: 820, height: 260 } });
  await page.setViewportSize({ width: 390, height: 700 }); await page.screenshot({ path: '/private/tmp/claude-501/-Users-manuel-Exchange-GitHub-news-reader/59137b96-5a89-4990-911c-571d9bc0d9af/scratchpad/v2-m-' + scheme + '.png' });
});
