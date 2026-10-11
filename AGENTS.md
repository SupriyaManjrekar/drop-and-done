# AGENTS.md

Drop & Done: AI reimbursement assistant for the AI Innovation Lab S2 Round 2. Deadline **12 Oct 2026**.

**The spec is the source of truth:** `docs/SPEC.md` (current), snapshots in `docs/versions/`. Requirements, policy rules, architecture, test plan and deliverables live there. Do not duplicate them here.

## Layout
- `01-architecture/` diagram, `02-pitch-deck/` deck, `03-prototype/` app (`app/` JS, `server/` Java), `docs/` spec and design docs.

## Commands
- Run: `03-prototype/run.bat` then http://localhost:8787/ (needs JDK 8+; `ANTHROPIC_API_KEY` for live mode).
- Tests: `node --test` from the repo root (or `npm test`). Node is not installed here; run with VS Code's bundled Node: `ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" --test`.

## Rules
- Changing requirements, rules or scope: edit `docs/SPEC.md`, bump its version, update the change log, snapshot to `docs/versions/`.
- `policy.js`, `engine.js`, `ai.js`, `samples.js` use plain browser globals with guarded `module.exports`; tests load them via `tests/setup.js`.
- Synthetic data only. Never commit API keys, `.env` or `server/out/`.
- AI extracts; deterministic code in `engine.js` decides. Do not move policy decisions into the prompt.

## Status
Update this section when work lands. Keep it to one line per item.
- [x] Prototype working (demo and live modes)
- [x] Track chosen: Case 1, Expense & Reimbursement Agent
- [x] Spec v0.3.0 (implemented; Opus-reviewed; code tasks in SPEC section 14)
- [ ] Open questions 2 to 4 (live mode, GitHub account/visibility, hosting)
- [x] Unit tests: 144 pass, 100% line coverage of engine/policy/ai/store; smoke 13/13
- [x] Spec v0.4.0: serverless mode (bring-your-own key, localStorage claims), GitHub Pages (and GitLab Pages CI); verified in a browser with a real key
- [x] `docs/DESIGN.md`, root README, `.gitignore`
- [ ] UI redesign verified in a browser (written blind; check console, run demo script)
- [ ] Fix SPEC section 14 #11 (content-type check on POST, API-key abuse) and #15 (live run)
- [ ] GitHub repo (set personal git email first)
- [ ] Demo video on YouTube
