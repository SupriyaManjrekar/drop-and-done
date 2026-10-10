// Unit tests for engine.js, built from small hand-written extractions (see setup.extraction).
const test = require('node:test');
const assert = require('node:assert/strict');
const { engine, policy, line, run, codes, TODAY } = require('./setup');

const { STATUS, evaluate, planQuestions, copilotSummary, buildSubmission, esc, normCity, normCurrency } = engine;
const CO = policy.POLICY.company.gstin;
const cab = (o = {}) => ({ vendor: 'Metro Cabs', category: 'Local conveyance', document_type: 'app_receipt', date: '2026-09-20', total_amount: 300, city: 'Mumbai', ...o });
const meal = (o = {}) => ({ vendor: 'Spice Route', category: 'Meals', date: '2026-09-25', city: 'Mumbai', ...o });
const hotel = (o = {}) => ({ vendor: 'Harbour Inn', category: 'Lodging', document_type: 'tax_invoice', date: '2026-09-22', city: 'Mumbai', ...o });
const has = (l, code) => codes(l).includes(code);

// ------------------------------------------------------------------ auto-fill thresholds
test('auto-fill: date at confidence 0.69 becomes a question, 0.70 is used', () => {
  const low = line(cab({ conf: { date: 0.69 } })), ok = line(cab({ conf: { date: 0.7 } }));
  run([low]); run([ok]);
  assert.equal(low.effDate, null);
  assert.ok(has(low, 'date_unreadable'));
  assert.equal(low.status, STATUS.NEEDS_INFO);
  assert.equal(ok.effDate, '2026-09-20');
  assert.equal(ok.status, STATUS.COMPLETE);
});

test('auto-fill: amount at confidence 0.59 becomes a question, 0.60 is used', () => {
  const low = line(cab({ conf: { total_amount: 0.59 } })), ok = line(cab({ conf: { total_amount: 0.6 } }));
  run([low]); run([ok]);
  assert.equal(low.billed, null);
  assert.ok(has(low, 'amount_unreadable'));
  assert.equal(ok.billed, 300);
  assert.equal(ok.status, STATUS.COMPLETE);
});

test('auto-fill: a typed answer overrides an unreadable date or amount', () => {
  const l = line(cab({ date: null, conf: { total_amount: 0.3 } }), { date: '2026-09-21', amount: 275 });
  run([l]);
  assert.equal(l.effDate, '2026-09-21');
  assert.equal(l.billed, 275);
  assert.equal(l.status, STATUS.COMPLETE);
});

// ------------------------------------------------------------------ duplicates
test('duplicates: the same file hash is excluded as an exact copy', () => {
  const a = line(cab({ hash: 'same' })), b = line(cab({ hash: 'same', fileName: 'copy.jpg' }));
  const { totals } = run([a, b]);
  assert.equal(a.status, STATUS.COMPLETE);
  assert.equal(b.status, STATUS.EXCLUDED);
  assert.equal(b.dupOf.kind, 'exact');
  assert.match(b.flags[0].text, /Exact copy/);
  assert.equal(b.claimable, 0);
  assert.equal(totals.excluded, 300);
  assert.equal(totals.claimable, 300);
});

test('duplicates: the same transaction from a different photo is excluded', () => {
  const a = line(cab()), b = line(cab({ vendor: 'METRO CABS.' }));
  run([a, b]);
  assert.equal(a.txnKey, 'metrocabs|300|2026-09-20');
  assert.equal(b.dupOf.kind, 'txn');
  assert.equal(b.status, STATUS.EXCLUDED);
  assert.equal(b.flags[0].clause, policy.POLICY.clauses.dup);
});

test('duplicates: a different date is not a duplicate (no ±1 day fuzzy match)', () => {
  const a = line(cab()), b = line(cab({ date: '2026-09-21' }));
  run([a, b]);
  assert.equal(b.status, STATUS.COMPLETE);
});

