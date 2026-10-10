# Drop & Done: Product and Technical Specification

AI Innovation Lab Season 2, Round 2 submission. Deadline: **12 Oct 2026**.
Items marked **[TBD]** need a decision from the team.

| | |
|---|---|
| **Version** | 0.3.0 (implemented, awaiting browser click-through) |
| **Date** | 2026-10-10 |
| **Status** | Tests, server fixes, docs and UI implemented. UI is unverified in a browser; see AGENTS.md status. Open questions 2 to 4 remain. |

### Versioning
- `docs/SPEC.md` is always the **current** version.
- Each released version is frozen as a snapshot in `docs/versions/SPEC-vX.Y.Z.md`. Never edit a snapshot.
- To iterate: edit `SPEC.md`, bump the version above, add a row to the change log, and copy the file to `docs/versions/SPEC-v<new version>.md`.
- Bump rules: patch (0.1.1) for wording or fixes; minor (0.2.0) for added or changed requirements; major (1.0.0) once the team signs it off as the baseline for the build.

### Change log
| Version | Date | Changes |
|---|---|---|
| 0.1.0 | 2026-10-10 | First draft: requirements, architecture, policy rules, AI design, test strategy, research-derived ideas, two-day plan. |
| 0.2.0 | 2026-10-10 | Opus review against the code and email. Corrected: `prior_claim` vs `duplicate`, amount threshold 0.6, question cap location, decision values, summary is rule-generated, `evaluate` is idempotent not pure, FR-12 grouping, FR-15 lifecycle. Added: missing rule codes, existing features (FR-20), trust assumption, "Spec-vs-code tasks" (section 14), deployment and portability, test prerequisites, fixtures per code, date injection, revised plan. Dropped the ±1 day duplicate change. |
| 0.2.1 | 2026-10-10 | Track resolved: Case 1, Expense & Reimbursement Agent, with brief coverage note; Q1 closed. |
| 0.3.0 | 2026-10-10 | Implementation. Tests (120, 100% line coverage of engine/policy/ai), guarded exports, `validatePolicy()`, `currency_unknown` flag, server JSON validation and decision transition table, PATH-based run scripts, `.gitignore`, `docs/DESIGN.md`, root README, UI redesign (pinned demo date, source label, fallback warning, send-back reopen flow). Test command corrected to `node --test` (Node 22+ treats `tests/` as a file). Q5 closed (Option A). Section 14 updated. |

---

## 1. Overview

**Drop & Done** is an AI-native reimbursement assistant. An employee drops a pile of messy bills (photos, PDFs, screenshots, e-tickets). The assistant reads each one, groups them into trips, checks them against company policy, asks at most three questions, and produces a submission-ready claim. An approver sees a rule-generated summary (a deterministic template over the evaluated lines, not an LLM call) that lists only what needs attention.

- **Track / business case:** **Case 1, "Expense & Reimbursement Agent"** (from "Business Cases for AI Innovation Lab Season 2.docx"; the other option was Case 2, Employee Onboarding Companion). Name it in the first paragraph of the design document, because the email requires "a clear project overview including the track selected".
- **Brief coverage:** the case asks for an AI-native assistant over a familiar interface such as chat that understands receipts, extracts data, groups expenses, notices missing details, asks only necessary questions, checks basic rules, identifies duplicates and prepares a submission-ready claim. The brief explicitly allows mocking the corporate reimbursement system. Drop & Done covers both the user-facing challenge (pile of receipts to "ready to submit") and the backend challenge (messy documents to a structured claim tracking complete / missing / questionable). Map each phrase to an FR in the design doc.
- **Headline claim:** pile of bills to a ready claim in about 35 seconds in demo mode (extraction is pre-computed, with a simulated 0.35 to 1.25 s per file; the rest is the presenter answering). Live mode reads 4 files at a time with one Opus call each and is slower; measure it before quoting a number.

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
- Defects caught on the sample pack: 1 duplicate (a different render of the QuickRide 21 Sep receipt, caught by the transaction key, not the file hash), 1 doctored bill (Grill Room), ₹900 alcohol removed, ₹1,392 GST credit flagged.
- Headline numbers hold only on the scripted path: Tandoor answered as a client meal with 2 or more attendees, Grill Room answered "items" (₹1,865 becomes ₹1,365), and the auto slip given a Delhi date. That path gives claimable ₹27,847 and 2 trips. Before any answers claimable is ₹28,347; if Tandoor is answered "solo" it is ₹26,047. "3 questions" counts the numbered questions; the attendees follow-up is a 4th prompt.
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
  policy.js  POLICY + GSTIN checksum             /api/claims/{id}/decision -> APPROVED / REJECTED / PAID
  samples.js 12 fictional bills                  static hosting (app, pitch deck)
