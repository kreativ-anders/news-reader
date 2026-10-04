// INFO: ties the behaviour spec in gherkin/ to code and tests – npm test fails as soon as they drift apart.
//       A failure message names the broken link; fix the spec, the header or the test marker it points at.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT, parseFeature } from '../support/gherkin.mjs';

// INFO: features that have no automated test on purpose – adding one here is a decision, not a fix
const FEATURES_WITHOUT_TEST = new Set([]);
// INFO: code that must have a home in some "# Source:" header, so new behaviour cannot skip the spec
const CODE = ['api/index.php', 'app/sw.js', ...ls('app/js', '.js'), ...ls('src', '.php').filter((f) => !f.endsWith('.local.php'))];
// INFO: built at runtime so this file never matches its own pattern
const MARKER = new RegExp(`^\\s*//\\s*${'Gherkin'}:\\s*(.+)$`);

function ls(dir, ext, { recursive = false } = {}) {
  return readdirSync(join(ROOT, dir), { recursive }).map(String).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`.replaceAll('\\', '/')).sort();
}
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const list = (header = '') => header.split(',').map((s) => s.trim()).filter(Boolean);

const features = ls('gherkin', '.feature', { recursive: true }).map((path) => ({ path, ...parseFeature(read(path), path) }));
const tests = ls('tests', '', { recursive: true })
  .filter((f) => /\.(test|spec)\.mjs$|-test\.php$/.test(f) && !f.includes('/fixtures/') && !f.endsWith('/gherkin.test.mjs'));
const markers = tests.flatMap((file) => read(file).split('\n').flatMap((line) => {
  const m = line.match(MARKER);
  return m ? list(m[1]).map((ref) => ({ file, ref })) : [];
}));

test('there are feature files, and every one parses', () => {
  assert.ok(features.length > 0);
  for (const f of features) {
    assert.ok(f.scenarios.length > 0, `${f.path} has no scenario`);
    const names = f.scenarios.map((sc) => sc.name);
    assert.equal(new Set(names).size, names.length, `${f.path}: scenario names must be unique`);
  }
});

test('"# Source:" names existing files, "# Implementation:" is one of them', () => {
  for (const f of features) {
    const sources = list(f.headers.Source);
    assert.ok(sources.length, `${f.path} needs a "# Source:" header`);
    for (const s of sources) assert.ok(existsSync(join(ROOT, s)), `${s} (from ${f.path}) does not exist`);
    assert.ok(f.headers.Implementation, `${f.path} needs a "# Implementation:" header (the one file that mainly implements it)`);
    assert.ok(sources.includes(f.headers.Implementation), `${f.path}: "${f.headers.Implementation}" must also be listed in "# Source:"`);
  }
});

test('executable features live in gherkin/executable/, are tagged and run by their "# Executable:" test', () => {
  for (const f of features) {
    const inDir = f.path.startsWith('gherkin/executable/');
    assert.equal(f.tags.includes('@executable'), inDir, `${f.path}: @executable ⇔ gherkin/executable/`);
    if (!inDir) {
      assert.ok(!f.headers.Executable, `${f.path}: only gherkin/executable/ features have "# Executable:"`);
      continue;
    }
    const runner = f.headers.Executable;
    assert.ok(runner && existsSync(join(ROOT, runner)), `${f.path} needs "# Executable:" naming an existing test file`);
    assert.ok(read(runner).includes(`runFeature('${f.path}'`), `${runner} must call runFeature('${f.path}', …)`);
  }
  for (const file of tests) {
    for (const [, path] of read(file).matchAll(/runFeature\('([^']+)'/g)) {
      assert.ok(features.some((f) => f.path === path && f.tags.includes('@executable')), `${file} runs "${path}", which is no executable feature`);
    }
  }
});

test('every "// Gherkin:" marker in a test points at an existing feature', () => {
  const paths = new Set(features.map((f) => f.path));
  for (const { file, ref } of markers) assert.ok(paths.has(ref), `${file} links to an unknown feature "${ref}"`);
});

test('every feature is covered by a test, except the deliberate exceptions', () => {
  const covered = new Set(markers.map((m) => m.ref));
  const uncovered = features.map((f) => f.path).filter((p) => !covered.has(p));
  assert.deepEqual(new Set(uncovered), FEATURES_WITHOUT_TEST,
    'Features without a test: add "// Gherkin: <feature>" to the test that covers it, or deliberately edit FEATURES_WITHOUT_TEST');
});

test('every feature is listed in gherkin/README.md, and only existing ones', () => {
  const index = read('gherkin/README.md');
  for (const f of features) assert.ok(index.includes(`\`${f.path.slice('gherkin/'.length)}\``), `${f.path} is missing from the table in gherkin/README.md`);
  for (const [, name] of index.matchAll(/`([\w/-]+\.feature)`/g)) assert.ok(existsSync(join(ROOT, 'gherkin', name)), `gherkin/README.md lists "${name}", which does not exist`);
});

test('every app and server module is named in some "# Source:"', () => {
  const named = new Set(features.flatMap((f) => list(f.headers.Source)));
  for (const file of CODE) assert.ok(named.has(file), `${file} is in no feature's "# Source:" – which behaviour does it implement?`);
});
