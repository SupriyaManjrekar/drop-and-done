// Document reading with AI vision → strict JSON with a confidence score per field.
// With the Java server, requests go through /api/claude, which adds the API key.
// Without a server (static hosting), the browser calls Gemini directly with the user's own key.

const MODEL = 'claude-opus-5-5';
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

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

function extractionRequest(doc) {
  const media = doc.mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.base64 } }
    : { type: 'image', source: { type: 'base64', media_type: doc.mediaType, data: doc.base64 } };
  return {
    model: MODEL,
    max_tokens: 16000,
    fallbacks: 'default', // re-run server-side on a recommended model if a safety classifier declines
    system: EXTRACTION_SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
    messages: [{ role: 'user', content: [media, { type: 'text', text: `File name: ${doc.fileName}. Extract the reimbursement data.` }] }],
  };
}

// opts.geminiKey: read in the browser with the user's own key instead of the server proxy.
// opts.model and opts.wait (the rate-limit sleep) are for tests and overrides.
async function aiExtract(doc, opts = {}) {
  const body = extractionRequest(doc);
  const json = opts.geminiKey ? await geminiCall(body, opts.geminiKey, opts.model, opts.wait) : await proxyCall(body);
  if (json.stop_reason === 'refusal') throw new Error('The model declined to read this document.');
  if (json.stop_reason === 'max_tokens') throw new Error('The response was cut off before it finished.');
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

async function proxyCall(body) {
  const res = await fetch('/api/claude', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `AI request failed (${res.status})`);
  return json;
}

// ------------------------------------------------------------------ browser-direct Gemini
// Same translation as server/gemini_bridge.py: the request and answer keep the Messages shape,
// so aiExtract and everything after it are identical in both modes.
const GEMINI_UNSUPPORTED = new Set(['additionalProperties', 'minItems', 'maxItems', '$schema', 'strict']);

// Drop keywords Gemini rejects; anyOf [{type: t}, {type: null}] -> {type: t, nullable: true}.
function toGeminiSchema(o) {
  if (Array.isArray(o)) return o.map(toGeminiSchema);
  if (!o || typeof o !== 'object') return o;
  const anyOf = o.anyOf;
  if (anyOf && anyOf.some((x) => x.type === 'null')) {
    const rest = anyOf.filter((x) => x.type !== 'null');
    if (rest.length === 1) {
      const { anyOf: _, ...out } = o;
      return toGeminiSchema({ ...out, ...rest[0], nullable: true });
    }
  }
  return Object.fromEntries(Object.entries(o).filter(([k]) => !GEMINI_UNSUPPORTED.has(k)).map(([k, v]) => [k, toGeminiSchema(v)]));
}

function toGemini(req) {
  const parts = [];
  for (const msg of req.messages || []) {
    if (typeof msg.content === 'string') { parts.push({ text: msg.content }); continue; }
    for (const b of msg.content) {
      if (b.type === 'image' || b.type === 'document') parts.push({ inline_data: { mime_type: b.source.media_type, data: b.source.data } });
      else if (b.type === 'text') parts.push({ text: b.text });
    }
  }
  const body = { contents: [{ role: 'user', parts }] };
  const system = Array.isArray(req.system) ? req.system.map((b) => b.text || '').join('\n\n') : req.system;
  if (system) body.system_instruction = { parts: [{ text: system }] };
  const cfg = { temperature: 0, maxOutputTokens: Number(req.max_tokens) || 8192, thinkingConfig: { thinkingBudget: 512 } };
  const schema = req.output_config?.format?.schema;
  if (schema) { cfg.responseMimeType = 'application/json'; cfg.responseSchema = toGeminiSchema(schema); }
  body.generationConfig = cfg;
  return body;
}

function fromGemini(res) {
  const c = (res.candidates || [])[0];
  if (!c) return { content: [], stop_reason: 'refusal', stop_detail: res.promptFeedback?.blockReason || 'no answer' };
  const text = (c.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  const stop = { STOP: 'end_turn', MAX_TOKENS: 'max_tokens' }[c.finishReason || 'STOP'] || 'refusal';
  return { content: [{ type: 'text', text }], stop_reason: stop };
}

// Server errors (5xx) are retried twice. Rate limits (429, common on free keys) wait the delay the API
// asks for, up to a minute, three times. Other 4xx (bad key, no quota) fail at once with the API's message.
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
function retryDelayMs(json, attempt) {
  const d = (json.error?.details || []).find((x) => x.retryDelay)?.retryDelay;
  const s = d ? parseFloat(d) : 10 * (attempt + 1);
  return Math.min(60, Math.max(1, s)) * 1000;
}

async function geminiCall(req, key, model = GEMINI_MODEL, wait = sleepMs) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${GEMINI_BASE}${model}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(toGemini(req)),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) return fromGemini(json);
    if (res.status >= 500 && attempt < 2) continue;
    if (res.status === 429 && attempt < 3) { await wait(retryDelayMs(json, attempt)); continue; }
    throw new Error(`AI request failed (${res.status}): ${json.error?.message || res.statusText || 'no details'}`);
  }
}

// Cheap key check before the user drops bills: fetches the model's metadata, no tokens spent.
async function checkGeminiKey(key, model = GEMINI_MODEL) {
  const res = await fetch(`${GEMINI_BASE}${model}`, { headers: { 'x-goog-api-key': key } });
  if (res.ok) return true;
  const json = await res.json().catch(() => ({}));
  throw new Error(json.error?.message || `HTTP ${res.status}`);
}

// Node (unit tests) only; in the browser these stay plain globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MODEL, GEMINI_MODEL, EXTRACTION_SYSTEM, EXTRACTION_SCHEMA, aiExtract, toGeminiSchema, toGemini, fromGemini, checkGeminiKey };
}
