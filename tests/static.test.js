// Serverless mode (static hosting): the browser-direct Gemini adapter in ai.js and the in-browser
// claim store in store.js. fetch and storage are stubbed; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ai, APP } = require('./setup');
const { createClaimStore, validateClaim, canMove, STORE_KEY } = require(path.join(APP, 'store.js'));

const { aiExtract, toGeminiSchema, toGemini, fromGemini, checkGeminiKey, EXTRACTION_SCHEMA, EXTRACTION_SYSTEM, GEMINI_MODEL } = ai;
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

// Stub that answers each call with the next [status, body] pair and records the requests.
function stubFetch(...answers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const [status, body] = answers[Math.min(calls.length, answers.length) - 1];
    return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => { if (body === undefined) throw new SyntaxError('no body'); return body; } };
  };
  return calls;
}
const gemini = (obj, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text: '…', thought: true }, { text: JSON.stringify(obj) }] } }] });
const png = { fileName: 'bill.png', mediaType: 'image/png', base64: 'AAAA' };

// ------------------------------------------------------------------ schema and request translation
test('toGeminiSchema: nullable anyOf becomes nullable, unsupported keywords are dropped', () => {
  const out = toGeminiSchema({ type: 'object', additionalProperties: false, required: ['v'], properties: { v: { anyOf: [{ type: 'number' }, { type: 'null' }] } } });
  assert.deepEqual(out, { type: 'object', required: ['v'], properties: { v: { type: 'number', nullable: true } } });
});

test('toGeminiSchema: the extraction schema has no anyOf or additionalProperties left', () => {
  const s = JSON.stringify(toGeminiSchema(EXTRACTION_SCHEMA));
  assert.ok(!s.includes('anyOf') && !s.includes('additionalProperties'));
  assert.equal(toGeminiSchema(EXTRACTION_SCHEMA).properties.vendor.properties.value.nullable, true);
});

test('toGeminiSchema: an anyOf with two non-null types is kept as it is', () => {
  const o = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] };
  assert.deepEqual(toGeminiSchema(o), o);
});

test('toGemini: image, PDF and text blocks, system instruction, JSON schema output', () => {
  const body = toGemini({
    max_tokens: 16000, system: [{ text: 'a' }, { text: 'b' }], output_config: { format: { schema: { type: 'object', additionalProperties: false } } },
    messages: [{ role: 'user', content: [{ type: 'image', source: { media_type: 'image/png', data: 'AAAA' } }, { type: 'document', source: { media_type: 'application/pdf', data: 'JVBE' } }, { type: 'text', text: 'hi' }] }, { role: 'user', content: 'plain' }],
  });
  assert.deepEqual(body.contents[0].parts, [{ inline_data: { mime_type: 'image/png', data: 'AAAA' } }, { inline_data: { mime_type: 'application/pdf', data: 'JVBE' } }, { text: 'hi' }, { text: 'plain' }]);
  assert.equal(body.system_instruction.parts[0].text, 'a\n\nb');
  assert.equal(body.generationConfig.maxOutputTokens, 16000);
  assert.equal(body.generationConfig.temperature, 0);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema, { type: 'object' });
});

test('toGemini: no system and no schema means neither is sent; max_tokens defaults', () => {
  const body = toGemini({ messages: [] });
  assert.ok(!('system_instruction' in body) && !('responseSchema' in body.generationConfig));
  assert.equal(body.generationConfig.maxOutputTokens, 8192);
});

test('fromGemini: maps finish reasons and drops thought parts', () => {
  assert.deepEqual(fromGemini(gemini({ a: 1 })), { content: [{ type: 'text', text: '{"a":1}' }], stop_reason: 'end_turn' });
  assert.equal(fromGemini(gemini({}, 'MAX_TOKENS')).stop_reason, 'max_tokens');
  assert.equal(fromGemini(gemini({}, 'SAFETY')).stop_reason, 'refusal');
  assert.equal(fromGemini({ promptFeedback: { blockReason: 'OTHER' } }).stop_reason, 'refusal');
  assert.equal(fromGemini({ candidates: [{}] }).content[0].text, '');
});

