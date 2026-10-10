// Claim intelligence engine: turns per-document extractions into a structured, policy-checked claim.
// Evaluation is deterministic and idempotent for (lines + user answers + ctx): it writes the computed
// fields onto the lines but recomputes them from scratch, so every answer simply re-runs it.

const STATUS = { COMPLETE: 'COMPLETE', NEEDS_INFO: 'NEEDS_INFO', QUESTIONABLE: 'QUESTIONABLE', EXCLUDED: 'EXCLUDED' };
const CATEGORY_ICON = {
  Lodging: '🏨', Airfare: '✈️', Rail: '🚆', 'Local conveyance': '🚕', Meals: '🍽', 'Client entertainment': '🥂',
  Fuel: '⛽', Telecom: '📱', Other: '🧾',
};

const inr = (n) => n == null ? '—' : '₹' + Math.round(n).toLocaleString('en-IN');
const normVendor = (v) => (v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normCity = (c) => {
  const s = (c || '').toLowerCase().trim();
  if (!s) return null;
  if (s.includes('delhi')) return 'Delhi';
  if (s.includes('bangalore') || s.includes('bengaluru')) return 'Bengaluru';
  if (s.includes('bombay') || s.includes('mumbai')) return 'Mumbai';
  return s.replace(/\b\w/g, (m) => m.toUpperCase());
};
// Currency as an ISO code; common rupee spellings map to INR, a missing value is assumed INR.
const CURRENCY_ALIAS = { '₹': 'INR', RS: 'INR', 'RS.': 'INR', RUPEE: 'INR', RUPEES: 'INR', '€': 'EUR', '£': 'GBP' };
const normCurrency = (c) => {
  const s = String(c || 'INR').trim().toUpperCase();
  return CURRENCY_ALIAS[s] || s;
};
const dayMs = 86400000;
const toDate = (s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : null);
const fmtDay = (s) => { const d = toDate(s); return d ? d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : '?'; };
const fmtRange = (a, b) => {
  const da = toDate(a), db = toDate(b);
  if (!da) return '';
  const o = { day: 'numeric', month: 'short' };
  return !db || a === b ? da.toLocaleDateString('en-IN', o) : `${da.getDate()}–${db.toLocaleDateString('en-IN', o)}`;
};

// ------------------------------------------------------------------ build a line from an extraction
function buildLine(doc) {
  const x = doc.extraction;
  const v = (k) => (x[k] && x[k].value != null && x[k].value !== '' ? x[k].value : null);
  const c = (k) => (x[k] ? x[k].confidence : 0);
  const currency = normCurrency(v('currency'));
  // Unknown currencies keep their face value but are flagged in evaluate() (currency_unknown).
  const fxKnown = Object.prototype.hasOwnProperty.call(POLICY.fxToInr, currency);
  const fx = fxKnown ? POLICY.fxToInr[currency] : 1;
  return {
    id: doc.id, docId: doc.id, fileName: doc.fileName, previewUrl: doc.previewUrl, hash: doc.hash,
    isReceipt: x.is_receipt !== false,
    docType: x.document_type, extractedCategory: x.category,
    vendor: v('vendor'), date: v('date'), city: normCity(v('city') || v('route_to')),
    currency, fx, fxKnown,
    total: v('total_amount') != null ? v('total_amount') * fx : null,
    tax: v('tax_amount') != null ? v('tax_amount') * fx : null,
    subtotal: v('subtotal') != null ? v('subtotal') * fx : null,
    vendorGstin: v('vendor_gstin'), buyerGstin: v('buyer_gstin'), buyerName: v('buyer_name'),
    invoiceNo: v('invoice_number'), paymentMode: v('payment_mode'),
    checkIn: v('check_in'), checkOut: v('check_out'), routeFrom: v('route_from'), routeTo: v('route_to'),
    travelClass: v('travel_class'),
    items: (x.line_items || []).map((i) => ({ ...i, amount: i.amount != null ? i.amount * fx : null })),
    integritySignals: x.integrity_signals || [],
    legibility: x.legibility, language: x.language, notes: x.notes,
    conf: {
      vendor: c('vendor'), date: c('date'), total: c('total_amount'), tax: c('tax_amount'),
      vendorGstin: c('vendor_gstin'), buyerGstin: c('buyer_gstin'), city: Math.max(c('city'), c('route_to')),
    },
    answers: {},
    // computed by evaluate():
    category: null, effDate: null, billed: null, claimable: null, status: null, flags: [], groupId: null,
  };
}

// ------------------------------------------------------------------ evaluate the whole claim
function evaluate(lines, ctx = {}) {
  const P = POLICY, cap = P.caps, today = ctx.today || new Date();
  const priorKeys = ctx.priorKeys || {}; // txnKey -> claimId from previously submitted claims

  // pass 1: per-line facts
  for (const l of lines) {
    l.flags = [];
    const a = l.answers;
    l.category = a.category || (a.mealType === 'client' ? 'Client entertainment' : l.extractedCategory) || 'Other';
    l.effDate = a.date || (l.conf.date >= P.autoFillConfidence ? l.date : null);
    l.billed = a.amount != null ? a.amount : (l.conf.total >= P.amountAutoFillConfidence ? l.total : null);
    l.txnKey = l.billed != null && l.effDate ? `${normVendor(l.vendor)}|${Math.round(l.billed)}|${l.effDate}` : null;
  }

  // pass 2: duplicates (exact file, then same transaction from a different photo, then prior claims)
  const seenHash = {}, seenTxn = {};
  for (const l of lines) {
    l.dupOf = null;
    if (l.answers.notDuplicate) continue;
    if (l.hash && seenHash[l.hash]) l.dupOf = { line: seenHash[l.hash], kind: 'exact' };
    else if (l.txnKey && seenTxn[l.txnKey]) l.dupOf = { line: seenTxn[l.txnKey], kind: 'txn' };
    if (!l.dupOf) { if (l.hash) seenHash[l.hash] = l; if (l.txnKey) seenTxn[l.txnKey] = l; }
  }

  // pass 3: validation + policy
  for (const l of lines) {
    const a = l.answers, F = (level, code, text, clause) => l.flags.push({ level, code, text, clause });
    l.claimable = l.billed;
    l.excluded = false;

    if (!l.isReceipt) { l.excluded = true; F('info', 'not_receipt', 'This doesn\'t look like a bill or payment proof, so I left it out.'); continue; }
    if (a.exclude) { l.excluded = true; F('info', 'user_excluded', 'You chose to leave this out.'); continue; }
    if (l.dupOf) {
      l.excluded = true;
      F('risk', 'duplicate', l.dupOf.kind === 'exact'
        ? `Exact copy of ${l.dupOf.line.fileName}. Left out.`
        : `Same transaction as ${l.dupOf.line.fileName} (${l.vendor}, ${inr(l.billed)}, ${fmtDay(l.effDate)}), but a different photo. Left out.`, P.clauses.dup);
      continue;
    }

    // required fields
    if (l.billed == null) F('block', 'amount_unreadable', `I couldn't read the total reliably.`);
    if (!l.effDate) F('block', 'date_unreadable', l.date ? `Date "${l.date}" is unclear.` : `No date is visible on this bill.`);
    if (l.category === 'Other' && !a.category) F('block', 'category_unclear', `I'm not sure what kind of expense this is.`);
    if (l.fxKnown === false && a.amount == null)
      F('risk', 'currency_unknown', `Amounts are in ${l.currency}, which has no rate in the policy FX table, so they were taken at face value. Finance needs to convert them.`);

    // arithmetic: items (+tax) must reconcile with printed total
    const itemSum = l.items.reduce((s, i) => s + (i.amount || 0), 0);
    if (l.items.length && l.total != null && a.amount == null) {
      const tol = Math.max(2, l.total * 0.01);
      const withTax = itemSum + (l.tax || 0);
      const ok = Math.abs(withTax - l.total) <= tol || Math.abs(itemSum - l.total) <= tol;
      if (!ok) {
        l.reconciled = Math.round(withTax);
        if (a.arith === 'items') { l.billed = l.claimable = withTax; F('info', 'arith_fixed', `Used the items + GST total (${inr(withTax)}) instead of the printed ${inr(l.total)}.`); }
        else if (a.arith === 'printed') F('risk', 'arith_mismatch', `The printed total ${inr(l.total)} doesn't match items + GST (${inr(withTax)}). Sent to finance for review.`);
        else F('block', 'arith_mismatch', `The printed total ${inr(l.total)} doesn't match items + GST (${inr(withTax)}).`);
      }
    }

    // date window
    const d = toDate(l.effDate);
    if (d) {
      if (d > today) F('risk', 'future_date', `The bill is dated in the future (${fmtDay(l.effDate)}).`);
      else if ((today - d) / dayMs > P.submissionWindowDays) F('warn', 'stale', `Older than ${P.submissionWindowDays} days, so it needs manager sign-off.`, P.clauses.window);
    }

    // GSTIN checks
    if (l.vendorGstin && !isValidGstin(l.vendorGstin)) F('risk', 'gstin_invalid', `Vendor GSTIN ${l.vendorGstin} fails the checksum.`);
    if (l.tax > 0 && ['Lodging', 'Airfare'].includes(l.category)) {
      const ours = (l.buyerGstin || '').replace(/\s/g, '').toUpperCase() === P.company.gstin;
      l.gst = { amount: l.tax, eligible: ours };
      if (ours) F('good', 'itc_ok', `${inr(l.tax)} of GST can be claimed back (company GSTIN is on the invoice).`);
      else F('warn', 'gst_lost', `Company GSTIN isn't on this invoice, so ${inr(l.tax)} of GST credit is lost. Ask the vendor for a corrected invoice.`, P.clauses.gst);
    }

    // integrity signals from the vision model
    if (l.integritySignals.length)
      F('risk', 'integrity', `Possible tampering: ${l.integritySignals.join('; ')}`);

    // category policies
    if (l.billed != null) {
      if (l.category === 'Lodging') {
        const nights = l.checkIn && l.checkOut ? Math.max(1, Math.round((toDate(l.checkOut) - toDate(l.checkIn)) / dayMs)) : 1;
        const tier = P.metroCities.includes((l.city || '').toLowerCase()) ? 'metro' : 'other';
        const perNight = (l.billed - (l.tax || 0)) / nights;
        l.nights = nights;
        if (perNight > cap.hotelPerNight[tier]) F('risk', 'hotel_cap', `Room rate ${inr(perNight)}/night is over the ${tier} cap of ${inr(cap.hotelPerNight[tier])}. Needs an approver exception.`, P.clauses.hotel);
        else F('good', 'hotel_ok', `${nights} night${nights > 1 ? 's' : ''} at ${inr(perNight)}, within the ${tier} cap of ${inr(cap.hotelPerNight[tier])}.`);
      }
      if (l.category === 'Meals' || l.category === 'Client entertainment') {
        const alcohol = l.items.filter((i) => i.is_alcohol).reduce((s, i) => s + (i.amount || 0), 0);
        if (alcohol > 0) { l.claimable -= alcohol; F('info', 'alcohol', `Removed ${inr(alcohol)} of alcohol, which isn't reimbursable.`, P.clauses.alcohol); }
        const client = a.mealType === 'client';
        const heads = client ? 1 + (a.attendees || []).length : 1;
        const perHead = client ? cap.entertainmentPerHead : cap.mealPerPerson;
        const limit = perHead * heads;
        if (l.claimable > limit) {
          if (a.mealType === 'solo' || (client && a.attendees)) {
            F('info', 'meal_capped', `Capped at ${inr(limit)} (${heads} × ${inr(perHead)}).`, client ? P.clauses.ent : P.clauses.meal);
            l.claimable = limit;
          } else if (!client) F('block', 'meal_over_cap', `${inr(l.claimable)} is over the solo meal limit of ${inr(cap.mealPerPerson)}.`, P.clauses.meal);
        }
        if (client && !a.attendees) F('block', 'attendees_missing', 'Client entertainment needs the names of the attendees.', P.clauses.ent);
        if (client && a.attendees) F('good', 'ent_ok', `Client entertainment, ${heads} people: ${a.attendees.join(', ')}.`, P.clauses.ent);
      }
      if (l.category === 'Local conveyance' && l.billed > cap.cabPerRide) F('warn', 'cab_cap', `Over the ${inr(cap.cabPerRide)} per-ride guideline.`, P.clauses.cab);
      if (l.category === 'Airfare' && l.travelClass && !P.allowedFlightClass.includes(l.travelClass.toLowerCase()))
        F('risk', 'flight_class', `${l.travelClass} class isn't allowed. Policy is economy.`, P.clauses.flight);
      if (['upi_screenshot', 'handwritten_slip'].includes(l.docType)) {
        if (l.billed <= cap.noInvoiceMax) F('info', 'noinv_ok', `${l.docType === 'upi_screenshot' ? 'UPI payment proof' : 'Handwritten slip'} accepted, since it's under ${inr(cap.noInvoiceMax)}. Self-declaration attached.`, P.clauses.noinv);
        else F('risk', 'noinv_over', `No proper invoice for ${inr(l.billed)}. Payment proof alone is only accepted up to ${inr(cap.noInvoiceMax)}.`, P.clauses.noinv);
      }
    }

    // previously submitted claims
    if (l.txnKey && priorKeys[l.txnKey]) F('risk', 'prior_claim', `Looks already claimed in ${priorKeys[l.txnKey]}.`, P.clauses.dup);
  }

  for (const l of lines) {
    l.status = l.excluded ? STATUS.EXCLUDED
      : l.flags.some((f) => f.level === 'block') ? STATUS.NEEDS_INFO
      : l.flags.some((f) => f.level === 'risk') ? STATUS.QUESTIONABLE
      : STATUS.COMPLETE;
    if (l.excluded) l.claimable = 0;
  }
  return { groups: groupLines(lines), totals: totals(lines) };
}

// ------------------------------------------------------------------ grouping into trips / events
function groupLines(lines) {
  const dated = lines.filter((l) => l.effDate).sort((a, b) => a.effDate.localeCompare(b.effDate) || (a.category === 'Airfare' ? -1 : 1));
  const groups = [];
  for (const l of dated) {
    const g = groups[groups.length - 1];
    const gap = g ? (toDate(l.effDate) - toDate(g.to)) / dayMs : Infinity;
    const cityClash = g && l.city && g.city && l.city !== g.city;
    if (!g || gap > 1 || cityClash) groups.push({ id: 'g' + groups.length, from: l.effDate, to: l.effDate, city: l.city, lines: [l] });
    else { g.lines.push(l); g.to = l.effDate; g.city = g.city || l.city; }
  }
  // Hotel stays stretch the group to the checkout date.
  for (const g of groups) for (const l of g.lines) if (l.checkOut && l.checkOut > g.to) g.to = l.checkOut;
  const undated = lines.filter((l) => !l.effDate);
  for (const g of groups) {
    const multi = g.from !== g.to;
    g.name = g.city ? `${g.city} ${multi ? 'trip' : 'day trip'}` : 'Local expenses';
    g.range = fmtRange(g.from, g.to);
  }
  if (undated.length) groups.push({ id: 'gx', name: 'Needs a date', range: '', lines: undated });
  for (const g of groups) {
    for (const l of g.lines) l.groupId = g.id;
    g.claimable = g.lines.reduce((s, l) => s + (l.claimable || 0), 0);
  }
  return groups;
}

function totals(lines) {
  const t = { files: lines.length, billed: 0, claimable: 0, excluded: 0, gstEligible: 0, gstLost: 0, counts: {} };
  for (const s of Object.values(STATUS)) t.counts[s] = 0;
  for (const l of lines) {
    t.counts[l.status]++;
    if (l.status === STATUS.EXCLUDED) { t.excluded += l.billed || 0; continue; }
    t.billed += l.billed || 0;
    t.claimable += l.claimable || 0;
    if (l.gst) l.gst.eligible ? (t.gstEligible += l.gst.amount) : (t.gstLost += l.gst.amount);
  }
  t.ready = lines.length > 0 && t.counts.NEEDS_INFO === 0 && lines.some((l) => l.status !== STATUS.EXCLUDED);
  return t;
}

// ------------------------------------------------------------------ question planner
// Turns blocking gaps into the smallest set of tap-to-answer questions, biggest amounts first.
function planQuestions(lines, groups) {
  const knownDates = [...new Set(lines.filter((l) => l.effDate).map((l) => l.effDate))].sort();
  const qs = [];
  const byAmount = [...lines].sort((a, b) => (b.total || 0) - (a.total || 0));
  for (const l of byAmount) {
    if (l.status !== STATUS.NEEDS_INFO) continue;
    const block = l.flags.find((f) => f.level === 'block');
    const who = `<b>${esc(l.vendor || l.fileName)}</b>${l.billed != null ? ` (${inr(l.billed)})` : ''}`;
    const exclude = { label: 'Leave it out', answer: { exclude: true } };
    let q = null;
    switch (block.code) {
      case 'date_unreadable': {
        const near = knownDates.slice(0, 4);
        q = { text: `I couldn't find a date on ${who}. Which day was it?`, options: [...near.map((d) => ({ label: fmtDay(d), answer: { date: d } })), exclude],
              input: { key: 'date', placeholder: 'or type a date, e.g. 22 Sep' } };
        break;
      }
      case 'amount_unreadable':
        q = { text: `The total on ${who} is hard to read. What amount was paid?`, options: [exclude], input: { key: 'amount', placeholder: 'Amount in ₹' } };
        break;
      case 'arith_mismatch':
        q = { text: `On ${who} the printed total is <b>${inr(l.total)}</b>, but items + GST add up to <b>${inr(l.reconciled)}</b>. Which should I use?`,
              options: [{ label: `Use ${inr(l.reconciled)} (items)`, answer: { arith: 'items' } }, { label: `Printed ${inr(l.total)} is right`, answer: { arith: 'printed' } }, exclude] };
        break;
      case 'meal_over_cap':
        q = { text: `Dinner at ${who} on ${fmtDay(l.effDate)} is over the solo meal limit of ${inr(POLICY.caps.mealPerPerson)}. Was it a client meal?`,
              options: [{ label: 'Yes, client meal', answer: { mealType: 'client' }, followUp: 'attendees' }, { label: `Just me, claim ${inr(POLICY.caps.mealPerPerson)}`, answer: { mealType: 'solo' } }] };
        break;
      case 'attendees_missing':
        q = { text: `Who attended the meal at ${who}? Give names and companies, separated by commas.`, options: [], input: { key: 'attendees', placeholder: 'e.g. Rahul Mehta (Zenith Pharma), Priya Nair (Zenith Pharma)' } };
        break;
      case 'category_unclear':
        q = { text: `What kind of expense is ${who}?`, options: ['Meals', 'Local conveyance', 'Lodging', 'Telecom', 'Fuel'].map((c) => ({ label: c, answer: { category: c } })).concat([exclude]) };
        break;
    }
    if (q) qs.push({ lineId: l.id, code: block.code, ...q });
  }
  return qs;
}

// ------------------------------------------------------------------ submission payload + approver copilot
function buildSubmission(lines, groups, t, metrics) {
  const P = POLICY;
  return {
    policyVersion: P.version, employee: P.employee, company: P.company, generatedAt: new Date().toISOString(),
    totals: { billed: Math.round(t.billed), claimable: Math.round(t.claimable), excluded: Math.round(t.excluded), gstEligible: Math.round(t.gstEligible), gstLost: Math.round(t.gstLost) },
    metrics,
    trips: groups.map((g) => ({
      name: g.name, from: g.from || null, to: g.to || null, claimable: Math.round(g.claimable),
      lines: g.lines.map((l) => ({
        file: l.fileName, vendor: l.vendor, date: l.effDate, category: l.category, city: l.city,
        billed: l.billed != null ? Math.round(l.billed) : null, claimable: Math.round(l.claimable || 0), tax: l.tax, invoiceNo: l.invoiceNo,
        vendorGstin: l.vendorGstin, status: l.status, answers: l.answers, txnKey: l.txnKey,
        flags: l.flags.filter((f) => f.level !== 'good').map((f) => ({ level: f.level, code: f.code, text: f.text, clause: f.clause || null })),
      })),
    })),
  };
}

function copilotSummary(sub) {
  const lines = sub.trips.flatMap((t) => t.lines);
  const risky = lines.filter((l) => l.status === STATUS.QUESTIONABLE);
  const adjusted = lines.filter((l) => l.status !== STATUS.EXCLUDED && l.billed != null && l.claimable < l.billed);
  const excluded = lines.filter((l) => l.status === STATUS.EXCLUDED);
  const parts = [`${inr(sub.totals.claimable)} across ${sub.trips.map((t) => `${t.name} (${inr(t.claimable)})`).join(', ')}.`];
  if (!risky.length) parts.push('Everything is within policy.');
  else parts.push(`${risky.length} line${risky.length > 1 ? 's need' : ' needs'} a look: ` + risky.map((l) => `${l.vendor} ${inr(l.billed)}: ${l.flags.find((f) => f.level === 'risk').text.replace(/\.?$/, '.')}`).join(' '));
  if (adjusted.length) parts.push(`The assistant already took off ${inr(adjusted.reduce((s, l) => s + l.billed - l.claimable, 0))} (alcohol and caps).`);
  if (excluded.length) parts.push(`Left out ${excluded.length} line${excluded.length > 1 ? 's' : ''} (duplicates or not reimbursable).`);
  if (sub.totals.gstLost) parts.push(`GST credit lost: ${inr(sub.totals.gstLost)}.`);
  return { text: parts.join(' '), risk: risky.length ? (risky.length > 1 ? 'High' : 'Medium') : 'Low' };
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Node (unit tests) only; in the browser these stay plain globals. POLICY and isValidGstin come from policy.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STATUS, CATEGORY_ICON, inr, normVendor, normCity, normCurrency, toDate, fmtDay, fmtRange,
    buildLine, evaluate, groupLines, totals, planQuestions, buildSubmission, copilotSummary, esc,
  };
}