test('duplicates: the notDuplicate answer overrides a duplicate', () => {
  const a = line(cab()), b = line(cab(), { notDuplicate: true });
  run([a, b]);
  assert.equal(b.dupOf, null);
  assert.equal(b.status, STATUS.COMPLETE);
  assert.equal(b.claimable, 300);
});

test('prior_claim: a line already in a submitted claim is QUESTIONABLE, not excluded, and notDuplicate does not clear it', () => {
  const priorKeys = { 'metrocabs|300|2026-09-20': 'RCL-2026-001041' };
  const a = line(cab()), b = line(cab({ hash: 'other' }), { notDuplicate: true });
  run([a], { priorKeys }); run([b], { priorKeys });
  for (const l of [a, b]) {
    assert.equal(l.status, STATUS.QUESTIONABLE);
    assert.ok(has(l, 'prior_claim'));
    assert.equal(l.claimable, 300);
  }
  assert.match(a.flags.find((f) => f.code === 'prior_claim').text, /RCL-2026-001041/);
});

test('prior_claim: skipped for excluded lines and for undated lines', () => {
  const priorKeys = { 'metrocabs|300|2026-09-20': 'RCL-1' };
  const excluded = line(cab(), { exclude: true }), undated = line(cab({ date: null }));
  run([excluded, undated], { priorKeys });
  assert.ok(!has(excluded, 'prior_claim'));
  assert.equal(undated.txnKey, null);
  assert.ok(!has(undated, 'prior_claim'));
});

// ------------------------------------------------------------------ arithmetic
test('arithmetic: items + tax reconciling with the total passes', () => {
  const l = line(meal({ total_amount: 315, tax_amount: 15, line_items: [['Dosa', 200], ['Coffee', 100]] }));
  run([l]);
  assert.ok(!has(l, 'arith_mismatch'));
  assert.equal(l.status, STATUS.COMPLETE);
});

test('arithmetic: items alone reconciling with the total passes (tax-inclusive prices)', () => {
  const l = line(meal({ total_amount: 300, tax_amount: 15, line_items: [['Dosa', 200], ['Coffee', 100]] }));
  run([l]);
  assert.ok(!has(l, 'arith_mismatch'));
});

test('arithmetic: tolerance is max(₹2, 1%)', () => {
  const within = line(meal({ total_amount: 318, tax_amount: 15, line_items: [['Dosa', 200], ['Coffee', 100]] }));
  const small = line(meal({ total_amount: 103, line_items: [['Tea', 100]] }));
  run([within]); run([small]);
  assert.ok(!has(within, 'arith_mismatch'), '₹3 off on ₹318 is inside 1% (₹3.18)');
  assert.ok(has(small, 'arith_mismatch'), '₹3 off on ₹103 is outside ₹2');
});

test('arithmetic: a mismatch blocks until answered', () => {
  const l = line(meal({ total_amount: 400, tax_amount: 15, line_items: [['Dosa', 200], ['Coffee', 100]] }));
  run([l]);
  const f = l.flags.find((x) => x.code === 'arith_mismatch');
  assert.equal(f.level, 'block');
  assert.equal(l.reconciled, 315);
  assert.equal(l.status, STATUS.NEEDS_INFO);
});

test('arithmetic: answer "items" uses items + tax; answer "printed" keeps the total as a risk', () => {
  const spec = meal({ total_amount: 400, tax_amount: 15, line_items: [['Dosa', 200], ['Coffee', 100]] });
  const items = line(spec, { arith: 'items' }), printed = line(spec, { arith: 'printed' });
  run([items]); run([printed]);
  assert.equal(items.billed, 315);
  assert.equal(items.claimable, 315);
  assert.ok(has(items, 'arith_fixed'));
  assert.equal(items.status, STATUS.COMPLETE);
  assert.equal(printed.flags.find((f) => f.code === 'arith_mismatch').level, 'risk');
  assert.equal(printed.billed, 400);
  assert.equal(printed.status, STATUS.QUESTIONABLE);
});

