// Document reading with Claude vision → strict JSON with a confidence score per field.
// Requests go through the local server (/api/claude), which adds the API key.

const MODEL = 'claude-opus-5-5';

const EXTRACTION_SYSTEM = `You are the document-reading component of an employee reimbursement assistant used in India.
You receive exactly one document: a photo, scan, screenshot or PDF of a bill, invoice, ticket or payment confirmation.

Rules:
- Extract only what is visible. Never invent values. If a value is absent or unreadable, return value null with confidence 0.
- confidence (0-1) is how sure you are the value was read correctly. Handwritten, faded, cropped or blurry values get lower confidence.
- Dates: output YYYY-MM-DD. Indian documents usually write dates as DD/MM/YYYY.
- Amounts: plain numbers in the document's currency, no symbols or commas. currency is the ISO 4217 code (INR, USD, EUR...). total_amount is the final amount paid including taxes. tax_amount is the total GST (CGST+SGST+IGST) or other tax. subtotal is the pre-tax amount if printed.
- vendor_gstin is the seller's GSTIN. buyer_gstin is a GSTIN printed in the bill-to / customer / company section, if any. buyer_name is the billed party.
- For flights and trains, city is the destination city. For a UPI or wallet payment screenshot, vendor is the payee.
- line_items: the itemised rows as printed. Set is_alcohol true for alcoholic drinks (beer, wine, spirits, cocktails).
- category: the reimbursement category the expense belongs to.
- integrity_signals: concrete, observable signs that the document may be edited, fabricated or AI-generated. Examples: totals that don't reconcile, inconsistent fonts or alignment in key numbers, rendering too clean for the claimed print medium, impossible dates or GSTIN formats. Return an empty list when there are none. Don't speculate.
- is_receipt is false if the document is not evidence of an expense (a selfie, a menu, a random screenshot).
- notes: one short sentence on anything a reviewer should know (for example, several receipts in one photo, or part of the bill cut off).`;

const F = (t) => ({
  type: 'object', additionalProperties: false, required: ['value', 'confidence'],
  properties: { value: { anyOf: [{ type: t }, { type: 'null' }] }, confidence: { type: 'number' } },
});

const EXTRACTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    is_receipt: { type: 'boolean' },
    document_type: { type: 'string', enum: ['tax_invoice', 'receipt', 'e_ticket', 'app_receipt', 'upi_screenshot', 'handwritten_slip', 'other', 'not_a_receipt'] },
    category: { type: 'string', enum: ['Lodging', 'Airfare', 'Rail', 'Local conveyance', 'Meals', 'Fuel', 'Telecom', 'Other'] },
    vendor: F('string'), date: F('string'), total_amount: F('number'), currency: F('string'),
    tax_amount: F('number'), subtotal: F('number'),
    vendor_gstin: F('string'), buyer_gstin: F('string'), buyer_name: F('string'),
    invoice_number: F('string'), city: F('string'), payment_mode: F('string'),
    check_in: F('string'), check_out: F('string'), route_from: F('string'), route_to: F('string'), travel_class: F('string'),
    line_items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['description', 'amount', 'is_alcohol'],
        properties: { description: { type: 'string' }, amount: { anyOf: [{ type: 'number' }, { type: 'null' }] }, is_alcohol: { type: 'boolean' } },
      },
    },
    language: { type: 'string' },
    legibility: { type: 'string', enum: ['good', 'fair', 'poor'] },
    integrity_signals: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};
EXTRACTION_SCHEMA.required = Object.keys(EXTRACTION_SCHEMA.properties);

async function aiExtract(doc) {
  const media = doc.mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.base64 } }
    : { type: 'image', source: { type: 'base64', media_type: doc.mediaType, data: doc.base64 } };

  const body = {
    model: MODEL,
    max_tokens: 16000,
    fallbacks: 'default', // re-run server-side on a recommended model if a safety classifier declines
    system: EXTRACTION_SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
    messages: [{ role: 'user', content: [media, { type: 'text', text: `File name: ${doc.fileName}. Extract the reimbursement data.` }] }],
  };

  const res = await fetch('/api/claude', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `Claude request failed (${res.status})`);
  if (json.stop_reason === 'refusal') throw new Error('The model declined to read this document.');
  if (json.stop_reason === 'max_tokens') throw new Error('The response was cut off before it finished.');
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

// Node (unit tests) only; in the browser these stay plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MODEL, EXTRACTION_SYSTEM, EXTRACTION_SCHEMA, aiExtract };
}
