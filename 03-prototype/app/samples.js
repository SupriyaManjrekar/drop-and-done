// Sample pack: 12 realistic, messy bills from two work trips. Rendered to PNG in the browser so the
// same files can go through live Claude extraction, or use the pre-computed extraction in demo mode.
// All businesses, people and GSTINs are fictional.

const CO_GSTIN = POLICY.company.gstin;
const fmt = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const X = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ---------------------------------------------------------------- renderers (return {svg, w, h})
function photoWrap(inner, w, h, { rot = 0, bg = '#6b5b4b', pad = 40, fade = 0 } = {}) {
  const W = w + pad * 2, H = h + pad * 2;
  return {
    w: W, h: H,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs><filter id="s"><feDropShadow dx="4" dy="6" stdDeviation="6" flood-opacity=".45"/></filter>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#3b2f25"/></linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#bg)"/>
      <g transform="translate(${pad},${pad}) rotate(${rot} ${w / 2} ${h / 2})" filter="url(#s)">${inner}</g>
      ${fade ? `<rect width="${W}" height="${H}" fill="#fff" opacity="${fade}"/>` : ''}
    </svg>`,
  };
}

function thermal(d, opt = {}) {
  const w = 360, lh = 22;
  let y = 40, rows = '';
  const t = (txt, x, anchor = 'start', extra = '') => `<text x="${x}" y="${y}" text-anchor="${anchor}" ${extra}>${X(txt)}</text>`;
  const line = () => { rows += `<line x1="20" x2="${w - 20}" y1="${y - 14}" y2="${y - 14}" stroke="#555" stroke-dasharray="4 3"/>`; };
  rows += t(d.vendor.toUpperCase(), w / 2, 'middle', 'font-weight="700" font-size="19"'); y += lh;
  for (const a of d.address) { rows += t(a, w / 2, 'middle'); y += lh - 4; }
  if (d.vendorGstin) { rows += t('GSTIN: ' + d.vendorGstin, w / 2, 'middle'); y += lh; }
  y += 6; line();
  rows += t(`Bill No: ${d.invoiceNo}`, 20) + t(`${d.dateText}  ${d.time || ''}`, w - 20, 'end'); y += lh;
  if (d.table) { rows += t(d.table, 20); y += lh; }
  y += 4; line();
  for (const i of d.items) { rows += t(i[0], 20) + t(fmt(i[1]), w - 20, 'end'); y += lh; }
  y += 4; line();
  if (d.tax) {
    rows += t('Sub Total', 20) + t(fmt(d.subtotal), w - 20, 'end'); y += lh;
    rows += t(`CGST 2.5%`, 20) + t(fmt(d.tax / 2), w - 20, 'end'); y += lh;
    rows += t(`SGST 2.5%`, 20) + t(fmt(d.tax / 2), w - 20, 'end'); y += lh;
  }
  rows += t('TOTAL', 20, 'start', `font-weight="700" font-size="19" ${opt.totalStyle || ''}`) + t('₹ ' + fmt(d.total), w - 20, 'end', `font-weight="700" font-size="19" ${opt.totalStyle || ''}`); y += lh + 4;
  rows += t(`Paid by ${d.payment}`, 20); y += lh;
  y += 4; line();
  rows += t('Thank you! Visit again', w / 2, 'middle'); y += lh;
  const h = y + 10;
  const paper = `<rect width="${w}" height="${h}" fill="${opt.paper || '#fbfaf5'}"/>
    <g font-family="Consolas, 'Courier New', monospace" font-size="15" fill="${opt.ink || '#222'}">${rows}</g>`;
  return photoWrap(paper, w, h, opt);
}

function hotelInvoice(d) {
  const w = 760, h = 860;
  const items = d.items.map((i, k) => `
    <text x="50" y="${440 + k * 30}">${X(i[0])}</text><text x="470" y="${440 + k * 30}" text-anchor="end">${i[2] || ''}</text>
    <text x="710" y="${440 + k * 30}" text-anchor="end">${fmt(i[1])}</text>`).join('');
  const inner = `<rect width="${w}" height="${h}" fill="#fff"/>
  <rect width="${w}" height="110" fill="#7c2d12"/>
  <text x="50" y="60" font-size="32" font-weight="700" fill="#fde68a" font-family="Georgia, serif">${X(d.vendor)}</text>
  <text x="50" y="90" font-size="14" fill="#fed7aa">${X(d.address.join(' · '))}</text>
  <g font-family="Segoe UI, Arial" font-size="15" fill="#1f2937">
    <text x="50" y="150" font-size="22" font-weight="700">TAX INVOICE</text>
    <text x="710" y="150" text-anchor="end">Invoice No: <tspan font-weight="700">${d.invoiceNo}</tspan></text>
    <text x="710" y="175" text-anchor="end">Invoice Date: ${d.dateText}</text>
    <text x="50" y="180">GSTIN: ${d.vendorGstin}</text>
    <rect x="50" y="205" width="660" height="120" fill="#f9fafb" stroke="#e5e7eb"/>
    <text x="70" y="235" font-weight="700">Bill To</text>
    <text x="70" y="260">Guest: ${X(d.guest)}</text>
    <text x="70" y="285">Company: ${X(d.billToCompany || '—')}</text>
    <text x="70" y="310">Company GSTIN: ${X(d.buyerGstin || '—')}</text>
    <text x="420" y="235" font-weight="700">Stay</text>
    <text x="420" y="260">Arrival: ${d.checkInText}</text>
    <text x="420" y="285">Departure: ${d.checkOutText}</text>
    <text x="420" y="310">Room: 412 · Deluxe King</text>
    <rect x="50" y="355" width="660" height="40" fill="#7c2d12"/>
    <text x="70" y="381" fill="#fff" font-weight="700">Description</text><text x="470" y="381" fill="#fff" font-weight="700" text-anchor="end">Qty</text><text x="690" y="381" fill="#fff" font-weight="700" text-anchor="end">Amount (₹)</text>
    ${items}
    <line x1="50" x2="710" y1="${470 + d.items.length * 30}" y2="${470 + d.items.length * 30}" stroke="#d1d5db"/>
    <text x="470" y="${505 + d.items.length * 30}" text-anchor="end">Taxable value</text><text x="710" y="${505 + d.items.length * 30}" text-anchor="end">${fmt(d.subtotal)}</text>
    <text x="470" y="${535 + d.items.length * 30}" text-anchor="end">CGST @ 6%</text><text x="710" y="${535 + d.items.length * 30}" text-anchor="end">${fmt(d.tax / 2)}</text>
    <text x="470" y="${565 + d.items.length * 30}" text-anchor="end">SGST @ 6%</text><text x="710" y="${565 + d.items.length * 30}" text-anchor="end">${fmt(d.tax / 2)}</text>
    <rect x="300" y="${585 + d.items.length * 30}" width="410" height="44" fill="#fef3c7"/>
    <text x="470" y="${614 + d.items.length * 30}" text-anchor="end" font-size="18" font-weight="700">Grand Total</text><text x="700" y="${614 + d.items.length * 30}" text-anchor="end" font-size="18" font-weight="700">₹ ${fmt(d.total)}</text>
    <text x="50" y="790" font-size="13" fill="#6b7280">Paid by ${d.payment}. This is a computer generated invoice.</text>
  </g>`;
  return { w, h, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${inner}</svg>` };
}

