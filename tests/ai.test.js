// Unit tests for ai.js: the request it builds, its error handling (fetch is stubbed, no network),
// and the extraction JSON schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ai, extraction, sampleDocs } = require('./setup');

const { aiExtract, EXTRACTION_SCHEMA, MODEL } = ai;
const realFetch = globalThis.fetch;

// Replace fetch with a stub that records the request and returns the given status and JSON body.
function stubFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => { if (body === undefined) throw new SyntaxError('no body'); return body; },
    };
  };
  return calls;
}
const reply = (obj, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'text', text: JSON.stringify(obj) }] });
const png = { fileName: 'bill.png', mediaType: 'image/png', base64: 'AAAA' };

test.afterEach(() => { globalThis.fetch = realFetch; });

test('aiExtract: posts to the local proxy with the model, schema and an image block', async () => {
  const calls = stubFetch(200, reply({ vendor: { value: 'X', confidence: 0.9 } }));
  const out = await aiExtract(png);
  assert.deepEqual(out, { vendor: { value: 'X', confidence: 0.9 } });
  assert.equal(calls.length, 1);
  const { url, init, body } = calls[0];
  assert.equal(url, '/api/claude');
  assert.equal(init.method, 'POST');
  assert.equal(body.model, MODEL);
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(body.output_config.format.schema, EXTRACTION_SCHEMA);
  const [media, text] = body.messages[0].content;
  assert.deepEqual(media, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.match(text.text, /bill\.png/);
  assert.ok(!('x-api-key' in (init.headers || {})), 'the browser never sends a key');
});

test('aiExtract: a PDF is sent as a document block', async () => {
  const calls = stubFetch(200, reply({}));
  await aiExtract({ fileName: 'inv.pdf', mediaType: 'application/pdf', base64: 'JVBE' });
  assert.deepEqual(calls[0].body.messages[0].content[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } });
});

test('aiExtract: joins several text blocks and ignores non-text blocks', async () => {
  stubFetch(200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] });
  assert.deepEqual(await aiExtract(png), { a: 1 });
});

test('aiExtract: a refusal stop reason throws a readable error', async () => {
  stubFetch(200, reply({}, 'refusal'));
  await assert.rejects(aiExtract(png), /declined to read this document/);
});

test('aiExtract: a max_tokens stop reason throws (truncated JSON is never parsed)', async () => {
  stubFetch(200, reply({}, 'max_tokens'));
  await assert.rejects(aiExtract(png), /cut off/);
});

test('aiExtract: an HTTP error surfaces the server error message', async () => {
  stubFetch(503, { error: { type: 'no_api_key', message: 'ANTHROPIC_API_KEY is not set on the server' } });
  await assert.rejects(aiExtract(png), /ANTHROPIC_API_KEY is not set/);
});

test('aiExtract: an HTTP error without a JSON body reports the status code', async () => {
  stubFetch(502, undefined);
  await assert.rejects(aiExtract(png), /Claude request failed \(502\)/);
});

test('aiExtract: invalid JSON text from the model throws', async () => {
  stubFetch(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] });
  await assert.rejects(aiExtract(png), SyntaxError);
});

// ------------------------------------------------------------------ schema
// Strict structured output needs every property required and no extra properties, at every level.
function walkObjects(schema, at, visit) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') visit(schema, at);
  for (const [k, v] of Object.entries(schema.properties || {})) walkObjects(v, `${at}.${k}`, visit);
  if (schema.items) walkObjects(schema.items, `${at}[]`, visit);
  for (const alt of schema.anyOf || []) walkObjects(alt, at, visit);
}

test('schema: every object lists all its properties as required and sets additionalProperties:false', () => {
  let n = 0;
  walkObjects(EXTRACTION_SCHEMA, '$', (o, at) => {
    n++;
    assert.equal(o.additionalProperties, false, `${at} additionalProperties`);
    assert.deepEqual([...o.required].sort(), Object.keys(o.properties).sort(), `${at} required`);
  });
  assert.ok(n >= 19, `expected the root, the line item and the field objects, saw ${n}`);
});

test('schema: every extracted field is a {value, confidence} pair whose value may be null', () => {
  const fields = Object.entries(EXTRACTION_SCHEMA.properties).filter(([, s]) => s.properties && 'confidence' in s.properties);
  assert.ok(fields.length >= 17);
  for (const [k, s] of fields) {
    assert.equal(s.properties.confidence.type, 'number', k);
    assert.ok(s.properties.value.anyOf.some((t) => t.type === 'null'), `${k} must allow null`);
  }
});

// Tiny validator for the subset of JSON Schema used in ai.js.
function conforms(v, s, at = '$') {
  if (s.anyOf) { if (!s.anyOf.some((alt) => { try { conforms(v, alt, at); return true; } catch { return false; } })) throw new Error(`${at}: no anyOf branch matches`); return; }
  const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  if (type !== s.type) throw new Error(`${at}: expected ${s.type}, got ${type}`);
  if (s.enum && !s.enum.includes(v)) throw new Error(`${at}: ${v} is not one of ${s.enum.join(', ')}`);
  if (s.type === 'array') v.forEach((x, i) => conforms(x, s.items, `${at}[${i}]`));
  if (s.type === 'object') {
    for (const k of s.required || []) if (!(k in v)) throw new Error(`${at}.${k} is missing`);
    for (const k of Object.keys(v)) {
      if (!s.properties[k]) throw new Error(`${at}.${k} is not in the schema`);
      conforms(v[k], s.properties[k], `${at}.${k}`);
    }
  }
}

test('schema: the 12 pre-computed sample extractions conform to the schema', () => {
  const docs = sampleDocs();
  assert.equal(docs.length, 12);
  for (const d of docs) assert.doesNotThrow(() => conforms(d.extraction, EXTRACTION_SCHEMA), d.fileName);
});

test('schema: the test fixture builder produces schema-valid extractions', () => {
  assert.doesNotThrow(() => conforms(extraction({ vendor: 'X', total_amount: 10, line_items: [['Tea', 10]] }), EXTRACTION_SCHEMA));
  assert.throws(() => conforms({ ...extraction(), surprise: 1 }, EXTRACTION_SCHEMA), /not in the schema/);
});
