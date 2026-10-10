// Integration test: the 12-bill sample pack (pre-computed extractions from samples.js, i.e. a mocked
// LLM) through buildLine + evaluate + planQuestions + buildSubmission, with a fixed today (30 Sep 2026).
// These are the numbers the demo script and docs quote.
const test = require('node:test');
const assert = require('node:assert/strict');
const { engine, run, codes, sampleLines, byVendor, answerScripted } = require('./setup');

const { STATUS, planQuestions, buildSubmission, copilotSummary } = engine;
const withCode = (lines, code) => lines.filter((l) => codes(l).includes(code));
const alcoholRemoved = (lines) => lines.reduce((s, l) => s + (codes(l).includes('alcohol') ? l.items.filter((i) => i.is_alcohol).reduce((a, i) => a + i.amount, 0) : 0), 0);

test('sample pack before any answers: ₹28,347 claimable, 1 duplicate, ₹900 alcohol, ₹1,392 GST lost, 3 questions', () => {
  const lines = sampleLines();
  const { groups, totals } = run(lines);
  assert.equal(lines.length, 12);
  assert.equal(Math.round(totals.claimable), 28347);
  assert.equal(withCode(lines, 'duplicate').length, 1);
  assert.equal(withCode(lines, 'duplicate')[0].fileName, 'IMG_20260921_1004.jpg');
  assert.equal(withCode(lines, 'duplicate')[0].dupOf.kind, 'txn', 'caught by the transaction key, not the file hash');
  assert.equal(alcoholRemoved(lines), 900);
  assert.equal(totals.gstLost, 1392);
  assert.equal(totals.gstEligible, 290);
  assert.equal(totals.ready, false);
  const qs = planQuestions(lines, groups);
  assert.deepEqual(qs.map((q) => [byVendorName(lines, q.lineId), q.code]), [
    ['Tandoor Tales', 'meal_over_cap'], ['The Grill Room', 'arith_mismatch'], ['Auto-rickshaw (Ramesh K.)', 'date_unreadable'],
  ]);
});

function byVendorName(lines, id) { return lines.find((l) => l.id === id).vendor; }

test('sample pack before any answers: line status counts', () => {
  const lines = sampleLines();
  const { totals } = run(lines);
  // 7 complete + 3 needing info (Tandoor, Grill Room, auto slip) + 1 excluded duplicate; the Grill Room
  // is NEEDS_INFO (block beats its integrity risk), so nothing is QUESTIONABLE yet.
  assert.deepEqual(totals.counts, { COMPLETE: 8, NEEDS_INFO: 3, QUESTIONABLE: 0, EXCLUDED: 1 });
});

test('sample pack on the scripted path: ₹27,847 claimable in 2 trips, ready to submit', () => {
  const lines = answerScripted(sampleLines());
  const { groups, totals } = run(lines);
  assert.equal(Math.round(totals.claimable), 27847);
  assert.equal(totals.ready, true);
  assert.deepEqual(groups.map((g) => g.name), ['Delhi trip', 'Pune day trip']);
  assert.deepEqual(groups.map((g) => [g.from, g.to]), [['2026-09-21', '2026-09-23'], ['2026-09-29', '2026-09-29']]);
  const tandoor = byVendor(lines, 'Tandoor Tales')[0];
  assert.equal(tandoor.category, 'Client entertainment');
  assert.equal(tandoor.claimable, 3300);
  const grill = byVendor(lines, 'The Grill Room')[0];
  assert.equal(grill.claimable, 1365);
  assert.equal(grill.status, STATUS.QUESTIONABLE, 'still routed to finance for the integrity signals');
  assert.deepEqual(codes(grill).sort(), ['arith_fixed', 'integrity']);
  assert.equal(totals.gstLost, 1392);
});

test('sample pack: answering Tandoor "solo" gives ₹26,047', () => {
  const lines = answerScripted(sampleLines(), { tandoor: { mealType: 'solo' } });
  assert.equal(Math.round(run(lines).totals.claimable), 26047);
});

test('sample pack: answering Grill Room "printed" leaves a 4th blocking question (meal_over_cap)', () => {
  const lines = answerScripted(sampleLines());
  byVendor(lines, 'The Grill Room')[0].answers = { arith: 'printed' };
  const { groups, totals } = run(lines);
  const grill = byVendor(lines, 'The Grill Room')[0];
  assert.equal(grill.status, STATUS.NEEDS_INFO);
  assert.ok(codes(grill).includes('meal_over_cap'));
  assert.equal(totals.ready, false);
  assert.deepEqual(planQuestions(lines, groups).map((q) => q.code), ['meal_over_cap']);
});

test('sample pack: copilot summary of the scripted submission is Medium risk and lists only the Grill Room', () => {
  const lines = answerScripted(sampleLines());
  const v = run(lines);
  const sub = buildSubmission(lines, v.groups, v.totals, { questionsAsked: 3 });
  assert.equal(sub.totals.claimable, 27847);
  assert.equal(sub.trips.length, 2);
  const cp = copilotSummary(sub);
  assert.equal(cp.risk, 'Medium');
  assert.match(cp.text, /^₹27,847 across Delhi trip \(₹/);
  assert.match(cp.text, /1 line needs a look: The Grill Room ₹1,365/);
  assert.match(cp.text, /Left out 1 line/);
  assert.match(cp.text, /GST credit lost: ₹1,392/);
});

test('sample pack re-run after submitting: 10 of 12 lines flagged prior_claim (not the duplicate, not the undated slip)', () => {
  const first = answerScripted(sampleLines());
  const v = run(first);
  const sub = buildSubmission(first, v.groups, v.totals, {});
  // Same rule as app.js refreshPriorClaims(): every non-excluded line with a txnKey.
  const priorKeys = {};
  for (const t of sub.trips) for (const l of t.lines) if (l.txnKey && l.status !== 'EXCLUDED') priorKeys[l.txnKey] = 'RCL-2026-001041';
  const again = sampleLines();
  run(again, { priorKeys });
  const flagged = withCode(again, 'prior_claim');
  assert.equal(flagged.length, 10);
  const missing = again.filter((l) => !flagged.includes(l)).map((l) => l.fileName).sort();
  assert.deepEqual(missing, ['IMG_20260921_1004.jpg', 'auto_receipt.jpg']);
  for (const l of flagged) assert.notEqual(l.status, STATUS.EXCLUDED);
});
