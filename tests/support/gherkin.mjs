// Tiny Gherkin runner for node:test – no dependency. Executable features in gherkin/executable/ run step by step.
//
//   runFeature('gherkin/executable/x.feature', (s) => {
//     s.step('the feed id of {string} is {string}', (w, url, id) => …);   // w = fresh world object per scenario
//     s.step(/^a regex with (\d+) groups?$/, (w, n) => …);
//   });
//
// Supported: Feature, Background, Rule, Scenario/Example, Scenario Outline/Template + Examples tables,
// Given/When/Then/And/But/*, tags, # comments. Doc strings and step data tables are refused, so a spec never
// says more than the runner checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

export const ROOT = join(import.meta.dirname, '..', '..');

const KEYWORD = /^(Given|When|Then|And|But|\*)\s+(.+)$/;
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Parses a feature file into { name, tags, headers, background, scenarios: [{ name, tags, line, steps }] }. */
export function parseFeature(text, file = 'feature') {
  const f = { name: '', tags: [], headers: {}, background: [], scenarios: [] };
  let tags = [], target = null, outline = null, header = null, section = 'head';
  const fail = (n, msg) => { throw new Error(`${file}:${n}: ${msg}`); };
  text.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1, line = raw.trim();
    if (!line) return;
    if (line.startsWith('#')) {
      const h = section === 'head' && line.match(/^#\s*([A-Z][A-Za-z]+):\s*(.*)$/);
      if (h) f.headers[h[1]] = h[2].trim();
      return;
    }
    if (line.startsWith('@')) { tags.push(...line.split(/\s+/)); return; }
    let m;
    if ((m = line.match(/^Feature:\s*(.+)$/))) { f.name = m[1]; f.tags = tags; tags = []; section = 'feature'; return; }
    if (section === 'head') fail(n, 'expected "Feature:"');
    if (/^Background:/.test(line)) { target = f.background; outline = null; section = 'steps'; return; }
    if (/^Rule:/.test(line)) { target = null; outline = null; section = 'feature'; return; }
    if ((m = line.match(/^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.+)$/))) {
      const sc = { name: m[2], tags: [...f.tags, ...tags], line: n, steps: [] };
      tags = [];
      target = sc.steps;
      outline = m[1].startsWith('Scenario ') ? { ...sc, examples: [] } : null;
      if (!outline) f.scenarios.push(sc);
      section = 'steps';
      return;
    }
    if (/^(Examples|Scenarios):/.test(line)) {
      if (!outline) fail(n, '"Examples:" without "Scenario Outline:"');
      header = null; section = 'examples';
      return;
    }
    if (line.startsWith('|')) {
      if (section !== 'examples') fail(n, 'step data tables are not supported – write an Outline or single steps');
      if (!header) { header = cells(line); return; }
      const row = cells(line);
      if (row.length !== header.length) fail(n, 'row has a different number of cells than the header');
      const vals = Object.fromEntries(header.map((h, k) => [h, row[k]]));
      const fill = (s) => s.replace(/<([^>]+)>/g, (all, k) => (k in vals ? vals[k] : all));
      f.scenarios.push({ name: `${fill(outline.name)} [${row.join(' | ')}]`, tags: outline.tags, line: n, steps: outline.steps.map((st) => ({ ...st, text: fill(st.text) })) });
      return;
    }
    if (line.startsWith('"""') || line.startsWith('```')) fail(n, 'doc strings are not supported');
    if ((m = line.match(KEYWORD))) {
      if (!target || section === 'examples') fail(n, 'step outside of a Background or Scenario');
      target.push({ keyword: m[1], text: m[2], line: n });
      return;
    }
    if (section === 'feature') return; // INFO: free-text description below Feature:/Rule:
    fail(n, `unexpected line "${line}"`);
  });
  if (!f.name) fail(1, 'no "Feature:"');
  return f;
}

// INFO: {string} "…", {int} and {word} like Cucumber expressions; regexes are used as given
const PARAM = { '{string}': ['"([^"]*)"', String], '{int}': ['(-?\\d+)', Number], '{word}': ['([^\\s"]+)', String] };
function compile(pattern) {
  if (pattern instanceof RegExp) return { re: pattern, casts: [] };
  const casts = [];
  const src = pattern.replace(/[.*+?^$()[\]\\|]/g, '\\$&').replace(/\{(string|int|word)\}/g, (p) => (casts.push(PARAM[p][1]), PARAM[p][0]));
  return { re: new RegExp(`^${src}$`), casts };
}

/** Runs every scenario of a feature file (path relative to the repo root) against the registered steps. */
export function runFeature(path, define) {
  const feature = parseFeature(readFileSync(join(ROOT, path), 'utf8'), path);
  const defs = [];
  define({ step: (pattern, fn) => defs.push({ pattern: String(pattern), ...compile(pattern), fn }) });
  const match = (st) => defs.flatMap((d) => {
    const m = st.text.match(d.re);
    return m ? [{ d, args: m.slice(1).map((v, k) => (d.casts[k] ? d.casts[k](v) : v)) }] : [];
  });
  describe(`Feature: ${feature.name}`, () => {
    test('every step has exactly one definition, every definition is used', () => {
      const all = [...feature.background, ...feature.scenarios.flatMap((sc) => sc.steps)];
      for (const st of all) assert.equal(match(st).length, 1, `${path}:${st.line} "${st.text}" needs exactly one s.step(…), found ${match(st).length}`);
      for (const d of defs) assert.ok(all.some((st) => d.re.test(st.text)), `step definition ${d.pattern} matches no step in ${path}`);
    });
    for (const sc of feature.scenarios) {
      test(`Scenario: ${sc.name}`, async () => {
        const world = {};
        for (const st of [...feature.background, ...sc.steps]) {
          const [hit] = match(st);
          if (!hit) assert.fail(`${path}:${st.line} undefined step "${st.text}"`);
          await hit.d.fn(world, ...hit.args);
        }
      });
    }
  });
}
