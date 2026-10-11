# Drop & Done: working prototype (Idea A)

A chat assistant that takes a pile of bills to a submission-ready, policy-checked claim, plus a mock reimbursement system and an approver inbox.

## Run it

Needs only a JDK 8 or newer (`javac` on PATH, or `JAVA_HOME` set). There are no other dependencies.

```bat
run.bat          :: Windows
```
```sh
sh run.sh        # macOS / Linux / Git Bash
```

Then open **http://localhost:8787/** (set `PORT` to use another port). The pitch deck is served at http://localhost:8787/02-pitch-deck/pitch-deck.html.

| Mode | How | What happens |
|---|---|---|
| **Demo** (default) | Just run it | The 12-bill sample pack uses pre-computed extraction. Everything else (policy, duplicates, questions, submission, approval) runs for real. |
| **Live AI** | `set ANTHROPIC_API_KEY=...` before `run.bat` | Every bill, including your own photos and PDFs, is read by **Claude Opus 5.5 vision** with strict JSON output and a confidence score per field. |
| **Live AI with a Gemini key** | `set GEMINI_API_KEY=...` then `run-gemini.bat` (or `GEMINI_API_KEY=... sh run-gemini.sh`) | Same live reading, on **gemini-3.5-flash-lite** (set `GEMINI_MODEL` to change it). Also needs Python 3.8+, standard library only. |

The API key stays on the local Java server, which forwards requests to Claude. The browser never sees it. The server listens on 127.0.0.1 only, and it uses the Windows trust store and system proxy, so it works behind a corporate proxy. Requests opt into server-side `fallbacks: "default"`: if a safety classifier declines, the request is re-run on a recommended model instead of failing.

