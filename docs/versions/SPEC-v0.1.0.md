# Drop & Done: Product and Technical Specification

AI Innovation Lab Season 2, Round 2 submission. Deadline: **12 Oct 2026**.
Items marked **[TBD]** need a decision from the team.

| | |
|---|---|
| **Version** | 0.1.0 (draft) |
| **Date** | 2026-10-10 |
| **Status** | Draft, awaiting answers to the open questions in section 13 |

### Versioning
- `docs/SPEC.md` is always the **current** version.
- Each released version is frozen as a snapshot in `docs/versions/SPEC-vX.Y.Z.md`. Never edit a snapshot.
- To iterate: edit `SPEC.md`, bump the version above, add a row to the change log, and copy the file to `docs/versions/SPEC-v<new version>.md`.
- Bump rules: patch (0.1.1) for wording or fixes; minor (0.2.0) for added or changed requirements; major (1.0.0) once the team signs it off as the baseline for the build.

### Change log
| Version | Date | Changes |
|---|---|---|
| 0.1.0 | 2026-10-10 | First draft: requirements, architecture, policy rules, AI design, test strategy, research-derived ideas, two-day plan. |

---

## 1. Overview

**Drop & Done** is an AI-native reimbursement assistant. An employee drops a pile of messy bills (photos, PDFs, screenshots, e-tickets). The assistant reads each one, groups them into trips, checks them against company policy, asks at most three questions, and produces a submission-ready claim. An approver sees an AI-written summary that lists only what needs attention.

- **Track / business case:** **[TBD]** the business case assigned in the Round 2 brief (expected: employee expense reimbursement). Name it in the first paragraph of the design document, because the email requires "a clear project overview including the track selected".
- **Headline claim:** pile of bills to a ready claim in about 35 seconds, instead of the usual hours of manual entry, with fewer policy rejections.

### 1.1 Problem
- Employees lose time keying in bills and later find that claims are rejected for policy reasons.
- Finance reviews every line by hand and still misses duplicates, doctored bills and lost GST credit.
- GST input credit is lost silently when the company GSTIN is missing from the invoice.

### 1.2 Users
| User | Need |
|---|---|
| Employee | Turn a folder of bills into a correct claim with minimal effort. |
| Approver / manager | See only the exceptions, with the policy clause and evidence for each. |
| Finance | Trust the data: no duplicates, GST status known, tamper signals surfaced. |

### 1.3 Success metrics (shown in the demo)
- Time from first drop to READY claim (target under 60 s on the sample pack).
- Questions asked per claim (target 3 or fewer; policy `maxQuestions = 3`).
- Defects caught on the sample pack: 1 duplicate, 1 doctored bill, ₹900 alcohol removed, ₹1,392 GST credit flagged.
- Approver reading time: one summary paragraph instead of 12 documents.

### 1.4 Non-goals (stated in the doc so judges see them as decisions)
Real HRMS/SSO integration, real payments, multi-language UI, HEIC conversion, persistent storage. See section 11 for the production path.

---

## 2. System architecture

```
Browser (static SPA)                         Local Java server (127.0.0.1:8787)
  app.js  chat flow, claim card, evidence      DropDoneServer.java
  ai.js   prompt + JSON schema  ---POST--->      /api/claude   -> Anthropic Messages API (API key stays here)
  engine.js  evaluate(), planQuestions()         /api/claims   -> in-memory claim store
  policy.js  POLICY + GSTIN checksum             /api/claims/{id}/decision -> approve / reject / paid
  samples.js 12 fictional bills                  static hosting (app, pitch deck)
```

Design principles:
1. **AI reads, rules decide.** The model only extracts fields, confidences and integrity signals. Every policy outcome comes from deterministic code in `engine.js`, so it is explainable and testable.
2. **Evaluation is a pure function** of `(lines, answers, context)`. Each user answer re-runs `evaluate()`; there is no hidden state.
3. **The key never reaches the browser.** The server proxies Claude calls and binds to localhost only.
4. **Two modes.** Demo mode replays pre-computed extractions for the sample pack so the demo is reliable offline. Live mode sends every file to Claude vision.