```

Design principles:
1. **AI reads, rules decide.** The model only extracts fields, confidences and integrity signals. Every policy outcome comes from deterministic code in `engine.js`, so it is explainable and testable.
2. **Evaluation is deterministic and idempotent** for a given `(lines, answers, context)`. `evaluate()` mutates the lines (flags, status, claimable, billed) but recomputes them from scratch, so each user answer simply re-runs it. Tests must inject `ctx.today`.
3a. **Trust assumption.** Flags, totals and the summary are computed in the employee's browser and stored by the server as submitted. The server never re-evaluates, and duplicate history is client-side. Production path: re-run `engine.js` server-side and keep claim history in the database.
3. **The key never reaches the browser.** The server proxies Claude calls and binds to localhost only.
4. **Two modes.** Demo mode replays pre-computed extractions for the sample pack so the demo is reliable offline. Live mode sends every file to Claude vision.

The server also serves `GET /api/config` (mode and key presence). The Windows trust store and proxy support are JVM flags set in `run.bat` / `run.sh`, not server logic.

Deliverable: the email asks for diagrams (plural). `01-architecture/architecture-diagram.svg` exists; **[TODO]** add a sequence diagram (Drop > Extract > Evaluate > Ask > Submit > Approve > Pay) and a claim-lifecycle state diagram, and keep paths consistent with section 10.

---

## 3. Functional requirements

### 3.1 Ingestion
- FR-1 Accept JPG/PNG/WEBP/GIF/PDF by drag-and-drop, file picker or paste. Compute a SHA-256 per file. Images are downscaled to 1800 px JPEG before sending. Files are read 4 at a time.
- FR-2 "Try the sample pack" loads 12 fictional bills rendered in the browser.
- FR-3 Extraction runs per file with visible progress; a failed file shows an error and does not block the rest. In demo mode, user-supplied bills are rejected (only the sample pack is pre-computed). In live mode, if the Claude call fails on a sample file the app falls back to the pre-computed result with a small note; the evidence view labels the source ("read by Claude vision (live)" vs pre-computed).

### 3.2 Extraction (AI)
- FR-4 Output strict JSON from a schema: for each field a `{value, confidence}` pair, plus `document_type`, `category`, `line_items[]` (with `is_alcohol`), `legibility`, `integrity_signals[]`, `notes`.
- FR-5 Fields with no visible value return `null` with confidence 0 (never invented).
- FR-6 Handle refusal and truncation stop reasons explicitly; surface a readable error.

### 3.3 Claim intelligence (`engine.js`)
- FR-7 **Line building:** convert currency to INR using `POLICY.fxToInr`; normalise city names. An unknown currency silently gets fx = 1 (treated as INR); see section 14.
- FR-8 **Auto-fill rule (as implemented):** the date is used automatically only at confidence at least `autoFillConfidence` (0.7); the amount uses a lower threshold of 0.6 (engine.js:74). Vendor, city, GSTINs, travel class and category are used at any confidence. Below the threshold the date or amount becomes a question.
- FR-9 **Duplicates:** two codes. `duplicate` (risk, line becomes EXCLUDED): same file hash, or same transaction key (`vendor|amount|date`) from a different photo; the `notDuplicate` answer overrides it. `prior_claim` (risk, line becomes QUESTIONABLE, so it can still be submitted): same key in a previously submitted claim; `notDuplicate` does not clear it. Excluded lines and lines without a date (no key) get no `prior_claim` check.
- FR-10 **Validation:** arithmetic reconciliation (items + tax vs printed total, tolerance max(₹2, 1%)), future dates, stale dates, GSTIN checksum, integrity signals.
- FR-11 **Policy checks:** the rule table in section 5.
- FR-12 **Grouping:** lines are sorted by date (on the same date, Airfare sorts first) and grouped into trips by date gap (more than 1 day starts a new group) and city change (only when both lines have a city). A hotel checkout date is applied after grouping, so it widens the displayed range but does not pull later bills into the trip. Undated lines go to "Needs a date", so "2 trips" is only true once every line has a date.
- FR-13 **Line states:** `COMPLETE`, `NEEDS_INFO` (blocks submit), `QUESTIONABLE` (submittable, routed to finance), `EXCLUDED`.
- FR-14 **Question planner:** `planQuestions` returns a question for every blocking line, ordered by printed total (`l.total`), largest first. The cap of 3 (`maxQuestions`) is a session counter in `app.js`, and the Fix button and the attendees follow-up bypass it.
- FR-15 **Claim lifecycle:** `DRAFT > READY > SUBMITTED > APPROVED > PAID`, plus `REJECTED` ("Send back"). DRAFT and READY exist only in the UI; the server starts at SUBMITTED and accepts any decision from any state. There is no edit/resubmit flow after rejection, and a rejected claim's keys stay in `priorKeys`, so resubmitting flags every line as already claimed.

### 3.4 Evidence view
- FR-16 Clicking a line shows the bill image, each extracted field with its confidence, and every check with its policy clause.

### 3.5 Approver inbox
- FR-17 Copilot summary (rule-generated string template, engine.js `copilotSummary`): total, per-trip amounts, only the risky lines with reasons, what the assistant already adjusted, what was left out, GST credit lost, overall risk: Low for 0, Medium for 1, High for 2 or more QUESTIONABLE lines.
- FR-18 Actions: approve, reject ("Send back"), mark paid. The employee chat is notified at each step.
- FR-19 **[Planned]** third action "request clarification", sending a question back to the employee (idea from the research, section 8).

### 3.6 Other implemented features (list in the design doc)
- FR-20 Draft GST invoice request email; line actions Not-a-duplicate, Exclude, Include again; typed commands (policy Q&A, submit, status, reset); live timer.

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
| `duplicate` | Same file hash or same transaction key, different photo | Excluded (risk); `notDuplicate` answer overrides | §9.1 |
| `prior_claim` | Same key as a line in a previously submitted claim | Questionable (risk); not cleared by `notDuplicate`; skipped for excluded or undated lines | §9.1 |
| `hotel_cap` / `hotel_ok` | Room rate excl. GST above ₹7,000 (metro) / ₹5,000 (other) per night / within cap | Questionable / info | §4.2 |
| `meal_over_cap` | Meal above ₹1,500 per head, on claimable after alcohol removal, when no answer is given | Blocks, asks "client meal?" | §5.1 |
| `meal_capped` | Capped at heads × cap after the answer | Claimable reduced | §5.1 / §5.3 |
| `attendees_missing` | Client entertainment needs attendee names; heads = 1 + attendees (employee counts); ₹2,000 per head | Blocks | §5.3 |
| `ent_ok` | Entertainment within the per-head cap | Info | §5.3 |
| `alcohol` | Alcohol line items removed | Claimable reduced | §5.4 |
| `cab_cap` | Ride above ₹1,500 | Warning | §6.1 |
| `noinv_ok` / `noinv_over` | UPI or handwritten proof accepted up to ₹500 / above | Info / questionable | §7.2 |
| `stale` | Older than 60 days (fractional days from `ctx.today`; inject local midnight in tests) | Warning only; "manager sign-off" is text, nothing routes it | §2.3 |
| `flight_class` | Non-economy | Questionable | §3.1 |
| `gst_lost` / `itc_ok` | Tax > 0 and company GSTIN absent / present on hotel or air invoice (`itc_ok` has no clause) | Warn / good | §8.1 |
| `gstin_invalid` | Vendor GSTIN fails format or mod-36 checksum | Questionable | n/a |
| `arith_mismatch` / `arith_fixed` | Items + tax differ from printed total. Blocks until answered. "Printed" leaves it as risk; "items" turns it into `arith_fixed` (info). Skipped when the user types an amount | Blocks / info | n/a |
| `integrity` | Vision model reports tamper signals | Questionable | n/a |
| `future_date` | Date after today | Questionable | n/a |
| `currency_unknown` | Currency not in `fxToInr` (₹, Rs., Rupees normalise to INR) | Questionable (risk) | n/a |
| `not_receipt` | Document is not a receipt | Excluded | n/a |
| `user_excluded` | User excluded the line | Excluded | n/a |
| `amount_unreadable` / `date_unreadable` / `category_unclear` | Value missing or below its confidence threshold | Blocks, asks the user | n/a |

Interaction to note: after answering "printed" on Grill Room, the bill still exceeds the ₹1,500 meal cap, so `meal_over_cap` blocks and a 4th question is needed; the flow then hits the question limit and the claim is not ready.

---

## 6. AI design

- **Model:** `claude-opus-5-5` with vision; PDFs sent as `document` blocks. Strict `json_schema` output; `effort: medium`.
- **Fallbacks:** request sets `fallbacks: "default"` so a safety-classifier decline is re-run on a recommended model.
- **Prompt rules:** extract only what is visible, calibrated confidence (low for faded, handwritten or cropped values), DD/MM/YYYY handling, GSTIN roles, alcohol flag, concrete observable integrity signals only.
- **Routing by confidence (existing + planned):**
  - date at confidence at least 0.7, amount at least 0.6: auto-fill (other fields are used at any confidence; see FR-8)
  - below threshold or null: becomes a question or a flag
  - integrity signals or validation failure: route to finance (`QUESTIONABLE`)
  - not a receipt: excluded
- **Unverified assumption:** `fallbacks: "default"` and the beta header `server-side-fallback-2026-07-01` (ai.js, DropDoneServer.java) have not been verified against the live API. If rejected, every live call would silently use pre-computed results. Do one verified live run before recording.
- **Demo-mode caveat:** integrity signals on the doctored bill are canned in `samples.js`. Say so, and show a live run in the video.
- **Why this is not "just OCR":** vision reads handwritten, WhatsApp and UPI documents; the model produces integrity signals; deterministic rules then decide. Open-source receipt-fraud tools found in research use classic forensics (ELA, noise residuals) and are trained on older data; none handles AI-generated receipts, so vision-based signals are a differentiator.

---

## 7. Server API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/config` | GET | Mode and whether a key is present |
| `/api/claude` | POST | Proxy to Anthropic Messages API; adds the key |
| `/api/claims` | POST / GET | Submit a claim; list claims for the approver inbox |
| `/api/claims/{id}/decision` | POST | Body `{"decision":"APPROVED"\|"REJECTED"\|"PAID"}` (uppercase; detected by substring match; planned `CLARIFY`) |