function eTicket(d) {
  const w = 820, h = 430;
  const inner = `<rect width="${w}" height="${h}" fill="#fff"/>
  <rect width="${w}" height="76" fill="#1e3a8a"/>
  <text x="40" y="50" font-size="28" font-weight="800" fill="#fff" font-family="Segoe UI, Arial">✈ ${X(d.vendor)}</text>
  <text x="${w - 40}" y="48" font-size="15" fill="#bfdbfe" text-anchor="end" font-family="Segoe UI">E-TICKET / TAX INVOICE</text>
  <g font-family="Segoe UI, Arial" font-size="15" fill="#111827">
    <text x="40" y="115">PNR: <tspan font-weight="700">${d.invoiceNo}</tspan></text><text x="300" y="115">Flight: ${d.flight}</text><text x="560" y="115">Class: ${d.travelClass}</text>
    <text x="40" y="175" font-size="40" font-weight="800">${d.from}</text><text x="260" y="168" font-size="26" fill="#64748b">────✈────</text><text x="470" y="175" font-size="40" font-weight="800">${d.to}</text>
    <text x="40" y="200" fill="#64748b">${d.fromCity}</text><text x="470" y="200" fill="#64748b">${d.toCity}</text>
    <text x="40" y="235">Date: <tspan font-weight="700">${d.dateText}</tspan>   Dep 07:10 · Arr 09:25</text>
    <text x="40" y="262">Passenger: ${X(d.guest)}</text>
    <text x="470" y="262">Customer GSTIN: ${d.buyerGstin || '—'}</text><text x="470" y="285">${X(d.billToCompany || '')}</text>
    <line x1="40" x2="${w - 40}" y1="305" y2="305" stroke="#e5e7eb"/>
    <text x="40" y="335">Base fare</text><text x="300" y="335" text-anchor="end">${fmt(d.items[0][1])}</text>
    <text x="40" y="360">Fees &amp; surcharges</text><text x="300" y="360" text-anchor="end">${fmt(d.items[1][1])}</text>
    <text x="40" y="385">IGST 5%</text><text x="300" y="385" text-anchor="end">${fmt(d.tax)}</text>
    <text x="470" y="350" font-size="22" font-weight="800">Total ₹ ${fmt(d.total)}</text>
    <text x="470" y="378" fill="#64748b">GSTIN ${d.vendorGstin}</text>
  </g>`;
  return { w, h, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${inner}</svg>` };
}

function cabApp(d, opt = {}) {
  const w = 400, h = 560;
  const inner = `<rect width="${w}" height="${h}" rx="18" fill="#fff"/>
  <rect width="${w}" height="70" rx="18" fill="#111"/><rect y="40" width="${w}" height="30" fill="#111"/>
  <text x="24" y="46" font-size="22" font-weight="800" fill="#facc15" font-family="Segoe UI">${X(d.vendor)}</text>
  <g font-family="Segoe UI, Arial" font-size="15" fill="#111">
    <text x="24" y="110" fill="#6b7280">${d.dateText} · ${d.time}</text>
    <text x="24" y="150" font-size="34" font-weight="800">₹${fmt(d.total)}</text>
    <text x="24" y="175" fill="#6b7280">Trip ID ${d.invoiceNo}</text>
    <circle cx="34" cy="215" r="6" fill="#16a34a"/><text x="52" y="220">${X(d.routeFrom)}</text>
    <line x1="34" x2="34" y1="222" y2="252" stroke="#9ca3af" stroke-dasharray="3 3"/>
    <rect x="28" y="254" width="12" height="12" fill="#dc2626"/><text x="52" y="265">${X(d.routeTo)}</text>
    <line x1="24" x2="${w - 24}" y1="295" y2="295" stroke="#e5e7eb"/>
    ${d.items.map((i, k) => `<text x="24" y="${330 + k * 28}">${X(i[0])}</text><text x="${w - 24}" y="${330 + k * 28}" text-anchor="end">₹${fmt(i[1])}</text>`).join('')}
    <line x1="24" x2="${w - 24}" y1="${330 + d.items.length * 28}" y2="${330 + d.items.length * 28}" stroke="#e5e7eb"/>
    <text x="24" y="${360 + d.items.length * 28}" font-weight="700">Total</text><text x="${w - 24}" y="${360 + d.items.length * 28}" text-anchor="end" font-weight="700">₹${fmt(d.total)}</text>
    <text x="24" y="${390 + d.items.length * 28}" fill="#6b7280">Paid via ${d.payment}</text>
    <text x="24" y="530" fill="#9ca3af" font-size="12">${X(d.vendor)} Mobility Pvt Ltd · GSTIN ${d.vendorGstin}</text>
  </g>`;
  return photoWrap(inner, w, h, { pad: 26, bg: '#334155', ...opt });
}

function upiShot(d) {
  const w = 400, h = 720;
  const inner = `<rect width="${w}" height="${h}" fill="#5b21b6"/>
  <text x="20" y="28" font-size="13" fill="#e9d5ff" font-family="Segoe UI">11:42  ▮▮▮ 4G  86%</text>
  <circle cx="200" cy="170" r="54" fill="#22c55e"/><path d="M175 170 l18 18 l34 -36" stroke="#fff" stroke-width="10" fill="none" stroke-linecap="round"/>
  <g font-family="Segoe UI, Arial" fill="#fff" text-anchor="middle">
    <text x="200" y="270" font-size="22" font-weight="700">Payment Successful</text>
    <text x="200" y="330" font-size="44" font-weight="800">₹${Number(d.total).toLocaleString('en-IN')}</text>
    <text x="200" y="375" font-size="16" fill="#ddd6fe">Paid to</text>
    <text x="200" y="402" font-size="20" font-weight="700">${X(d.vendor)}</text>
    <text x="200" y="428" font-size="14" fill="#ddd6fe">${X(d.upiId)}</text>
  </g>
  <rect x="20" y="470" width="360" height="190" rx="14" fill="#fff"/>
  <g font-family="Segoe UI, Arial" font-size="14" fill="#374151">
    <text x="40" y="505">${d.dateText}, ${d.time}</text>
    <text x="40" y="540" fill="#6b7280">UPI Transaction ID</text><text x="40" y="562" font-weight="700">${d.invoiceNo}</text>
    <text x="40" y="597" fill="#6b7280">Debited from</text><text x="40" y="619" font-weight="700">XXXX XXXX 4417 · Demo Bank</text>
    <text x="40" y="645" fill="#6b7280">Message: ${X(d.message || '')}</text>
  </g>`;
  return { w, h, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${inner}</svg>` };
}