Deliverable: `01-architecture/architecture-diagram.svg` plus a sequence diagram (Drop > Extract > Evaluate > Ask > Submit > Approve > Pay). **[TODO]** add the sequence diagram.

---

## 3. Functional requirements

### 3.1 Ingestion
- FR-1 Accept JPG/PNG/PDF by drag-and-drop or file picker. Compute a SHA-256 per file.
- FR-2 "Try the sample pack" loads 12 fictional bills rendered in the browser.
- FR-3 Extraction runs per file with visible progress; a failed file shows an error and does not block the rest.

### 3.2 Extraction (AI)
- FR-4 Output strict JSON from a schema: for each field a `{value, confidence}` pair, plus `document_type`, `category`, `line_items[]` (with `is_alcohol`), `legibility`, `integrity_signals[]`, `notes`.
- FR-5 Fields with no visible value return `null` with confidence 0 (never invented).
- FR-6 Handle refusal and truncation stop reasons explicitly; surface a readable error.

### 3.3 Claim intelligence (`engine.js`)
- FR-7 **Line building:** convert currency to INR using `POLICY.fxToInr`; normalise city names.
- FR-8 **Auto-fill rule:** a field is used automatically only if confidence is at least `autoFillConfidence` (0.7); otherwise it becomes a question.
- FR-9 **Duplicates, three levels:** exact file hash; same transaction key (`vendor|amount|date`) from a different photo; same key in a previously submitted claim.
- FR-10 **Validation:** arithmetic reconciliation (items + tax vs printed total, tolerance max(₹2, 1%)), future dates, stale dates, GSTIN checksum, integrity signals.
- FR-11 **Policy checks:** the rule table in section 5.
- FR-12 **Grouping:** lines are grouped into trips by date gap (more than 1 day starts a new group) and city change; hotel checkout extends the trip.
- FR-13 **Line states:** `COMPLETE`, `NEEDS_INFO` (blocks submit), `QUESTIONABLE` (submittable, routed to finance), `EXCLUDED`.
- FR-14 **Question planner:** convert blocking flags into tap-to-answer questions, largest amounts first, at most 3 (`maxQuestions`).
- FR-15 **Claim lifecycle:** `DRAFT > READY > SUBMITTED > APPROVED > PAID`.

### 3.4 Evidence view
- FR-16 Clicking a line shows the bill image, each extracted field with its confidence, and every check with its policy clause.

### 3.5 Approver inbox
- FR-17 Copilot summary: total, per-trip amounts, only the risky lines with reasons, what the assistant already adjusted, what was left out, GST credit lost, overall risk (Low / Medium / High).
- FR-18 Actions: approve, reject, mark paid. The employee chat is notified at each step.
- FR-19 **[Planned]** third action "request clarification", sending a question back to the employee (idea from the research, section 8).

---

## 4. Data model

**Extraction field:** `{ value: string|number|null, confidence: 0..1 }`

**Line (computed):** `id, fileName, hash, docType, vendor, date, city, currency, total, tax, subtotal, vendorGstin, buyerGstin, items[], integritySignals[], conf{...}, answers{}`, plus evaluated `category, effDate, billed, claimable, status, flags[], groupId, txnKey, dupOf, gst{amount, eligible}`.

**Flag:** `{ level: info|good|warn|risk|block, code, text, clause }`

**Submission payload:** `policyVersion, employee, company, generatedAt, totals{billed, claimable, excluded, gstEligible, gstLost}, metrics, trips[{name, from, to, claimable, lines[]}]`.

**Policy object (`POLICY`):** version, company GSTIN, employee profile, caps, allowed flight class, metro city list, submission window, thresholds, FX table, clause texts.

---

## 5. Policy rules (policy version `TRV-EXP-2026.2`)