test('arithmetic: skipped when the user typed the amount', () => {
  const l = line(meal({ total_amount: 400, line_items: [['Dosa', 200]] }), { amount: 380 });
  run([l]);
  assert.ok(!has(l, 'arith_mismatch'));
  assert.equal(l.billed, 380);
});

// ------------------------------------------------------------------ dates
test('dates: a future date is QUESTIONABLE', () => {
  const l = line(cab({ date: '2026-10-01' }));
  run([l]);
  assert.ok(has(l, 'future_date'));
  assert.equal(l.status, STATUS.QUESTIONABLE);
});

test('dates: exactly 60 days old is fine, 61 days is stale (warning only)', () => {
  const d60 = line(cab({ date: '2026-08-01' })), d61 = line(cab({ date: '2026-07-31' }));
  run([d60]); run([d61]);
  assert.ok(!has(d60, 'stale'));
  assert.ok(has(d61, 'stale'));
  assert.equal(d61.flags.find((f) => f.code === 'stale').level, 'warn');
  assert.equal(d61.status, STATUS.COMPLETE);
});

test('dates: with a non-midnight "today" a 60-day-old bill already counts as stale (why tests inject midnight)', () => {
  const l = line(cab({ date: '2026-08-01' }));
  const tenAm = new Date(TODAY.getTime() + 10 * 3600 * 1000);
  run([l], { today: tenAm });
  assert.ok(has(l, 'stale'));
});

// ------------------------------------------------------------------ hotel
test('hotel: nights come from check-in/out and the cap applies to the pre-GST rate per night', () => {
  const l = line(hotel({ total_amount: 14560, tax_amount: 1560, check_in: '2026-09-20', check_out: '2026-09-22', buyer_gstin: CO }));
  run([l]);
  assert.equal(l.nights, 2);
  assert.ok(has(l, 'hotel_ok'));
  assert.match(l.flags.find((f) => f.code === 'hotel_ok').text, /2 nights at ₹6,500/);
  assert.equal(l.status, STATUS.COMPLETE);
});

test('hotel: metro cap 7,000 vs other-tier cap 5,000 for the same rate', () => {
  const spec = { total_amount: 6720, tax_amount: 720, buyer_gstin: CO };
  const metro = line(hotel({ ...spec, city: 'Bengaluru' })), other = line(hotel({ ...spec, city: 'Nashik' }));
  run([metro]); run([other]);
  assert.ok(has(metro, 'hotel_ok'));
  assert.equal(metro.nights, 1);
  assert.ok(has(other, 'hotel_cap'));
  assert.equal(other.status, STATUS.QUESTIONABLE);
});

// ------------------------------------------------------------------ meals
test('meals: alcohol line items are removed from the claimable amount', () => {
  const l = line(meal({ total_amount: 1000, line_items: [['Thali', 600], ['Beer', 400, true]] }));
  run([l]);
  assert.ok(has(l, 'alcohol'));
  assert.equal(l.billed, 1000);
  assert.equal(l.claimable, 600);
  assert.equal(l.status, STATUS.COMPLETE);
});

test('meals: a solo meal over ₹1,500 blocks; answering "solo" caps it at ₹1,500', () => {
  const spec = meal({ total_amount: 2400, line_items: [['Platter', 2400]] });
  const open = line(spec), solo = line(spec, { mealType: 'solo' });
  run([open]); run([solo]);
  assert.ok(has(open, 'meal_over_cap'));
  assert.equal(open.status, STATUS.NEEDS_INFO);
  assert.ok(has(solo, 'meal_capped'));
  assert.equal(solo.claimable, 1500);
  assert.equal(solo.status, STATUS.COMPLETE);
});

