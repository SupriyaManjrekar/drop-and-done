// Server smoke test (plain Node, no test framework). Needs the server running:
//   03-prototype/run.bat   (or run.sh), then:   node tests/smoke.js
// Uses http://127.0.0.1:8787 by default; set SMOKE_URL or PORT to point elsewhere.
// Exits 0 with a SKIP message if the server is not up, 1 if any check fails.
// Note: claims are kept in memory, so this adds two test claims to the running server's inbox.
const http = require('node:http');
const assert = require('node:assert/strict');

const BASE = new URL(process.env.SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 8787}`);

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: BASE.hostname, port: BASE.port, path, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// The smallest claim the server accepts (same shape as engine.js buildSubmission).
const claim = (claimable) => ({
  policyVersion: 'TRV-EXP-2026.2', employee: { name: 'Smoke Test' }, generatedAt: new Date().toISOString(),
  totals: { billed: claimable, claimable, excluded: 0, gstEligible: 0, gstLost: 0 }, metrics: {},
  trips: [{ name: 'Local expenses', from: '2026-09-20', to: '2026-09-20', claimable, lines: [] }],
});
const decide = (id, decision) => request('POST', `/api/claims/${id}/decision`, { decision });

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
let a, b;

check('GET /api/config reports whether live AI is enabled', async () => {
  const r = await request('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.aiEnabled, 'boolean');
});
check('GET / redirects to the app', async () => {
  const r = await request('GET', '/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/03-prototype/app/');
});
check('the app and policy script are served', async () => {
  assert.equal((await request('GET', '/03-prototype/app/')).status, 200);
  const r = await request('GET', '/03-prototype/app/policy.js');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /javascript/);
});
check('path traversal outside the served folder is refused', async () => {
  const r = await request('GET', '/..%2F..%2Fwindows%2Fwin.ini');
  assert.ok([403, 404].includes(r.status), `got ${r.status}`);
});
check('POST /api/claims rejects malformed JSON', async () => {
  const r = await request('POST', '/api/claims', '{"trips": [}');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not valid JSON/);
});
check('POST /api/claims rejects a non-object and a claim without trips', async () => {
  assert.equal((await request('POST', '/api/claims', '[1,2]')).status, 400);
  const { trips, ...noTrips } = claim(100);
  const r = await request('POST', '/api/claims', noTrips);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /trips/);
});
check('POST /api/claims stores a claim as SUBMITTED', async () => {
  const r = await request('POST', '/api/claims', claim(1234));
  assert.equal(r.status, 201);
  assert.match(r.json.id, /^RCL-2026-\d{6}$/);
  assert.equal(r.json.status, 'SUBMITTED');
  a = r.json.id;
  b = (await request('POST', '/api/claims', claim(99))).json.id;
});
check('GET /api/claims returns the stored claim', async () => {
  const r = await request('GET', '/api/claims');
  assert.equal(r.status, 200);
  const mine = r.json.find((c) => c.id === a);
  assert.equal(mine.claim.totals.claimable, 1234);
  assert.equal(mine.claim.employee.name, 'Smoke Test');
});
check('decision: unknown claim is 404, a bad body is 400', async () => {
  assert.equal((await decide('RCL-2026-999999', 'APPROVED')).status, 404);
  assert.equal((await request('POST', `/api/claims/${a}/decision`, 'APPROVED please')).status, 400);
  assert.equal((await decide(a, 'approved')).status, 400);
});
check('decision: SUBMITTED cannot jump to PAID (409)', async () => {
  const r = await decide(a, 'PAID');
  assert.equal(r.status, 409);
  assert.equal(r.json.status, 'SUBMITTED');
});
check('decision: SUBMITTED -> APPROVED -> PAID, then PAID is final', async () => {
  assert.equal((await decide(a, 'APPROVED')).json.status, 'APPROVED');
  assert.equal((await decide(a, 'APPROVED')).status, 409);
  assert.equal((await decide(a, 'PAID')).json.status, 'PAID');
  assert.equal((await decide(a, 'REJECTED')).status, 409);
});
check('decision: SUBMITTED -> REJECTED, then REJECTED is final', async () => {
  assert.equal((await decide(b, 'REJECTED')).json.status, 'REJECTED');
  assert.equal((await decide(b, 'APPROVED')).status, 409);
});
check('POST /api/claude without a key returns 503 (skipped when a key is set)', async () => {
  const cfg = await request('GET', '/api/config');
  if (cfg.json.aiEnabled) return 'skipped: live mode';
  const r = await request('POST', '/api/claude', {});
  assert.equal(r.status, 503);
  assert.equal(r.json.error.type, 'no_api_key');
});

(async () => {
  try {
    await request('GET', '/api/config');
  } catch (e) {
    console.log(`SKIP: no server at ${BASE.origin} (${e.code || e.message}). Start it with 03-prototype/run.bat or run.sh, then re-run.`);
    return;
  }
  let failed = 0;
  for (const c of checks) {
    try {
      const note = await c.fn();
      console.log(`ok   ${c.name}${note ? ` (${note})` : ''}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${c.name}\n     ${e.message.split('\n').join('\n     ')}`);
    }
  }
  console.log(`\n${checks.length - failed} of ${checks.length} smoke checks passed against ${BASE.origin}`);
  process.exitCode = failed ? 1 : 0;
})();
