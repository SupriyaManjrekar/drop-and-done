// Golden / regression set: tests/golden/*.json hold small synthetic bills with answers, a fixed today
// and the expected status, claimable amount and flag codes per line. The coverage gate at the end fails
// if engine.js can emit a flag code that no golden case exercises.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { APP, line, run, codes, day } = require('./setup');

const DIR = path.join(__dirname, 'golden');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const covered = new Set();

for (const file of files) {
  const golden = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  for (const c of golden.cases) {
    test(`golden ${file}: ${c.name}`, () => {
      const lines = c.lines.map((g) => line(g.doc, g.answers || {}));
      run(lines, { today: day(c.today || golden.today), priorKeys: c.priorKeys || {} });
      c.lines.forEach((g, i) => {
        const l = lines[i], e = g.expect, at = `line ${i + 1}`;
        assert.equal(l.status, e.status, `${at} status`);
        assert.equal(l.claimable == null ? null : Math.round(l.claimable), e.claimable, `${at} claimable`);
        assert.deepEqual([...codes(l)].sort(), [...e.flags].sort(), `${at} flag codes`);
      });
    });
    for (const g of c.lines) for (const code of g.expect.flags) covered.add(code);
  }
}

// Every code passed to F(level, code, ...) in engine.js.
function emittedCodes() {
  const src = fs.readFileSync(path.join(APP, 'engine.js'), 'utf8');
  return [...new Set([...src.matchAll(/\bF\(\s*'(\w+)',\s*'(\w+)'/g)].map((m) => m[2]))].sort();
}

test('risk coverage: every flag code engine.js emits has at least one golden case', () => {
  const emitted = emittedCodes();
  assert.ok(emitted.length >= 25, `expected to find the engine's flag codes, found ${emitted.length}`);
  const missing = emitted.filter((c) => !covered.has(c));
  assert.deepEqual(missing, [], `flag codes without a golden case: ${missing.join(', ')}`);
});

test('risk coverage: golden files only expect codes engine.js can emit', () => {
  const emitted = new Set(emittedCodes());
  assert.deepEqual([...covered].filter((c) => !emitted.has(c)), []);
});