test('meals: a client meal needs attendees and becomes Client entertainment', () => {
  const l = line(meal({ total_amount: 2400 }), { mealType: 'client' });
  run([l]);
  assert.equal(l.category, 'Client entertainment');
  assert.ok(has(l, 'attendees_missing'));
  assert.ok(!has(l, 'meal_over_cap'));
  assert.equal(l.status, STATUS.NEEDS_INFO);
});

test('meals: the client cap is heads × ₹2,000 where heads = 1 + attendees', () => {
  const under = line(meal({ total_amount: 2400 }), { mealType: 'client', attendees: ['A. Rao'] });
  const over = line(meal({ total_amount: 5000 }), { mealType: 'client', attendees: ['A. Rao'] });
  run([under]); run([over]);
  assert.ok(has(under, 'ent_ok'));
  assert.equal(under.claimable, 2400);
  assert.ok(has(over, 'meal_capped'));
  assert.equal(over.claimable, 4000);
  assert.equal(over.status, STATUS.COMPLETE);
});

// ------------------------------------------------------------------ GST
test('GST: company GSTIN on a hotel invoice gives itc_ok; absent gives gst_lost', () => {
  const ours = line(hotel({ total_amount: 5600, tax_amount: 600, buyer_gstin: CO.toLowerCase() }));
  const lost = line(hotel({ total_amount: 5600, tax_amount: 600 }));
  const t1 = run([ours]).totals, t2 = run([lost]).totals;
  assert.ok(has(ours, 'itc_ok'));
  assert.deepEqual(ours.gst, { amount: 600, eligible: true });
  assert.equal(t1.gstEligible, 600);
  assert.ok(has(lost, 'gst_lost'));
  assert.equal(t2.gstLost, 600);
  assert.equal(lost.status, STATUS.COMPLETE, 'gst_lost is a warning');
});

test('GST: input credit is only tracked for Lodging and Airfare', () => {
  const l = line(meal({ total_amount: 315, tax_amount: 15 }));
  run([l]);
  assert.equal(l.gst, undefined);
  assert.ok(!has(l, 'gst_lost'));
});

test('GST: an invalid vendor GSTIN is QUESTIONABLE', () => {
  const l = line(meal({ total_amount: 300, vendor_gstin: CO.slice(0, 14) + (CO[14] === 'A' ? 'B' : 'A') }));
  run([l]);
  assert.ok(has(l, 'gstin_invalid'));
  assert.equal(l.status, STATUS.QUESTIONABLE);
});

// ------------------------------------------------------------------ no-invoice proof, flights, cabs
test('UPI / handwritten proof: accepted at ₹500, questionable at ₹501', () => {
  const ok = line(meal({ document_type: 'upi_screenshot', total_amount: 500 }));
  const over = line(cab({ document_type: 'handwritten_slip', total_amount: 501 }));
  run([ok]); run([over]);
  assert.ok(has(ok, 'noinv_ok'));
  assert.equal(ok.status, STATUS.COMPLETE);
  assert.ok(has(over, 'noinv_over'));
  assert.equal(over.status, STATUS.QUESTIONABLE);
});

test('flights: economy (any case) is allowed, business is QUESTIONABLE', () => {
  const air = (cls) => line({ vendor: 'IndiFly', category: 'Airfare', document_type: 'e_ticket', date: '2026-09-21', total_amount: 6000, travel_class: cls, city: 'Delhi' });
  const eco = air('ECONOMY'), biz = air('Business');
  run([eco]); run([biz]);
  assert.ok(!has(eco, 'flight_class'));
  assert.ok(has(biz, 'flight_class'));
  assert.equal(biz.status, STATUS.QUESTIONABLE);
});

test('cabs: a ride over ₹1,500 is a warning, not a block', () => {
  const l = line(cab({ total_amount: 1501 }));
  run([l]);
  assert.ok(has(l, 'cab_cap'));
  assert.equal(l.status, STATUS.COMPLETE);
});

