// The mock reimbursement system, in the browser. Used when there is no Java server (static hosting).
// Same contract as server/DropDoneServer.java: same claim validation, ids, statuses and transitions,
// and the same response shapes, so app.js treats both alike. Claims live in localStorage on this device.

const STORE_KEY = 'dropdone.claims.v1';
const STORE_SEQ_START = 1040;

// Claim lifecycle. DRAFT and READY exist only in the chat; anything not listed is refused (the server's 409).
const TRANSITIONS = { SUBMITTED: ['APPROVED', 'REJECTED'], APPROVED: ['PAID', 'REJECTED'], REJECTED: [], PAID: [] };
const canMove = (from, to) => (TRANSITIONS[from] || []).includes(to);

class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Same checks as DropDoneServer.validateClaim: the parts the approver inbox reads.
function validateClaim(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'claim must be a JSON object';
  if (!c.employee || typeof c.employee !== 'object') return 'claim.employee must be an object';
  if (!c.totals || typeof c.totals.claimable !== 'number') return 'claim.totals.claimable must be a number';
  if (!Array.isArray(c.trips)) return 'claim.trips must be an array';
  if (c.trips.some((t) => !t || !Array.isArray(t.lines))) return 'every trip must be an object with a lines array';
  return null;
}

// storage: anything with getItem/setItem (localStorage in the browser, a stub in tests).
function createClaimStore(storage, now = () => new Date()) {
  const load = () => {
    try { const d = JSON.parse(storage.getItem(STORE_KEY)); if (d && Array.isArray(d.claims)) return d; } catch { /* corrupt: start clean */ }
    return { seq: STORE_SEQ_START, claims: [] };
  };
  const save = (d) => storage.setItem(STORE_KEY, JSON.stringify(d));
  const copy = (x) => JSON.parse(JSON.stringify(x));

  return {
    list() { return copy(load().claims); },
    submit(claim) {
      const problem = validateClaim(claim);
      if (problem) throw new StoreError(400, problem);
      const d = load();
      d.seq++;
      const sc = { id: 'RCL-2026-' + String(d.seq).padStart(6, '0'), status: 'SUBMITTED', submittedAt: now().toISOString(), claim: copy(claim) };
      d.claims.push(sc);
      save(d);
      return copy(sc);
    },
    decide(id, decision) {
      if (!['APPROVED', 'REJECTED', 'PAID'].includes(decision)) throw new StoreError(400, 'decision must be APPROVED, REJECTED or PAID');
      const d = load();
      const sc = d.claims.find((c) => c.id === id);
      if (!sc) throw new StoreError(404, 'no claim ' + id);
      if (!canMove(sc.status, decision)) throw new StoreError(409, `cannot move a ${sc.status} claim to ${decision}`);
      sc.status = decision;
      save(d);
      return copy(sc);
    },
    clear() { save({ seq: load().seq, claims: [] }); },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { STORE_KEY, TRANSITIONS, canMove, validateClaim, createClaimStore, StoreError };
}