function handSlip(d) {
  const w = 480, h = 300;
  const lines = Array.from({ length: 8 }, (_, k) => `<line x1="0" x2="${w}" y1="${50 + k * 32}" y2="${50 + k * 32}" stroke="#93c5fd" stroke-width="1"/>`).join('');
  const inner = `<rect width="${w}" height="${h}" fill="#fefce8"/>${lines}<line x1="50" x2="50" y1="0" y2="${h}" stroke="#fca5a5"/>
  <g font-family="'Segoe Print', 'Ink Free', 'Comic Sans MS', cursive" fill="#1e3a8a">
    <text x="70" y="42" font-size="24">Auto Fare Receipt</text>
    <text x="70" y="108" font-size="21">From: Karol Bagh</text>
    <text x="70" y="140" font-size="21">To: Connaught Place</text>
    <text x="70" y="172" font-size="21">Fare: ₹ 180/-</text>
    <text x="70" y="204" font-size="21">Veh. DL 1R 4471</text>
    <text x="300" y="262" font-size="22" transform="rotate(-6 300 262)">Ramesh K.</text>
  </g>
  <text x="300" y="278" font-size="11" fill="#64748b" font-family="Segoe UI">driver signature</text>`;
  return photoWrap(inner, w, h, { rot: -4, bg: '#57534e', pad: 46 });
}