// ------------------------------------------------------------------ currency
test('currency: known currencies convert with the policy FX table; rupee spellings mean INR', () => {
  const usd = line(meal({ currency: 'usd', total_amount: 10 })), rs = line(meal({ currency: 'Rs.', total_amount: 100 }));
  run([usd]); run([rs]);
  assert.equal(usd.billed, 840);
  assert.equal(usd.status, STATUS.COMPLETE);
  assert.equal(rs.currency, 'INR');
  assert.ok(!has(rs, 'currency_unknown'));
  assert.equal(normCurrency(null), 'INR');
  assert.equal(normCurrency(' ₹ '), 'INR');
});

test('currency: an unknown currency is flagged (taken at face value) instead of silently treated as INR', () => {
  const l = line(meal({ currency: 'JPY', total_amount: 1000 }));
  run([l]);
  assert.equal(l.fxKnown, false);
  assert.equal(l.billed, 1000);
  const f = l.flags.find((x) => x.code === 'currency_unknown');
  assert.equal(f.level, 'risk');
  assert.match(f.text, /JPY/);
  assert.equal(l.status, STATUS.QUESTIONABLE);
});

// ------------------------------------------------------------------ status derivation
test('status priority: excluded > block > risk > complete', () => {
  // risk (integrity) + block (no date) -> NEEDS_INFO; same line excluded -> EXCLUDED
  const both = line(cab({ date: null, integrity_signals: ['font mismatch'] }));
  const excl = line(cab({ date: null, integrity_signals: ['font mismatch'], hash: 'x2' }), { exclude: true });
  const risk = line(cab({ integrity_signals: ['font mismatch'], hash: 'x3', date: '2026-09-19' }));
  const notReceipt = line({ is_receipt: false, document_type: 'not_a_receipt', vendor: 'Selfie' });
  run([both, excl, risk, notReceipt]);
  assert.equal(both.status, STATUS.NEEDS_INFO);
  assert.equal(excl.status, STATUS.EXCLUDED);
  assert.deepEqual(codes(excl), ['user_excluded']);
  assert.equal(risk.status, STATUS.QUESTIONABLE);
  assert.equal(notReceipt.status, STATUS.EXCLUDED);
  assert.deepEqual(codes(notReceipt), ['not_receipt']);
});

test('category: "Other" blocks until the user picks a category', () => {
  const open = line(meal({ category: 'Other', total_amount: 400 })), picked = line(meal({ category: 'Other', total_amount: 400 }), { category: 'Telecom' });
  run([open]); run([picked]);
  assert.ok(has(open, 'category_unclear'));
  assert.equal(picked.category, 'Telecom');
  assert.equal(picked.status, STATUS.COMPLETE);
});

test('evaluate is idempotent: re-running gives the same flags, status and totals', () => {
  const lines = [line(meal({ total_amount: 1000, line_items: [['Thali', 600], ['Beer', 400, true]] })), line(cab()), line(cab())];
  const first = run(lines);
  const snap = lines.map((l) => [l.status, l.claimable, codes(l).join()]);
  const second = run(lines);
  assert.deepEqual(lines.map((l) => [l.status, l.claimable, codes(l).join()]), snap);
  assert.deepEqual(second.totals, first.totals);
});

// ------------------------------------------------------------------ grouping
test('grouping: same city on consecutive days merges; a gap over 1 day splits', () => {
  const a = line(cab({ date: '2026-09-20' })), b = line(cab({ date: '2026-09-21', total_amount: 310 })), c = line(cab({ date: '2026-09-24', total_amount: 320 }));
  const { groups } = run([c, a, b]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].lines.map((l) => l.id), [a.id, b.id]);
  assert.equal(groups[0].name, 'Mumbai trip');
  assert.equal(groups[1].name, 'Mumbai day trip');
  assert.equal(groups[0].claimable, 610);
});

test('grouping: a city change splits; a line without a city joins the current group', () => {
  const a = line(cab({ date: '2026-09-20' })), b = line(cab({ date: '2026-09-20', city: null, total_amount: 120 })), c = line(cab({ date: '2026-09-21', city: 'Pune', total_amount: 200 }));
  const { groups } = run([a, b, c]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].lines.length, 2);
  assert.equal(groups[1].city, 'Pune');
});