**No server at all:** serve the repository root with any static file server (or use the GitHub Pages site, https://supriyamanjrekar.github.io/drop-and-done/) and open `/03-prototype/app/`. The app notices there is no `/api/config` and runs serverless: a start screen asks for a free Gemini key from [Google AI Studio](https://aistudio.google.com/apikey) or offers the demo pack, `ai.js` calls Gemini straight from the browser, and `store.js` keeps claims in localStorage with the same rules as the server. The key stays in sessionStorage (or localStorage with *Remember*) and goes only to Google's API.

With a Gemini key, `run-gemini` starts `server/gemini_bridge.py` on 127.0.0.1:8788 (set `BRIDGE_PORT` to change it) and points the Java server at it through `ANTHROPIC_URL`. The bridge turns each extraction request into a Gemini call and the answer back, so the app itself is unchanged. The key stays in that process.

## 3-minute demo script

1. **Drop.** Click *Try the sample pack*. Twelve messy files: an e-ticket, a hotel tax invoice, cab app receipts, a faded café bill, a WhatsApp photo of a dinner bill, a handwritten auto slip, a UPI screenshot, a duplicate photo and a doctored receipt.
2. **Read and organise.** Watch each file get extracted. The claim card on the right builds itself into **Delhi trip (21–23 Sep)** and **Pune day trip (29 Sep)**.
3. **Catch.** The assistant reports:
   - the duplicate cab ride (same trip, different photo)
   - the ₹900 of alcohol it removed
   - ₹1,392 of GST credit lost on the hotel invoice (tap *Draft GST invoice request*)
4. **Ask (3 questions only).**
   - Is the ₹4,200 dinner a client meal? Answer *Yes*, then type the attendees.
   - The Grill Room total doesn't reconcile. Answer *Use items total*. The bill stays 🚩 for finance because it shows signs of tampering.
   - The auto slip has no date. Tap a day.
5. **Ready.** The timer shows pile → ready in about 35 seconds. ₹27,847 is claimable. Click **Submit**.
6. **Approve.** In the *Approver inbox* tab, the copilot summary lists only what needs attention. Approve, then *Mark paid*. The employee chat gets notified at each step.
7. **Evidence.** Click any line to see the bill, each extracted field with its confidence, and every check with its policy clause.

Re-run the sample pack after submitting and 10 of the 12 lines are flagged *already claimed in RCL-…*. This is the cross-claim duplicate check. The other two are the duplicate photo (already left out) and the undated auto slip (no date, so no transaction key until you answer).

All businesses, people, bills and GSTINs in the sample pack are **synthetic**. The GSTINs are generated with valid checksums so the checks run, and could by chance match a real taxpayer; they do not refer to one.

## Code map

| File | Role |
|---|---|
| `server/DropDoneServer.java` | Static hosting, Claude proxy (`/api/claude`), mock finance API (`/api/claims`, `/api/claims/{id}/decision`) |
| `app/ai.js` | Extraction prompt and JSON schema (value + confidence per field, integrity signals); server proxy or, serverless, a direct Gemini call with the user's key |
| `app/store.js` | Serverless only: the mock reimbursement system in localStorage, same validation, ids and transitions as the server |
| `app/policy.js` | Policy as code: caps, clauses, GSTIN checksum |
| `app/engine.js` | Claim intelligence: validation, 3-level duplicates, grouping, policy, line state machine, question planner, approver copilot |
| `app/app.js` | Chat flow, live claim card, evidence view, approver inbox |
| `app/samples.js` | 12 fictional sample bills, rendered to PNG in the browser |

**Line states:** `COMPLETE`, `NEEDS_INFO` (blocks submission and becomes a question), `QUESTIONABLE` (submittable, routed to finance), `EXCLUDED`.
**Claim lifecycle:** `DRAFT` → `READY` → `SUBMITTED` → `APPROVED` → `PAID`, plus `REJECTED` ("Send back") from `SUBMITTED` or `APPROVED`. `DRAFT` and `READY` exist only in the browser. The server enforces the rest and answers `409` to any other move (for example `SUBMITTED` → `PAID`, or anything after `PAID` / `REJECTED`).

## Tests

Prerequisite: **Node.js 20 or newer** (only for the tests; the app itself needs only the JDK). No `npm install` is needed. From the repository root (the folder above `03-prototype`):

```sh
node --test                                   # all unit, integration and golden tests
node --test --experimental-test-coverage      # same, with a line-coverage table
node tests/smoke.js                           # server API smoke test; start run.bat first
```

Run `node --test` with no path: on Node 22+ `node --test tests/` is read as a file name and fails. `npm test` does the same thing.

| File | Covers |
|---|---|
| `tests/policy.test.js` | GSTIN checksum (valid, changed check character, length, case and spaces, 14th character), `validatePolicy()`, every clause `engine.js` uses exists |
| `tests/engine.test.js` | Auto-fill thresholds (date 0.7, amount 0.6), duplicates and prior claims, arithmetic and its answers, date window, hotel caps, meals / alcohol / client entertainment, GST credit, GSTIN, UPI ₹500 limit, flight class, cab cap, currency, status priority, grouping, question planner, totals, submission, copilot summary, HTML escaping |
| `tests/ai.test.js` | `aiExtract` with a stubbed `fetch` (request shape, image vs PDF block, refusal, `max_tokens`, HTTP errors, bad JSON) and the strict JSON schema; the 12 sample extractions validate against it |
| `tests/integration.test.js` | The 12-bill sample pack end to end: ₹28,347 before answers, ₹27,847 and 2 trips on the scripted path, ₹26,047 for "solo", 1 duplicate, ₹900 alcohol, ₹1,392 GST lost, the 4th question after "printed", the copilot summary, 10 of 12 `prior_claim` on a re-run |
| `tests/static.test.js` | Serverless mode: schema and request translation for Gemini, the key sent in a header and never in the URL, 5xx retries, 429 waits, key check; the localStorage claim store (ids, transitions, 409/400/404, validation, reload, corrupt storage) |
| `tests/golden.test.js` + `tests/golden/*.json` | Synthetic bills with answers and expected status / claimable / flag codes; a coverage gate fails if any flag code in `engine.js` has no golden case |
| `tests/smoke.js` | Running server: config, redirect, static files, claim validation (400), submit and list, decision transitions (200 / 409), proxy without a key (503). Prints SKIP if no server is running |

Tests inject `today` = 30 Sep 2026 at local midnight, so they do not depend on the real date. Last run: 144 tests passing; line coverage 100% of `engine.js`, `policy.js`, `ai.js` and `store.js`.

## Deployment

- **Supported: run it locally.** The server binds to `127.0.0.1` only, so nothing is exposed to the network. Keep the folder layout as it is: the launchers serve the folder above `03-prototype`, `/` redirects to `/03-prototype/app/`, and the deck is served from `/02-pitch-deck/`.
- **Never host it with an API key.** `/api/claude` has no authentication; anyone who can reach it can spend the key.
- **Static hosting (GitHub Pages from `main`, or GitLab Pages via `.gitlab-ci.yml`) runs serverless.** Each visitor brings their own key, or uses the demo pack; claims live in their browser only. Nothing is shared between visitors and no key is ever hosted.
- Keep `.env` files outside the served folder; the static server would serve them.

## Prototype limits (production next steps)

- Claims are kept in memory, so restarting the server clears them. Production uses Postgres and blob storage.
- A single demo employee and policy. Production pulls these from HRMS and SSO.
- Mask PII before sending documents to the LLM, and enforce data residency.
- HEIC photos (iPhone) aren't supported in the browser. Convert them on the server in production.
- Duplicate detection uses SHA-256 plus vendor, amount and date. Add perceptual hashing for re-photographed bills.
- Flags and totals are computed in the browser and the server stores the claim as submitted. Production re-runs the engine on the server.
- Currencies outside the policy FX table (`policy.js`) are flagged for finance and taken at face value; production uses the rate on the transaction date.
- The sample bills are dated September 2026, so while a claim holds only sample bills the app pins "today" to 30 Sep 2026 (the tests use the same date). Bills read live are checked against the real date.
