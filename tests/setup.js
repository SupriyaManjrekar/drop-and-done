// Test setup: loads the browser scripts into Node and provides small builders for extractions.
// policy.js, engine.js, ai.js and samples.js are plain browser scripts that share globals, so the
// globals engine.js and samples.js expect (POLICY, isValidGstin, withGstinCheck) are put on
// globalThis before they are required. Each file exports itself only when `module` exists.
const path = require('node:path');

const APP = path.join(__dirname, '..', '03-prototype', 'app');
const policy = require(path.join(APP, 'policy.js'));
Object.assign(globalThis, { POLICY: policy.POLICY, isValidGstin: policy.isValidGstin, withGstinCheck: policy.withGstinCheck });
const engine = require(path.join(APP, 'engine.js'));
globalThis.esc = engine.esc;
const ai = require(path.join(APP, 'ai.js'));

// Fixed "today" at local midnight. Sample bills are dated 21-29 Sep 2026.
const day = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const TODAY = day('2026-09-30');

const FIELDS = ['vendor', 'date', 'total_amount', 'currency', 'tax_amount', 'subtotal', 'vendor_gstin', 'buyer_gstin', 'buyer_name',
  'invoice_number', 'city', 'payment_mode', 'check_in', 'check_out', 'route_from', 'route_to', 'travel_class'];

// "$COMPANY_GSTIN" and "$GSTIN(<first 14>)" let JSON fixtures carry checksummed GSTINs.
function resolveGstin(v) {
  if (v === '$COMPANY_GSTIN') return policy.POLICY.company.gstin;
  const m = typeof v === 'string' && /^\$GSTIN\((\w{14})\)$/.exec(v);
  return m ? policy.withGstinCheck(m[1]) : v;
}

// Compact spec -> full extraction in the ai.js schema shape. Every field gets confidence 0.95 unless
// spec.conf overrides it; missing values get null / 0, as the model is told to return.
// line_items may be [description, amount, isAlcohol] tuples.
function extraction(spec = {}) {
  const conf = spec.conf || {};
  const x = {
    is_receipt: spec.is_receipt !== false,
    document_type: spec.document_type || 'receipt',
    category: spec.category || 'Meals',
    line_items: (spec.line_items || []).map((i) => (Array.isArray(i) ? { description: i[0], amount: i[1], is_alcohol: !!i[2] } : i)),
    language: 'English', legibility: spec.legibility || 'good',
    integrity_signals: spec.integrity_signals || [], notes: spec.notes || '',
  };
  for (const k of FIELDS) {
    const value = k in spec ? resolveGstin(spec[k]) : (k === 'currency' ? 'INR' : null);
    x[k] = { value: value ?? null, confidence: k in conf ? conf[k] : (value == null ? 0 : 0.95) };
  }
  return x;
}

let seq = 0;
// Build one line the way app.js does: {id, fileName, hash, extraction} -> buildLine, then attach answers.
function line(spec = {}, answers = {}) {
  seq++;
  const l = engine.buildLine({ id: spec.id || 'T' + seq, fileName: spec.fileName || `bill-${seq}.jpg`, hash: spec.hash || `hash-${seq}`, extraction: extraction(spec) });
  l.answers = { ...answers };
  return l;
}

const run = (lines, ctx = {}) => engine.evaluate(lines, { today: TODAY, ...ctx });
const codes = (l) => l.flags.map((f) => f.code);

// The 12-bill sample pack as docs, with one distinct hash per file (each file is a separate render).
function sampleDocs() {
  const { SAMPLES, sampleExtraction } = require(path.join(APP, 'samples.js'));
  return SAMPLES.map((s, i) => ({
    id: 'L' + (i + 1), fileName: s.file, hash: 'sha-' + i,
    extraction: sampleExtraction(s.dupOf != null ? SAMPLES[s.dupOf] : s),
  }));
}
const sampleLines = () => sampleDocs().map(engine.buildLine);
const byVendor = (lines, v) => lines.filter((l) => l.vendor === v);

// The demo script's answers (README "3-minute demo script").
function answerScripted(lines, { tandoor = { mealType: 'client', attendees: ['Rahul Mehta (Zenith Pharma)', 'Priya Nair (Zenith Pharma)'] } } = {}) {
  byVendor(lines, 'Tandoor Tales')[0].answers = { ...tandoor };
  byVendor(lines, 'The Grill Room')[0].answers = { arith: 'items' };
  byVendor(lines, 'Auto-rickshaw (Ramesh K.)')[0].answers = { date: '2026-09-22' };
  return lines;
}

module.exports = { APP, policy, engine, ai, TODAY, day, extraction, line, run, codes, resolveGstin, sampleDocs, sampleLines, byVendor, answerScripted };