// ---------------------------------------------------------------- sample data
const g = (s) => withGstinCheck(s);
const SAMPLES = [
  { file: 'IndiFly_eTicket_QX7P2L.png', render: eTicket, d: {
      vendor: 'IndiFly Airlines', invoiceNo: 'QX7P2L', flight: 'IF 2134', travelClass: 'Economy', from: 'BOM', to: 'DEL', fromCity: 'Mumbai', toCity: 'New Delhi',
      dateText: '21 Sep 2026', date: '2026-09-21', guest: POLICY.employee.name, billToCompany: POLICY.company.name, buyerGstin: CO_GSTIN,
      items: [['Base fare', 5800], ['Fees', 460]], tax: 290, subtotal: 6260, total: 6550, vendorGstin: g('27AABCI7788Q1Z'), payment: 'Corporate card',
    }, x: { document_type: 'e_ticket', category: 'Airfare', city: 'New Delhi', route_from: 'Mumbai', route_to: 'New Delhi', travel_class: 'Economy' } },

  { file: 'QuickRide_21Sep_airport.jpg', render: (d) => cabApp(d, { rot: 2 }), d: {
      vendor: 'QuickRide', invoiceNo: 'QR-88213-DEL', dateText: '21 Sep 2026', date: '2026-09-21', time: '10:02 AM', total: 640,
      routeFrom: 'IGI Airport T1, New Delhi', routeTo: 'Hotel Saffron Residency, Karol Bagh', items: [['Trip fare', 585], ['Airport fee', 55]], payment: 'UPI', vendorGstin: g('07AAFCQ2211M1Z'),
    }, x: { document_type: 'app_receipt', category: 'Local conveyance', city: 'New Delhi' } },

  { file: 'Hotel_Saffron_Invoice_INV-4471.png', render: hotelInvoice, d: {
      vendor: 'Hotel Saffron Residency', address: ['14 Pusa Road, Karol Bagh', 'New Delhi 110005'], invoiceNo: 'SR/26-27/4471', dateText: '23/09/2026', date: '2026-09-23',
      guest: POLICY.employee.name, billToCompany: '', buyerGstin: '', checkInText: '21/09/2026 12:40', checkOutText: '23/09/2026 08:15', checkIn: '2026-09-21', checkOut: '2026-09-23',
      items: [['Room charges (Deluxe King)', 11600, '2 nights']], subtotal: 11600, tax: 1392, total: 12992, vendorGstin: g('07AAHCS4567L1Z'), payment: 'Credit card',
    }, x: { document_type: 'tax_invoice', category: 'Lodging', city: 'New Delhi', check_in: '2026-09-21', check_out: '2026-09-23', buyer_gstin: null, buyer_name: POLICY.employee.name } },

  { file: 'WhatsApp Image 2026-09-22 at 22.14.jpg', render: (d) => thermal(d, { rot: -3 }), d: {
      vendor: 'Tandoor Tales', address: ['N-12 Connaught Place', 'New Delhi 110001'], vendorGstin: g('07AAKFT9012D1Z'), invoiceNo: '20931', dateText: '22/09/26', date: '2026-09-22', time: '22:04', table: 'Table 7 · Covers 3',
      items: [['Paneer Tikka', 620], ['Murgh Malai Tikka', 780], ['Dal Makhani', 480], ['Butter Naan x6', 420], ['Jeera Rice', 300], ['Kingfisher Beer x3', 900], ['Fresh Lime Soda x3', 300], ['Gulab Jamun x4', 200]],
      subtotal: 4000, tax: 200, total: 4200, payment: 'Card',
    }, x: { document_type: 'receipt', category: 'Meals', city: 'New Delhi', alcohol: ['Kingfisher Beer x3'] } },

  { file: 'IMG_20260921_1004.jpg', render: (d) => cabApp(d, { rot: -5, bg: '#1f2937' }), dupOf: 1 },

  { file: 'cafe_bill_faded.jpg', render: (d) => thermal(d, { rot: 4, fade: 0.32, ink: '#555' }), d: {
      vendor: 'Brew & Bun Cafe', address: ['Pusa Road, New Delhi'], invoiceNo: 'B-5512', dateText: '22-09-2026', date: '2026-09-22', time: '13:21',
      items: [['Masala Chai x2', 120], ['Veg Club Sandwich', 180], ['Oat Cookie', 80]], total: 380, payment: 'UPI',
    }, x: { document_type: 'receipt', category: 'Meals', city: 'New Delhi', legibility: 'fair' }, conf: { vendor: 0.78, total_amount: 0.86, date: 0.74 } },

  { file: 'auto_receipt.jpg', render: handSlip, d: { vendor: 'Auto-rickshaw (Ramesh K.)', total: 180, date: null },
    x: { document_type: 'handwritten_slip', category: 'Local conveyance', city: 'New Delhi', route_from: 'Karol Bagh', route_to: 'Connaught Place', legibility: 'fair', notes: 'Handwritten slip; no date written.' },
    conf: { vendor: 0.7, total_amount: 0.9, date: 0 } },

  { file: 'Screenshot_UPI_Payment.png', render: upiShot, d: {
      vendor: 'Sharma Tea & Snacks', upiId: 'sharmatea@okdemo', total: 250, dateText: '23 Sep 2026', date: '2026-09-23', time: '11:42 AM', invoiceNo: '626612894417', message: 'breakfast',
    }, x: { document_type: 'upi_screenshot', category: 'Meals', city: null, payment_mode: 'UPI' } },

  { file: 'QuickRide_23Sep_hotel_to_airport.jpg', render: (d) => cabApp(d, { rot: 1.5 }), d: {
      vendor: 'QuickRide', invoiceNo: 'QR-90477-DEL', dateText: '23 Sep 2026', date: '2026-09-23', time: '08:31 AM', total: 710,
      routeFrom: 'Hotel Saffron Residency, Karol Bagh', routeTo: 'IGI Airport T1, New Delhi', items: [['Trip fare', 655], ['Airport fee', 55]], payment: 'UPI', vendorGstin: g('07AAFCQ2211M1Z'),
    }, x: { document_type: 'app_receipt', category: 'Local conveyance', city: 'New Delhi' } },

  { file: 'QuickRide_Pune_29Sep.jpg', render: (d) => cabApp(d, { rot: -2 }), d: {
      vendor: 'QuickRide', invoiceNo: 'QR-10233-PNQ', dateText: '29 Sep 2026', date: '2026-09-29', time: '08:05 AM', total: 920,
      routeFrom: 'Pune Railway Station', routeTo: 'Chakan Plant, Gate 2', items: [['Trip fare', 920]], payment: 'Card', vendorGstin: g('27AAFCQ2211M1Z'),
    }, x: { document_type: 'app_receipt', category: 'Local conveyance', city: 'Pune' } },

  { file: 'lunch_vaishali_thali.jpg', render: (d) => thermal(d, { rot: 2 }), d: {
      vendor: 'Vaishali Thali House', address: ['Chakan MIDC, Pune 410501'], vendorGstin: g('27AAPFV3344H1Z'), invoiceNo: '7781', dateText: '29/09/2026', date: '2026-09-29', time: '13:40',
      items: [['Maharashtrian Thali', 480], ['Chaas', 80]], total: 560, payment: 'Cash',
    }, x: { document_type: 'receipt', category: 'Meals', city: 'Pune' } },

  { file: 'Dinner_GrillRoom_KP.png', render: (d) => thermal(d, { rot: 0, pad: 20, paper: '#ffffff', totalStyle: 'font-family="Segoe UI, Arial"' }), d: {
      vendor: 'The Grill Room', address: ['Lane 6, Koregaon Park', 'Pune 411001'], vendorGstin: g('27AAGFG5566R1Z'), invoiceNo: 'GR-3390', dateText: '29/09/2026', date: '2026-09-29', time: '21:15',
      items: [['Grilled Basa', 620], ['Virgin Mojito', 280], ['Caesar Salad', 400]], subtotal: 1300, tax: 65, total: 1865, payment: 'Card',
    }, x: { document_type: 'receipt', category: 'Meals', city: 'Pune',
      integrity_signals: ['Printed total ₹1,865 does not reconcile with items + GST (₹1,365)', 'The total line uses a different typeface from the rest of the receipt', 'Rendering is uniformly crisp with no thermal-print artefacts'] } },
];

