// Reimbursement policy as code. In production this is versioned in the Policy Repository
// and resolved per employee grade; here it is a single demo profile.
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// GSTIN = 2-digit state + PAN + entity + 'Z' + check character (mod-36 checksum).
function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}
function withGstinCheck(first14) { return first14 + gstinCheckChar(first14); }
function isValidGstin(g) {
  if (!g) return false;
  g = g.replace(/\s/g, '').toUpperCase();
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) && gstinCheckChar(g.slice(0, 14)) === g[14];
}

const POLICY = {
  version: 'TRV-EXP-2026.2',
  company: { name: 'Innovation Corp Ltd', gstin: withGstinCheck('27AAACI1234K1Z') },
  employee: { name: 'Demo Employee', id: 'E10234', grade: 'M2', costCentre: 'CC-4410 Digital', manager: 'R. Iyer' },
  caps: {
    hotelPerNight: { metro: 7000, other: 5000 },  // room tariff excl. GST
    mealPerPerson: 1500,
    entertainmentPerHead: 2000,
    cabPerRide: 1500,
    noInvoiceMax: 500,                             // UPI proof / handwritten slip accepted up to this
  },
  allowedFlightClass: ['economy'],
  metroCities: ['mumbai', 'delhi', 'new delhi', 'bengaluru', 'bangalore', 'chennai', 'kolkata', 'hyderabad'],
  submissionWindowDays: 60,
  maxQuestions: 3,
  autoFillConfidence: 0.7,        // date is used without asking at or above this confidence
  amountAutoFillConfidence: 0.6,  // total is used at or above this; deliberately lower than the date (see docs/DESIGN.md)
  fxToInr:{ INR: 1, USD: 84, EUR: 92, GBP: 108, AED: 22.9, SGD: 63 },
  clauses: {
    hotel: '§4.2 Lodging caps by city tier',
    meal: '§5.1 Meals: ₹1,500 per person per meal',
    ent: '§5.3 Client entertainment: ₹2,000 per head, attendees required',
    alcohol: '§5.4 Alcohol is not reimbursable',
    cab: '§6.1 Local conveyance: ₹1,500 per ride',
    noinv: '§7.2 Payment proof without invoice accepted up to ₹500',
    window: '§2.3 Claims within 60 days of spend',
    flight: '§3.1 Domestic air: economy class',
    gst: '§8.1 GST invoices must carry company GSTIN',
    dup: '§9.1 Each expense may be claimed once',
  },
};

// Policy is data, so check its shape once at load. Returns a list of problems (empty = valid).
const REQUIRED_CLAUSES = ['hotel', 'meal', 'ent', 'alcohol', 'cab', 'noinv', 'window', 'flight', 'gst', 'dup'];
function validatePolicy(p) {
  const errs = [];
  const pos = (n) => typeof n === 'number' && isFinite(n) && n > 0;
  const posInt = (n) => pos(n) && Number.isInteger(n);
  const prob = (n) => typeof n === 'number' && n > 0 && n <= 1;
  const lowerList = (a) => Array.isArray(a) && a.length > 0 && a.every((s) => typeof s === 'string' && s === s.toLowerCase());
  if (!p || typeof p !== 'object') return ['policy must be an object'];
  if (!p.version || typeof p.version !== 'string') errs.push('version must be a non-empty string');
  if (!p.company || !isValidGstin(p.company.gstin)) errs.push('company.gstin must be a valid GSTIN');
  const c = p.caps || {};
  if (!c.hotelPerNight || !pos(c.hotelPerNight.metro) || !pos(c.hotelPerNight.other)) errs.push('caps.hotelPerNight.metro and .other must be positive numbers');
  for (const k of ['mealPerPerson', 'entertainmentPerHead', 'cabPerRide', 'noInvoiceMax'])
    if (!pos(c[k])) errs.push(`caps.${k} must be a positive number`);
  if (!lowerList(p.allowedFlightClass)) errs.push('allowedFlightClass must be a non-empty list of lowercase strings');
  if (!lowerList(p.metroCities)) errs.push('metroCities must be a non-empty list of lowercase strings');
  if (!posInt(p.submissionWindowDays)) errs.push('submissionWindowDays must be a positive integer');
  if (!posInt(p.maxQuestions)) errs.push('maxQuestions must be a positive integer');
  if (!prob(p.autoFillConfidence)) errs.push('autoFillConfidence must be in (0, 1]');
  if (!prob(p.amountAutoFillConfidence)) errs.push('amountAutoFillConfidence must be in (0, 1]');
  const fx = p.fxToInr || {};
  if (fx.INR !== 1) errs.push('fxToInr.INR must be 1');
  for (const [cur, rate] of Object.entries(fx)) {
    if (!/^[A-Z]{3}$/.test(cur)) errs.push(`fxToInr key ${cur} must be a 3-letter uppercase code`);
    if (!pos(rate)) errs.push(`fxToInr.${cur} must be a positive number`);
  }
  for (const k of REQUIRED_CLAUSES)
    if (!p.clauses || typeof p.clauses[k] !== 'string' || !p.clauses[k]) errs.push(`clauses.${k} is missing`);
  return errs;
}
const POLICY_ERRORS = validatePolicy(POLICY);
if (POLICY_ERRORS.length) console.error('Policy ' + POLICY.version + ' is invalid:', POLICY_ERRORS);

// Node (unit tests) only; in the browser these stay plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSTIN_CHARS, gstinCheckChar, withGstinCheck, isValidGstin, POLICY, REQUIRED_CLAUSES, validatePolicy };
}