State is in memory (prototype limit). Known server gaps (section 14): any decision is accepted from any state, and POST `/api/claims` stores any body starting with `{` without parsing, so one malformed claim breaks GET.

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
| Duplicate: exact hash, then fuzzy vendor/amount/date within ±1 day | Hamzo069 issue #12 | **Deferred.** ±1 day would exclude legitimate repeats (daily cab fare, daily meal). If done later, make it a `risk` flag, never an exclusion | later |
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
`policy.js` and `engine.js` expose plain globals, and `engine.js` uses `POLICY`, `isValidGstin` and `esc` as free globals. Node is **not installed** on the current machine, and the README promises "needs only a JDK", so decide first (Q5):
- **Option A (recommended):** make Node 20+ a stated test prerequisite. Add a guarded `if (typeof module !== 'undefined') module.exports = {...}` to both files, and a test setup file that sets `globalThis.POLICY` and friends before requiring `engine.js`. Run `node --test` from the repo root (not `node --test tests/`, which fails on Node 22+). A `vm` loader also works but needs an appended export line (top-level `const`/`function` are not exposed on a vm context) and `--experimental-test-coverage` likely will not report on vm-loaded code.
- **Option B:** a browser `tests.html` runner that loads the same scripts; no install, but no CLI coverage.
Add the test prerequisite and command to the README either way.