test('grouping: a hotel checkout widens the range but does not pull later bills in', () => {
  const h = line(hotel({ date: '2026-09-20', check_in: '2026-09-20', check_out: '2026-09-23', total_amount: 15000, tax_amount: 0 }));
  const later = line(cab({ date: '2026-09-23' }));
  const { groups } = run([h, later]);
  assert.equal(groups[0].to, '2026-09-23');
  assert.equal(groups.length, 2, 'the cab on the checkout day is more than 1 day after the hotel bill date');
});

test('grouping: undated lines go to "Needs a date"; Airfare sorts first on the same day', () => {
  const cabLine = line(cab({ date: '2026-09-21', city: 'Delhi' }));
  const air = line({ vendor: 'IndiFly', category: 'Airfare', document_type: 'e_ticket', date: '2026-09-21', total_amount: 6000, city: 'Delhi' });
  const undated = line(cab({ date: null, total_amount: 90 }));
  const { groups } = run([cabLine, undated, air]);
  assert.equal(groups[0].lines[0].id, air.id);
  const last = groups[groups.length - 1];
  assert.equal(last.id, 'gx');
  assert.equal(last.name, 'Needs a date');
  assert.deepEqual(last.lines.map((l) => l.id), [undated.id]);
});

test('grouping: a group with no city is called "Local expenses"', () => {
  const { groups } = run([line(meal({ city: null, total_amount: 200 }))]);
  assert.equal(groups[0].name, 'Local expenses');
});

// ------------------------------------------------------------------ question planner
test('planQuestions: one question per blocking line, largest printed total first', () => {
  const small = line(cab({ date: null, total_amount: 150 }));
  const big = line(meal({ total_amount: 2400, line_items: [['Platter', 2400]] }));
  const mid = line(meal({ total_amount: 400, tax_amount: 15, line_items: [['Dosa', 200], ['Coffee', 100]], date: '2026-09-24' }));
  const fine = line(cab({ total_amount: 5000, hash: 'f' }));
  const { groups } = run([small, big, mid, fine]);
  const qs = planQuestions([small, big, mid, fine], groups);
  assert.deepEqual(qs.map((q) => q.lineId), [big.id, mid.id, small.id]);
  assert.deepEqual(qs.map((q) => q.code), ['meal_over_cap', 'arith_mismatch', 'date_unreadable']);
});

test('planQuestions: the right options for each block code', () => {
  const date = line(cab({ date: null, total_amount: 150 }));
  const amount = line(cab({ conf: { total_amount: 0.2 }, date: '2026-09-19' }));
  const arith = line(meal({ total_amount: 400, tax_amount: 15, line_items: [['Dosa', 200], ['Coffee', 100]] }));
  const over = line(meal({ total_amount: 2400, date: '2026-09-26' }));
  const att = line(meal({ total_amount: 2600, date: '2026-09-27' }), { mealType: 'client' });
  const cat = line(meal({ category: 'Other', total_amount: 90, date: '2026-09-28' }));
  const lines = [date, amount, arith, over, att, cat];
  const qs = planQuestions(lines, run(lines).groups);
  const q = (l) => qs.find((x) => x.lineId === l.id);
  assert.equal(q(date).input.key, 'date');
  assert.deepEqual(q(date).options.at(-1).answer, { exclude: true });
  assert.ok(q(date).options.some((o) => o.answer.date === '2026-09-19'), 'offers known dates');
  assert.equal(q(amount).input.key, 'amount');
  assert.deepEqual(q(arith).options.map((o) => o.answer), [{ arith: 'items' }, { arith: 'printed' }, { exclude: true }]);
  assert.equal(q(over).options[0].followUp, 'attendees');
  assert.deepEqual(q(over).options[1].answer, { mealType: 'solo' });
  assert.equal(q(att).input.key, 'attendees');
  assert.ok(q(cat).options.some((o) => o.answer.category === 'Telecom'));
  assert.equal(qs.length, 6, 'planQuestions does not cap; the cap of 3 lives in app.js');
});