| Code | Rule | Outcome | Clause |
|---|---|---|---|
| `duplicate` | Same file, same transaction, or already claimed | Excluded (risk) | §9.1 |
| `hotel_cap` | Room rate excl. GST above ₹7,000 (metro) / ₹5,000 (other) per night | Questionable | §4.2 |
| `meal_over_cap` | Solo meal above ₹1,500 | Blocks, asks "client meal?" | §5.1 |
| `meal_capped` | Capped at heads × cap after the answer | Claimable reduced | §5.1 / §5.3 |
| `attendees_missing` | Client entertainment needs attendee names (₹2,000 per head) | Blocks | §5.3 |
| `alcohol` | Alcohol line items removed | Claimable reduced | §5.4 |
| `cab_cap` | Ride above ₹1,500 | Warning | §6.1 |
| `noinv_ok/over` | UPI or handwritten proof accepted up to ₹500 | Info / questionable | §7.2 |
| `stale` | Older than 60 days | Warning (needs manager sign-off) | §2.3 |
| `flight_class` | Non-economy | Questionable | §3.1 |
| `gst_lost` / `itc_ok` | Company GSTIN absent / present on hotel or air invoice | Warn / good | §8.1 |
| `gstin_invalid` | Vendor GSTIN fails mod-36 checksum | Questionable | n/a |
| `arith_mismatch` | Items + tax differ from printed total | Blocks, asks which to use | n/a |
| `integrity` | Vision model reports tamper signals | Questionable | n/a |
| `future_date` | Date after today | Questionable | n/a |

---

## 6. AI design

- **Model:** `claude-opus-5-5` with vision; PDFs sent as `document` blocks. Strict `json_schema` output; `effort: medium`.
- **Fallbacks:** request sets `fallbacks: "default"` so a safety-classifier decline is re-run on a recommended model.
- **Prompt rules:** extract only what is visible, calibrated confidence (low for faded, handwritten or cropped values), DD/MM/YYYY handling, GSTIN roles, alcohol flag, concrete observable integrity signals only.
- **Routing by confidence (existing + planned):**
  - confidence at least 0.7: auto-fill
  - below 0.7 or null: becomes a question or a flag
  - integrity signals or validation failure: route to finance (`QUESTIONABLE`)
  - not a receipt: excluded
- **Why this is not "just OCR":** vision reads handwritten, WhatsApp and UPI documents; the model produces integrity signals; deterministic rules then decide. Open-source receipt-fraud tools found in research use classic forensics (ELA, noise residuals) and are trained on older data; none handles AI-generated receipts, so vision-based signals are a differentiator.

---

## 7. Server API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/claude` | POST | Proxy to Anthropic Messages API; adds the key; Windows trust store and proxy aware |
| `/api/claims` | POST / GET | Submit a claim; list claims for the approver inbox |
| `/api/claims/{id}/decision` | POST | `approve`, `reject`, `paid` (and planned `clarify`) |

State is in memory (prototype limit).

---

## 8. Ideas taken from open-source research

Findings come from search results only; repos were not opened or licence-checked. Treat as leads, and cite them as "inspired by" in the design doc, not as dependencies.

| Idea | Source (GitHub) | Planned change | Priority |
|---|---|---|---|
| AI drafts, rules decide, human approves | saksham20240/AgenticAI_Expense_Auditor, SuperGitlab/ai-expense-auditor | Already our design; state it explicitly in the doc | doc only |
| Three-way routing: auto / review / reject on confidence + validation | Antheagao/doc-pilot, shreyanchouhan/document-automation-agent, yudhveer10/document-intelligence-agent | Add explicit routing badge per line | P2 |
| Field-level low-confidence review | Antheagao/doc-pilot | In the evidence view, highlight fields under 0.7 with an inline edit | P2 |
| "Request clarification" action; tamper-evident audit log | joshidhruv951-spec/expense-policy-review-assistant | Add `clarify` decision; hash-chain the decision log | P2 |
| Cite the policy clause per decision | HarshitaaSachdev/expense-review-assistant | Already done (`clause`); demo it | doc only |
| Duplicate: exact hash, then fuzzy vendor/amount/date within ±1 day | Hamzo069 issue #12 | Change txnKey match to allow ±1 day; add perceptual hash later | P1 |
| Perceptual hash for re-photographed bills | idealo/imagededup, KilianB/JImageHash | Out of scope for the prototype; list in "next steps" | later |
| Policy as declarative data, validated at load | open-policy-agent/opa, Policy-Driven-Approval-Agent repos | Add a `validatePolicy()` check and tests; keep `POLICY` as data | P1 |
| GSTIN offline mod-36 checksum | tk120404/gst, rahulgurujala/gst-validator | Already implemented; add known-good/bad fixtures | P1 (tests) |
| Golden cases = source document + expected JSON; CI gate if a risk has no test | craftyqa/llm-extraction-eval-harness | Build `tests/golden/` from the 12 sample bills | P1 |
| Layered scorers; refusal/adversarial cases | Ak-00001/llm-evaluation-pipeline, aayush-dhg/llm-eval-harness | Exact-match scorer on fields; adversarial doctored bill case | P2 |
| Doc layout: architecture / explanation / demo, plus limitations and run-in-5-minutes | odsc2015/agentic-hackathon-template, Stavleak/hackathon-project-readme-kit | Use for repo docs | P1 |