### 9.2 Unit test cases
**policy.js**
- `isValidGstin`: valid company GSTIN passes; one changed check character fails; wrong length, lowercase with spaces (normalised), non-Z 14th character, empty/null.
- `gstinCheckChar` round-trips with `withGstinCheck`.
- Policy shape: every cap is a positive number; every clause referenced by `engine.js` exists.

**engine.js** (build lines from small hand-written extraction objects)
- Auto-fill threshold: date 0.69 vs 0.70; amount 0.59 vs 0.60 (current code), unless section 14 item 3 changes amount to 0.7.
- Duplicates: exact hash; same transaction different hash; `notDuplicate` overrides `duplicate`; `prior_claim` is QUESTIONABLE (not excluded) and is not cleared by `notDuplicate`.
- Arithmetic: reconciles with tax; reconciles without tax; mismatch blocks; answer `items` and `printed` branches.
- Dates: future date; exactly 60 vs 61 days old. Always inject `ctx.today` at local midnight; at 10:00 a bill exactly 60 days old computes as 60.4 days and is already stale.
- Hotel: nights from check-in/out, per-night cap on pre-GST amount for metro and other tiers.
- Meals: alcohol removal; solo over cap blocks; client meal needs attendees; cap = heads × per-head.
- GST: company GSTIN present vs absent on hotel invoice; invalid vendor GSTIN.
- UPI/handwritten at ₹500 vs ₹501.
- Flight class economy vs business.
- Status derivation priority: excluded > block > risk > complete.
- Grouping: same city consecutive days merge; gap over 1 day splits; city change splits; checkout extends range; undated lines go to "Needs a date".
- Question planner: ordering by printed total, correct question per block code. The cap of 3 is tested at app level, or add `.slice(0, maxQuestions)` (section 14).
- Totals: `ready` false while any `NEEDS_INFO`.
- `copilotSummary`: risk Low / Medium / High; GST lost text; escaping in `esc()`.

