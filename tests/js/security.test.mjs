// INFO: regression tests for the security review – URL guard, escaping, Content Security Policy of the app
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { esc, httpUrl, hostOf } from '../../app/js/util.js';

const ROOT = join(import.meta.dirname, '..', '..');

test('httpUrl lets only http(s) through', () => {
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '//evil.example', '/relative', '', null, undefined, 42]) {
    assert.equal(httpUrl(bad), '', String(bad));
  }
  assert.equal(httpUrl('https://example.org/a?b=1#c'), 'https://example.org/a?b=1#c');
  assert.equal(httpUrl('HTTP://Example.org'), 'http://example.org/');
});

test('esc covers every HTML-significant character', () => {
  assert.equal(esc(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(hostOf('https://www.example.org/x'), 'example.org');
  assert.equal(hostOf('not a url'), '');
});

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