test('planQuestions: vendor names are HTML-escaped', () => {
  const l = line(cab({ vendor: '<img src=x onerror=alert(1)>', date: null }));
  const qs = planQuestions([l], run([l]).groups);
  assert.ok(!qs[0].text.includes('<img'));
  assert.ok(qs[0].text.includes('&lt;img'));
});

// ------------------------------------------------------------------ totals, submission, copilot
test('totals: ready is false while any line NEEDS_INFO, and false when every line is excluded', () => {
  const blocked = [line(cab()), line(cab({ date: null, hash: 'n', total_amount: 50 }))];
  assert.equal(run(blocked).totals.ready, false);
  assert.equal(run(blocked).totals.counts.NEEDS_INFO, 1);
  assert.equal(run([line(cab(), { exclude: true })]).totals.ready, false);
  assert.equal(run([line(cab())]).totals.ready, true);
  assert.equal(run([]).totals.ready, false);
});

function submit(lines) {
  const v = run(lines);
  return buildSubmission(lines, v.groups, v.totals, { questionsAsked: 0 });
}

test('buildSubmission: rounds totals, drops "good" flags and carries the policy version and txnKey', () => {
  const sub = submit([line(hotel({ total_amount: 5600.4, tax_amount: 600, buyer_gstin: CO }))]);
  assert.equal(sub.policyVersion, policy.POLICY.version);
  assert.equal(sub.totals.claimable, 5600);
  const l = sub.trips[0].lines[0];
  assert.deepEqual(l.flags, []);
  assert.equal(l.txnKey, 'harbourinn|5600|2026-09-22');
});

test('copilotSummary: risk is Low for 0, Medium for 1, High for 2+ questionable lines', () => {
  const flagged = (h) => line(cab({ integrity_signals: ['edited total'], hash: h, date: '2026-09-1' + h }));
  assert.equal(copilotSummary(submit([line(cab())])).risk, 'Low');
  assert.match(copilotSummary(submit([line(cab())])).text, /Everything is within policy/);
  assert.equal(copilotSummary(submit([flagged('1')])).risk, 'Medium');
  const high = copilotSummary(submit([flagged('1'), flagged('2')]));
  assert.equal(high.risk, 'High');
  assert.match(high.text, /2 lines need a look/);
});

test('copilotSummary: mentions adjustments, exclusions and GST credit lost', () => {
  const lines = [
    line(meal({ total_amount: 1000, line_items: [['Thali', 600], ['Beer', 400, true]] })),
    line(hotel({ total_amount: 5600, tax_amount: 600 })),
    line(cab()), line(cab()),
  ];
  const { text } = copilotSummary(submit(lines));
  assert.match(text, /took off ₹400/);
  assert.match(text, /Left out 1 line/);
  assert.match(text, /GST credit lost: ₹600/);
});

test('esc escapes HTML special characters and tolerates null', () => {
  assert.equal(esc(`<a href="x">Tom & Jerry's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(42), '42');
});

test('normCity: Delhi, Bengaluru and Mumbai aliases; title case otherwise', () => {
  assert.equal(normCity('New Delhi'), 'Delhi');
  assert.equal(normCity('bangalore'), 'Bengaluru');
  assert.equal(normCity('Bombay'), 'Mumbai');
  assert.equal(normCity('navi mumbai'), 'Mumbai');
  assert.equal(normCity('  pune '), 'Pune');
  assert.equal(normCity(''), null);
});

test('evaluate uses the real clock only when ctx.today is not given', () => {
  const l = line(cab({ date: '2020-01-01' }));
  evaluate([l]);
  assert.ok(has(l, 'stale'));
});