**Integration (sample pack, mocked LLM)**
- Feed the 12 pre-computed extractions through `buildLine` + `evaluate` with a fixed `ctx.today` and the scripted answers (Tandoor client meal with attendees, Grill Room "items", auto slip dated in Delhi). Assert: 1 duplicate, ₹900 alcohol removed, ₹1,392 GST lost, claimable ₹27,847, 2 trips. Also assert the pre-answer total ₹28,347.
- Re-run after submit with `priorKeys` and assert every non-excluded, dated line has `prior_claim` (10 of 12; the duplicate is excluded and the undated auto slip has no key).

**ai.js**
- Stub `fetch`: refusal stop reason throws; `max_tokens` throws; HTTP error surfaces the message; valid JSON parses; PDF uses a `document` block, images use `image`.
- Schema test: every property is in `required`; `additionalProperties:false`.

**Server (Java)**
- Smoke test script (`tests/smoke.js` or a JUnit-free `main`): POST a claim, GET it back, APPROVED, PAID, localhost binding. "Reject invalid transitions" only passes after the server gets a transition table (section 14 item 4); otherwise drop it.

### 9.3 Golden / regression set
The 12 sample bills do not trigger `hotel_cap`, `cab_cap`, `stale`, `flight_class`, `gstin_invalid`, `future_date` or `noinv_over`, and `meal_capped`, `attendees_missing` and `prior_claim` appear only after answers. So: add small synthetic fixtures per code, and give each golden file an `answers` block and a fixed `today`. `tests/golden/*.json` holds expected outcomes (status, claimable, flag codes). A test fails if any code in section 5 has no golden case (risk-coverage gate, inspired by craftyqa).