| Arithmetic reconciliation with a tolerance for India GST invoices | bnishit/purchase-ocr | Already done (max ₹2 or 1%); cite it as the same approach | doc only |
| "Flag, don't guess" for unreadable fields; refuse unsupported types (export, SEZ) | gst-einvoice-mcp (PyPI) | Add a scope note and a refusal flag for foreign-currency or export invoices beyond the FX table | P2 |
| Schema as single source of truth (Zod / Pydantic) | Nutlope/receipthero, billfox | Already a JSON schema in `ai.js`; add the schema test in 9.2 | P1 (tests) |
| Swappable model stage behind an interface | billfox, receipt_scanner, vas3k/TaxHacker | Mention in the production path; no code change | doc only |
| User-defined extraction fields (cost centre, project code) | vas3k/TaxHacker | Production path only | later |
| Historical FX at transaction date | vas3k/TaxHacker | Production path (the prototype uses a fixed FX table) | later |

Research caveats: the repo details come from search snippets and aggregators; stars and licences are unverified, and a few URLs (purchase-ocr, receipthero, receipt_scanner) were inferred from search results and need a click-check before they are cited. No open-source project was found for cab-receipt or UPI-screenshot OCR, which supports the claim that this part of Drop & Done is novel.

Gaps found: no open-source expense tool combines an approver dashboard with an AI-written summary, and none detects AI-generated receipts. Say so in the doc.

---

## 9. Testing strategy (mandatory scored criterion)

The email: "All projects must include comprehensive unit test cases." Currently there are none.

### 9.1 Testability fix
`policy.js` and `engine.js` expose plain globals. Add a loader `tests/load.js` that reads both files and runs them with Node's `vm` module (no source changes needed), or append a guarded `if (typeof module !== 'undefined') module.exports = {...}`. Use `node --test` so there are no dependencies, which keeps setup to one command: `node --test tests/`.

### 9.2 Unit test cases
**policy.js**
- `isValidGstin`: valid company GSTIN passes; one changed check character fails; wrong length, lowercase with spaces (normalised), non-Z 14th character, empty/null.
- `gstinCheckChar` round-trips with `withGstinCheck`.
- Policy shape: every cap is a positive number; every clause referenced by `engine.js` exists.

**engine.js** (build lines from small hand-written extraction objects)
- Auto-fill threshold: confidence 0.69 vs 0.70 for date and amount.
- Duplicates: exact hash; same transaction different hash; prior-claim key; `notDuplicate` answer overrides.
- Arithmetic: reconciles with tax; reconciles without tax; mismatch blocks; answer `items` and `printed` branches.
- Dates: future date; exactly 60 vs 61 days old.
- Hotel: nights from check-in/out, per-night cap on pre-GST amount for metro and other tiers.
- Meals: alcohol removal; solo over cap blocks; client meal needs attendees; cap = heads × per-head.
- GST: company GSTIN present vs absent on hotel invoice; invalid vendor GSTIN.
- UPI/handwritten at ₹500 vs ₹501.
- Flight class economy vs business.
- Status derivation priority: excluded > block > risk > complete.
- Grouping: same city consecutive days merge; gap over 1 day splits; city change splits; checkout extends range; undated lines go to "Needs a date".
- Question planner: ordering by amount, at most 3 questions, correct question per block code.
- Totals: `ready` false while any `NEEDS_INFO`.
- `copilotSummary`: risk Low / Medium / High; GST lost text; escaping in `esc()`.