// Build the pre-computed extraction (what Claude returns) from the sample's ground truth.
function sampleExtraction(s) {
  const d = s.d, x = s.x || {}, c = s.conf || {};
  const f = (value, conf) => ({ value: value ?? null, confidence: value == null ? 0 : conf });
  const alcohol = x.alcohol || [];
  return {
    is_receipt: true, document_type: x.document_type, category: x.category,
    vendor: f(d.vendor, c.vendor ?? 0.97), date: f(d.date, c.date ?? 0.96), total_amount: f(d.total, c.total_amount ?? 0.98), currency: f('INR', 0.99),
    tax_amount: f(d.tax, 0.95), subtotal: f(d.subtotal, 0.94),
    vendor_gstin: f(d.vendorGstin, 0.93), buyer_gstin: f('buyer_gstin' in x ? x.buyer_gstin : d.buyerGstin || null, 0.93), buyer_name: f(x.buyer_name ?? d.billToCompany ?? null, 0.9),
    invoice_number: f(d.invoiceNo, 0.95), city: f(x.city, 0.9), payment_mode: f(x.payment_mode || d.payment, 0.88),
    check_in: f(x.check_in, 0.95), check_out: f(x.check_out, 0.95), route_from: f(x.route_from || d.routeFrom, 0.9), route_to: f(x.route_to || d.routeTo, 0.9), travel_class: f(x.travel_class, 0.95),
    line_items: (d.items || []).filter(() => x.document_type !== 'e_ticket' && x.document_type !== 'app_receipt').map((i) => ({ description: i[0], amount: i[1], is_alcohol: alcohol.includes(i[0]) })),
    language: 'English', legibility: x.legibility || 'good', integrity_signals: x.integrity_signals || [], notes: x.notes || '',
  };
}

// Render one sample to a PNG Blob.
function renderSample(s) {
  const src = s.dupOf != null ? SAMPLES[s.dupOf] : s;
  const { svg, w, h } = s.render(src.d);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0);
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error('render failed'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Could not render sample ' + s.file));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

// Node (unit tests) only; needs POLICY and withGstinCheck on globalThis first (see tests/setup.js).
if (typeof module !== 'undefined' && module.exports) module.exports = { SAMPLES, sampleExtraction };

async function loadSampleFiles() {
  const out = [];
  for (const s of SAMPLES) {
    const blob = await renderSample(s);
    const file = new File([blob], s.file, { type: 'image/png' });
    file._sampleExtraction = sampleExtraction(s.dupOf != null ? SAMPLES[s.dupOf] : s);
    out.push(file);
  }
  return out;
}