### 9.4 Reporting
Print the count of passing tests and a coverage summary in the README. Node's `--experimental-test-coverage` gives line coverage without extra tools when modules are loaded with `require` (Option A in 9.1). **Target: 40 or more tests, over 80% line coverage of `engine.js` and `policy.js`.**

---

## 10. Deliverables checklist (from the Round 2 email)

| # | Requirement | Owner | Done |
|---|---|---|---|
| 1 | Working app, complete by 12 Oct | | existing |
| 2 | Design doc: overview + track, architecture diagrams (more than one), setup **and deployment** instructions, code explanations and assumptions | | [ ] |
| 3 | Unit tests (comprehensive) | | [ ] |
| 4 | YouTube demo video (key features, user experience) | | [ ] |
| 5 | Personal GitHub repo with code + docs + video link; no access-permission requests | | [ ] |
| 6 | Hosted link if hosted | | optional |
| 7 | Data compliance: synthetic data only, no keys or company IP in the repo | | [ ] check |

Suggested repo layout:
```
README.md            judge-facing: what it does, run in 5 minutes, test command, video link
docs/DESIGN.md       the technical design document (sections 1 to 7 and 11 of this spec)
docs/architecture.svg, docs/sequence.svg
03-prototype/        keep the existing layout (app/, server/, run.bat, run.sh)
01-architecture/ 02-pitch-deck/
tests/               unit, golden, smoke
.gitignore           server/out/, *.class, .env, node_modules, .claude/
```
Do **not** move `app/` and `server/` to the repo root: `run.bat` and `run.sh` serve the parent folder, and the server redirects `/` to `/03-prototype/app/` (DropDoneServer.java:166) and serves the deck at `/02-pitch-deck/`. Moving them makes a fresh clone return 404. If the layout changes, update the serve root, the redirect and the deck link, then verify with a fresh clone.

**Setup and deployment (for the design doc):** run.bat falls back to a hard-coded `C:\Program Files\Java\jdk1.8.0_202`, and run.sh defaults to that Windows path when `JAVA_HOME` is unset, so it fails on macOS/Linux. Use `javac`/`java` from PATH and test on a clean machine. The server binds to 127.0.0.1. Static hosting (e.g. GitHub Pages) breaks `/api/claims` and forces demo mode. Never host with a key; if hosting, host demo mode only and say so.

---

## 11. Security, compliance and limits

- All bills are fictional; no employee, customer or company data. Say this in the README. The sample GSTINs carry valid checksums and could collide with real taxpayers; label them synthetic.
- Confirm the policy caps and clause numbers in `policy.js` are invented, not copied from the employer's real travel policy (company IP).
- Before pushing: set git `user.email` to a personal address (the current context is a corporate account); exclude `server/out/`, `.claude/` and AGENTS.md if not intended. The static server would serve a `.env` placed under its root, so keep `.env` outside it.
- `ANTHROPIC_API_KEY` is read from the environment only; add `.env` to `.gitignore`; search the history before the first push.
- Localhost-only server; key never sent to the browser.
- **Sample dates expire:** the samples are hard-coded to Sep 2026 and the app uses the real `new Date()`, so from about 20 Nov 2026 every line shows `stale` and the approver table changes for judges who run it later. Either pin a demo "today" in demo mode (recommended) or state this in the README.
- **Prototype limits:** in-memory claims; a single employee and policy; no PII masking before LLM calls; no HEIC; duplicate detection has no perceptual hash.
- **Production path:** Postgres plus blob storage; HRMS/SSO for identity and grade-based policy; PII masking and data residency; perceptual hashing; policy repository with versioning; audit log.