**Integration (sample pack, mocked LLM)**
- Feed the 12 pre-computed extractions through `buildLine` + `evaluate` and assert the headline numbers: 1 duplicate, ₹900 alcohol removed, ₹1,392 GST lost, claimable ₹27,847, 2 trips, 3 questions.
- Re-run after submit with `priorKeys` and assert every line is flagged "already claimed".

**ai.js**
- Stub `fetch`: refusal stop reason throws; `max_tokens` throws; HTTP error surfaces the message; valid JSON parses; PDF uses a `document` block, images use `image`.
- Schema test: every property is in `required`; `additionalProperties:false`.

**Server (Java)**
- Smoke test script (`tests/smoke.js` or a JUnit-free `main`): POST a claim, GET it back, approve, mark paid, reject invalid transitions, localhost binding.

### 9.3 Golden / regression set
`tests/golden/*.json`: one expected-outcome file per sample bill (status, claimable, flag codes). A test fails if any policy code in section 5 has no golden case (risk-coverage gate, inspired by craftyqa).

### 9.4 Reporting
Print the count of passing tests and a coverage summary in the README. Node's `--experimental-test-coverage` gives line coverage without extra tools. **Target: 40 or more tests, over 80% line coverage of `engine.js` and `policy.js`.**

---

## 10. Deliverables checklist (from the Round 2 email)

| # | Requirement | Owner | Done |
|---|---|---|---|
| 1 | Working app, complete by 12 Oct | | existing |
| 2 | Design doc: overview + track, architecture diagrams, setup/deployment, code explanations and assumptions | | [ ] |
| 3 | Unit tests (comprehensive) | | [ ] |
| 4 | YouTube demo video (key features, user experience) | | [ ] |
| 5 | Personal GitHub repo with code + docs + video link; no access-permission requests | | [ ] |
| 6 | Hosted link if hosted | | optional |
| 7 | Data compliance: synthetic data only, no keys or company IP in the repo | | [ ] check |

Suggested repo layout:
```
README.md            judge-facing: what it does, run in 5 minutes, test command, video link
docs/DESIGN.md       the technical design document (sections 1 to 7 and 11 of this spec)
docs/architecture.svg
app/ server/         existing prototype
tests/               unit, golden, smoke
.gitignore           server/out/, *.class, .env, node_modules
```

---

## 11. Security, compliance and limits

- All bills are fictional; no employee, customer or company data. Say this in the README.
- `ANTHROPIC_API_KEY` is read from the environment only; add `.env` to `.gitignore`; search the history before the first push.
- Localhost-only server; key never sent to the browser.
- **Prototype limits:** in-memory claims; a single employee and policy; no PII masking before LLM calls; no HEIC; duplicate detection has no perceptual hash.
- **Production path:** Postgres plus blob storage; HRMS/SSO for identity and grade-based policy; PII masking and data residency; perceptual hashing; policy repository with versioning; audit log.

---

## 12. Two-day plan (today is 10 Oct, deadline 12 Oct)

| When | Work |
|---|---|
| Day 1 morning | Test loader, policy and engine unit tests, golden set |
| Day 1 afternoon | ±1 day duplicate tolerance, `validatePolicy()`, tests for them; `.gitignore`; fix anything the tests expose |
| Day 1 evening | `docs/DESIGN.md`, sequence diagram, README restructure |
| Day 2 morning | Optional P2 items (clarify action, confidence badges) only if tests are green; record demo video from the README script |
| Day 2 afternoon | Upload video, push repo, verify a fresh clone runs and tests pass, submit the link before the deadline |

## 13. Open questions **[TBD]**
1. Which business case / track was assigned?
2. Is live mode (Claude key) used in the demo video, or demo mode only?
3. Whose personal GitHub hosts the repo, and is the repo public?
4. Is hosting worth the time, or is local run plus video enough?