// ------------------------------------------------------------------ aiExtract with the user's key
test('aiExtract with a key: calls Gemini directly with the key in a header, never in the URL', async () => {
  const calls = stubFetch([200, gemini({ vendor: { value: 'X', confidence: 0.9 } })]);
  const out = await aiExtract(png, { geminiKey: 'k-123' });
  assert.deepEqual(out, { vendor: { value: 'X', confidence: 0.9 } });
  const { url, init, body } = calls[0];
  assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`);
  assert.ok(!url.includes('k-123'));
  assert.equal(init.headers['x-goog-api-key'], 'k-123');
  assert.equal(body.system_instruction.parts[0].text, EXTRACTION_SYSTEM);
  assert.deepEqual(body.contents[0].parts[0], { inline_data: { mime_type: 'image/png', data: 'AAAA' } });
  assert.match(body.contents[0].parts[1].text, /bill\.png/);
});

test('aiExtract with a key: a model override changes the URL', async () => {
  const calls = stubFetch([200, gemini({})]);
  await aiExtract(png, { geminiKey: 'k', model: 'other-model' });
  assert.match(calls[0].url, /models\/other-model:generateContent$/);
});

test('aiExtract with a key: 5xx is retried, then succeeds', async () => {
  const calls = stubFetch([503, { error: { message: 'busy' } }], [200, gemini({ a: 1 })]);
  assert.deepEqual(await aiExtract(png, { geminiKey: 'k' }), { a: 1 });
  assert.equal(calls.length, 2);
});

test('aiExtract with a key: 5xx three times fails with the API message', async () => {
  const calls = stubFetch([500, { error: { message: 'internal' } }]);
  await assert.rejects(aiExtract(png, { geminiKey: 'k' }), /AI request failed \(500\): internal/);
  assert.equal(calls.length, 3);
});

test('aiExtract with a key: 429 waits the delay the API asks for, then succeeds', async () => {
  const waits = [];
  const calls = stubFetch([429, { error: { message: 'quota', details: [{ '@type': 'RetryInfo', retryDelay: '27s' }] } }], [429, {}], [200, gemini({ a: 1 })]);
  assert.deepEqual(await aiExtract(png, { geminiKey: 'k', wait: async (ms) => waits.push(ms) }), { a: 1 });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [27000, 20000]);
});

test('aiExtract with a key: 429 waits are capped at a minute and give up after three', async () => {
  const waits = [];
  const calls = stubFetch([429, { error: { message: 'Resource exhausted', details: [{ retryDelay: '300s' }] } }]);
  await assert.rejects(aiExtract(png, { geminiKey: 'k', wait: async (ms) => waits.push(ms) }), /AI request failed \(429\): Resource exhausted/);
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [60000, 60000, 60000]);
});

test('aiExtract with a key: a 4xx (bad key, quota) fails at once', async () => {
  const calls = stubFetch([400, { error: { message: 'API key not valid' } }]);
  await assert.rejects(aiExtract(png, { geminiKey: 'bad' }), /API key not valid/);
  assert.equal(calls.length, 1);
});

test('aiExtract with a key: an error without a JSON body still reports the status', async () => {
  stubFetch([403, undefined]);
  await assert.rejects(aiExtract(png, { geminiKey: 'k' }), /AI request failed \(403\): no details/);
});

test('aiExtract with a key: safety block and truncation become readable errors', async () => {
  stubFetch([200, gemini({}, 'SAFETY')]);
  await assert.rejects(aiExtract(png, { geminiKey: 'k' }), /declined/);
  stubFetch([200, gemini({}, 'MAX_TOKENS')]);
  await assert.rejects(aiExtract(png, { geminiKey: 'k' }), /cut off/);
});

test('checkGeminiKey: ok on 200, the API message otherwise', async () => {
  let calls = stubFetch([200, { name: 'models/x' }]);
  assert.equal(await checkGeminiKey('k'), true);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'k');
  assert.match(calls[0].url, new RegExp(`models/${GEMINI_MODEL}$`));
  stubFetch([400, { error: { message: 'API key not valid' } }]);
  await assert.rejects(checkGeminiKey('bad'), /API key not valid/);
  stubFetch([403, undefined]);
  await assert.rejects(checkGeminiKey('bad'), /HTTP 403/);
});

// ------------------------------------------------------------------ claim store (mock reimbursement system)
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}
const claim = (claimable = 100) => ({ employee: { name: 'A' }, totals: { claimable }, trips: [{ lines: [{ txnKey: 'k1', status: 'COMPLETE' }] }] });
const fixedNow = () => new Date('2026-09-30T10:00:00Z');

test('store: submit assigns RCL ids in sequence, SUBMITTED, and the server response shape', () => {
  const s = createClaimStore(memStorage(), fixedNow);
  const a = s.submit(claim()), b = s.submit(claim(200));
  assert.equal(a.id, 'RCL-2026-001041');
  assert.equal(b.id, 'RCL-2026-001042');
  assert.deepEqual(Object.keys(a), ['id', 'status', 'submittedAt', 'claim']);
  assert.equal(a.status, 'SUBMITTED');
  assert.equal(a.submittedAt, '2026-09-30T10:00:00.000Z');
  assert.deepEqual(s.list().map((c) => c.id), [a.id, b.id]);
});

test('store: claims survive a reload (a new store on the same storage)', () => {
  const st = memStorage();
  const id = createClaimStore(st).submit(claim()).id;
  const s2 = createClaimStore(st);
  assert.equal(s2.list()[0].id, id);
  assert.equal(s2.submit(claim()).id, 'RCL-2026-001042');
  assert.ok(st.m.has(STORE_KEY));
});

test('store: returned claims are copies; editing them does not change the store', () => {
  const s = createClaimStore(memStorage());
  const a = s.submit(claim());
  a.status = 'PAID'; s.list()[0].claim.totals.claimable = 0;
  assert.equal(s.list()[0].status, 'SUBMITTED');
  assert.equal(s.list()[0].claim.totals.claimable, 100);
});

test('store: decisions follow the server transitions; anything else is a 409', () => {
  const s = createClaimStore(memStorage());
  const { id } = s.submit(claim());
  assert.throws(() => s.decide(id, 'PAID'), (e) => e.status === 409 && /SUBMITTED claim to PAID/.test(e.message));
  assert.equal(s.decide(id, 'APPROVED').status, 'APPROVED');
  assert.equal(s.decide(id, 'PAID').status, 'PAID');
  assert.throws(() => s.decide(id, 'REJECTED'), (e) => e.status === 409);
  const r = s.submit(claim()).id;
  assert.equal(s.decide(r, 'REJECTED').status, 'REJECTED');
  assert.throws(() => s.decide(r, 'APPROVED'), (e) => e.status === 409);
  const ar = s.submit(claim()).id;
  s.decide(ar, 'APPROVED');
  assert.equal(s.decide(ar, 'REJECTED').status, 'REJECTED');
});

test('store: unknown decision is 400, unknown claim is 404', () => {
  const s = createClaimStore(memStorage());
  const { id } = s.submit(claim());
  assert.throws(() => s.decide(id, 'MAYBE'), (e) => e.status === 400);
  assert.throws(() => s.decide('RCL-2026-999999', 'APPROVED'), (e) => e.status === 404);
});

test('store: validation matches the server (400 with the same reasons)', () => {
  const s = createClaimStore(memStorage());
  for (const [bad, why] of [
    [null, /JSON object/], [[], /JSON object/], [{}, /employee/], [{ employee: {} }, /claimable/],
    [{ employee: {}, totals: { claimable: '1' } }, /claimable/], [{ employee: {}, totals: { claimable: 1 } }, /trips/],
    [{ employee: {}, totals: { claimable: 1 }, trips: [{}] }, /lines array/],
  ]) assert.throws(() => s.submit(bad), (e) => e.status === 400 && why.test(e.message));
  assert.equal(validateClaim(claim()), null);
  assert.equal(s.list().length, 0);
});

test('store: corrupt storage starts clean; clear keeps the id sequence', () => {
  const st = memStorage();
  st.setItem(STORE_KEY, '{not json');
  const s = createClaimStore(st);
  assert.deepEqual(s.list(), []);
  s.submit(claim());
  s.clear();
  assert.deepEqual(s.list(), []);
  assert.equal(s.submit(claim()).id, 'RCL-2026-001042');
});

test('canMove: the lifecycle table', () => {
  assert.ok(canMove('SUBMITTED', 'APPROVED') && canMove('APPROVED', 'PAID') && canMove('APPROVED', 'REJECTED'));
  assert.ok(!canMove('PAID', 'REJECTED') && !canMove('DRAFT', 'SUBMITTED') && !canMove('nope', 'PAID'));
});