---

## 12. Two-day plan (today is 10 Oct, deadline 12 Oct)

| When | Work |
|---|---|
| Day 1 (10 Oct) morning | Answer Q1 to Q5; install Node; test setup, policy and engine unit tests |
| Day 1 afternoon | Golden fixtures, ai.js stub tests, section 14 code fixes (P0 items only); `.gitignore`; one verified live run |
| Day 1 evening | `docs/DESIGN.md`, diagrams, README restructure. **Feature freeze.** |
| Day 2 (11 Oct) morning | Record the demo video; upload to YouTube as Unlisted (allow time for processing) |
| Day 2 afternoon | Push to personal GitHub, clean-clone check (ideally on a second machine), link video and docs |
| 12 Oct | Buffer only: fixes and submission. Confirm the exact deadline time and timezone from the email. |
No optional P2 features (clarify action, confidence badges) unless everything above is done.

## 13. Open questions **[TBD]**
1. ~~Which business case / track?~~ **Resolved (v0.2.1): Case 1, Expense & Reimbursement Agent.**
2. Is live mode (Claude key) used in the demo video, or demo mode only?
3. Whose personal GitHub hosts the repo, and is the repo public?
4. Is hosting worth the time, or is local run plus video enough?
5. ~~Node or browser test page?~~ **Resolved (v0.3.0): Option A.** Node 20+ prerequisite; command `node --test` from the repo root (also `npm test`). On this machine Node is not installed; VS Code's bundled Node runs the tests via `ELECTRON_RUN_AS_NODE=1 Code.exe --test`.

---

## 14. Spec-vs-code tasks (from the v0.2.0 review)
Where the spec and the code disagree, either fix the code or keep the spec as written above. Tick when done.

| # | Priority | Task |
|---|---|---|
| 1 | P0 | **Done.** Q5 decided; test prerequisite in README |
| 2 | P0 | **Done** on Windows (PATH, JAVA_HOME fallback, no-JDK error). Not run on macOS/Linux |
| 3 | P1 | **Done:** kept 0.6, now `POLICY.amountAutoFillConfidence` |
| 4 | P1 | **Done:** strict JSON validation (400); transitions SUBMITTED to APPROVED/REJECTED, APPROVED to PAID/REJECTED, else 409 |
| 5 | P1 | **Decided:** cap stays in `app.js` (not tested at app level; untested) |
| 6 | P1 | **Done in UI** (unverified in browser): rejected claims do not count as prior; Reopen flow |
| 7 | P1 | **Done:** `currency_unknown` flag |
| 8 | P1 | **Done in UI** (unverified): demo today pinned to 30 Sep 2026 for sample-pack-only claims |
| 9 | P2 | **Done in UI** (unverified): source label and loud fallback warning |
| 10 | P2 | **Done:** README says 10 of 12 |

New findings from implementation (open):
| # | Priority | Task |
|---|---|---|
| 11 | P0 | **Security:** `/api/claude` and `/api/claims` accept any content type, so another website open in the same browser could post a text/plain form to 127.0.0.1:8787 and spend the API key. Fix: require `Content-Type: application/json` (forces a CORS preflight, which is refused) |
| 12 | P2 | Static server serves anything under the repo root (`.git/`, `.claude/`, `tests/`); restrict to `03-prototype/app`, `02-pitch-deck`, `01-architecture` |
| 13 | P2 | `groupLines` sort comparator is inconsistent for two same-date non-Airfare bills |
| 14 | P2 | Transaction key uses the printed total before the "items" answer; document it |
| 15 | P1 | Verified live run (Claude API, `fallbacks` header) still outstanding |
