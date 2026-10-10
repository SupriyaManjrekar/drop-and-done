// Unit tests for policy.js: GSTIN checksum and the shape of the POLICY object.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { APP, policy } = require('./setup');

const { POLICY, isValidGstin, gstinCheckChar, withGstinCheck, validatePolicy, REQUIRED_CLAUSES } = policy;
const CO = POLICY.company.gstin;
const clone = (o) => JSON.parse(JSON.stringify(o));

test('isValidGstin: the company GSTIN passes', () => {
  assert.equal(CO.length, 15);
  assert.equal(isValidGstin(CO), true);
});

test('isValidGstin: a widely published example GSTIN passes', () => {
  assert.equal(isValidGstin('27AAPFU0939F1ZV'), true);
});

test('isValidGstin: any changed check character fails', () => {
  const body = CO.slice(0, 14);
  for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (ch === CO[14]) continue;
    assert.equal(isValidGstin(body + ch), false, `check char ${ch} should fail`);
  }
});

test('isValidGstin: a changed PAN character fails the checksum', () => {
  const tampered = CO.slice(0, 5) + (CO[5] === 'B' ? 'C' : 'B') + CO.slice(6);
  assert.equal(isValidGstin(tampered), false);
});

test('isValidGstin: wrong length fails', () => {
  assert.equal(isValidGstin(CO.slice(0, 14)), false);
  assert.equal(isValidGstin(CO + 'A'), false);
});

test('isValidGstin: lowercase and spaces are normalised', () => {
  const spaced = CO.toLowerCase().replace(/(.{5})/g, '$1 ');
  assert.equal(isValidGstin(spaced), true);
});

test('isValidGstin: 14th character must be Z', () => {
  const body = CO.slice(0, 13) + 'Y';
  assert.equal(isValidGstin(body + gstinCheckChar(body)), false);
});

test('isValidGstin: empty, null and undefined fail', () => {
  assert.equal(isValidGstin(''), false);
  assert.equal(isValidGstin(null), false);
  assert.equal(isValidGstin(undefined), false);
});

test('gstinCheckChar round-trips with withGstinCheck', () => {
  for (const body of ['27AAACI1234K1Z', '07AAHCS4567L1Z', '29ABCDE1234F2Z', '33ZZZZZ9999Z9Z']) {
    const g = withGstinCheck(body);
    assert.equal(g.slice(0, 14), body);
    assert.equal(g[14], gstinCheckChar(body));
    assert.equal(isValidGstin(g), true, g);
  }
});

test('validatePolicy: the shipped policy is valid', () => {
  assert.deepEqual(validatePolicy(POLICY), []);
});

test('validatePolicy: every cap must be a positive number', () => {
  const p = clone(POLICY);
  p.caps.mealPerPerson = 0;
  p.caps.cabPerRide = -5;
  p.caps.hotelPerNight.metro = '7000';
  const errs = validatePolicy(p);
  assert.ok(errs.some((e) => e.includes('caps.mealPerPerson')));
  assert.ok(errs.some((e) => e.includes('caps.cabPerRide')));
  assert.ok(errs.some((e) => e.includes('caps.hotelPerNight')));
});

test('validatePolicy: thresholds, FX table, lists and clauses are checked', () => {
  const p = clone(POLICY);
  p.autoFillConfidence = 1.5;
  p.amountAutoFillConfidence = 0;
  p.fxToInr.INR = 2;
  p.fxToInr.usd = 84;
  p.metroCities = ['Mumbai'];
  p.maxQuestions = 2.5;
  delete p.clauses.gst;
  p.company.gstin = '27AAACI1234K1Z0';
  const errs = validatePolicy(p).join('\n');
  for (const s of ['autoFillConfidence', 'amountAutoFillConfidence', 'fxToInr.INR', 'fxToInr key usd', 'metroCities', 'maxQuestions', 'clauses.gst', 'company.gstin'])
    assert.ok(errs.includes(s), `expected an error about ${s}`);
  assert.deepEqual(validatePolicy(null), ['policy must be an object']);
});

test('policy: the amount auto-fill threshold is 0.6 and the date threshold 0.7 (documented decision)', () => {
  assert.equal(POLICY.amountAutoFillConfidence, 0.6);
  assert.equal(POLICY.autoFillConfidence, 0.7);
  assert.equal(POLICY.maxQuestions, 3);
});

test('policy: every clause engine.js references exists, and is in REQUIRED_CLAUSES', () => {
  const src = fs.readFileSync(path.join(APP, 'engine.js'), 'utf8');
  const used = [...new Set([...src.matchAll(/P\.clauses\.(\w+)/g)].map((m) => m[1]))];
  assert.ok(used.length >= 8, 'expected engine.js to reference clauses');
  for (const k of used) {
    assert.equal(typeof POLICY.clauses[k], 'string', `clause ${k}`);
    assert.ok(REQUIRED_CLAUSES.includes(k), `REQUIRED_CLAUSES should list ${k}`);
  }
});
