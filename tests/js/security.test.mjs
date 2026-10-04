// INFO: regression tests for the security review – Content Security Policy of the app, URL guard used everywhere
// Gherkin: gherkin/privacy.feature
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..', '..');

// INFO: esc(), httpUrl() and hostOf() are specified in gherkin/executable/safe_output.feature
test('app CSP: strict policy, and the inline script hash matches', () => {
  const html = readFileSync(join(ROOT, 'app/index.html'), 'utf8');
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
  assert.ok(csp, 'CSP meta tag present');
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'CSP comes before every script');
  for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(d), d);
  assert.ok(!/script-src[^;]*'unsafe-(inline|eval)'/.test(csp), 'no unsafe script sources');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const code of inline) {
    const hash = createHash('sha256').update(code).digest('base64');
    assert.ok(csp.includes(`'sha256-${hash}'`), `inline script hash sha256-${hash} missing in the CSP`);
  }
});

test('app never renders a URL without the guard', () => {
  const app = readFileSync(join(ROOT, 'app/js/app.js'), 'utf8');
  assert.ok(!/href="\$\{esc\(it\.url/.test(app), 'card links go through httpUrl()');
  assert.ok(/window\.open\(safe,/.test(app), 'window.open only with a checked URL');
});
