---
name: workflow-e2e
version: 2.4.1
type: workflow
consumes: src/** built
produces: "artifacts/ (video, screenshots, logs, trace, io-samples)"
default_pattern: A
default_agent: qa-tester
supports_patterns: [A]
can_delegate_to: [e2e-testing-patterns]
gate:
  postcondition:
    - artifacts_exist: true
    - build_clean: true
    - scoped_tests_pass: true
    - real_interface_invoked: true       # runtime evidence required per surface
    - no_interface_mocks: true           # interfaces must not be stubbed/mocked
    - per_surface_artifact_present: true # each exercised surface has its own artifact
    - effect_observed: true              # ack signal alone is NOT sufficient — target effect must be asserted (see §Effect-vs-Ack)
surface_mapping:
  UI: "Playwright (real browser)"
  CLI: "subprocess stdin/argv/exit_code"
  HTTP_API: "real server + curl/fetch"
  Database: "real or in-process test DB"
  Hook: "stdin JSON → stdout JSON"
exempt_if_surface: [style, typography, typo, dialogue]
---

# workflow-e2e

> **This stage is NOT a test-code run.**
> `vitest run`, `jest`, or `pytest` alone DO NOT satisfy E2E. They exercise test files, not the real interface.
>
> E2E means the **actual interface** that a real user / caller / client touches — a real browser, a real shell, a real HTTP port, a real database engine, a real hook stdin/stdout pipe — is driven with real inputs and the real output is captured as evidence.

Verifies user scenarios at the real interface. Runner selection depends on the surface.

## 5-Surface Mapping — Real Interface Contract

Every E2E run MUST exercise the real interface for the affected surface(s). A run that does not produce the **required artifact** for its surface is **not a valid E2E pass**, even if a test file returned zero failures.

| Surface | Real interface | Runner | Required artifact |
|---------|----------------|--------|-------------------|
| UI / Frontend | A real browser, launched by Playwright, actually clicking/typing | `npx playwright test` | **video recording** + **screenshot per scenario** + browser console log |
| CLI / Script | Real subprocess, real stdin/argv, real exit code | subprocess spawn | **command transcript** (argv + stdin + stdout + stderr + exit code) |
| HTTP API | Real HTTP server on a real port, real fetch/curl client | start server → real request | **request/response log** (method, path, status, headers, body, duration) |
| Database | A real DB engine (real Postgres/SQLite/in-process same engine) | real queries | **query log** (SQL executed, rows affected, before/after state samples) |
| Hook script | Actual stdin pipe, actual stdout/exit code capture | `cat payload.json \| node hook.mjs` | **input + output JSON samples** + exit code |

### What DOES NOT count as E2E

- Running `pnpm test` / `vitest run` / `jest` alone — that's `workflow-write-test` or `workflow-verify` Phase 1, **not E2E**.
- Calling a handler function directly in-process without the real interface wrapper (no browser, no network, no shell).
- Using mocks for the interface under test (e.g., MSW-mocked HTTP when the HTTP surface IS the subject).
- Stubbing the database driver when the DB layer IS the subject.
- Asserting on return values of functions without observing the externally visible side effect (rendered DOM, HTTP response body, CLI exit code, DB row change, hook stdout).
- "Dry run" mode of Playwright (`--list`) or skipping browser launch.
- **Ack-only assertion** — observing ONLY an acknowledgement signal (toast, banner, success-text regex, spinner-resolved → idle, modal-closed, HTTP 2xx status, "no error thrown") WITHOUT also asserting that the target state the operation was supposed to produce actually materialized. Banner text "You are impersonating X" is an ack; X's data actually rendering in the DOM is the effect. An ack without an effect assertion is **not a valid E2E pass** (gate `effect_observed` fails).

### What DOES count

- UI: Playwright launched a real browser, navigated to a real URL (localhost or fixture server), the screenshot PNG and video MP4/WebM are saved under `.smt/features/<slug>/artifacts/` and dereferenced in `events[].evidence`.
- CLI: the command was spawned as a child process; the transcript file contains the exact argv, the piped stdin, the captured stdout+stderr, and the exit code.
- HTTP: a real server bound a real port (even a random one); the request was issued over the network loopback; request+response are logged with status code and body length.
- DB: queries ran against a real engine (Postgres/SQLite/whatever prod uses or a compatible in-process version — NOT a stub); before/after state was captured or verified.
- Hook: payload was actually piped via `cat | node hook.mjs`; both the input payload and the captured output/exit were written to disk as artifacts.

## Effect-vs-Ack — per-surface observation rubric

Every scenario that claims an operation succeeded MUST assert on BOTH:
1. The **ack** (operation was accepted), and
2. The **effect** (the new externally-visible state the operation was supposed to produce).

If the operation has no durable effect beyond the ack itself (e.g., "Cancel closes the modal" — the closed-modal IS the effect), the scenario must explicitly declare `effect_type: local_ui_toggle` in `state.json.scenarios[].effect_evidence.type` and the gate accepts the absence of separate effect evidence. Every other scenario MUST populate `effect_evidence` with one of the types below.

| Surface | Ack (not sufficient alone) | Effect (MUST be asserted) | `effect_evidence.type` |
|---------|----------------------------|---------------------------|------------------------|
| UI | Toast / banner text / modal closed / spinner → idle / success-route reached | New DOM content that reflects the target state change. Before/after screenshot diff, or assertion on a `data-testid` value/count that encodes the new state. Example: after "Impersonate X" → assert X's sheet titles (or empty-state message if X has none) render in the sheet list, NOT just the banner. | `dom_diff` or `dom_state_query` |
| HTTP API | 2xx status code | Follow-up GET or list query returning the new resource state, or DB SELECT confirming the row. | `http_get_after` or `db_select` |
| CLI | Exit code 0 / stdout contains "done" | Subsequent command (or filesystem scan) reflects the change. | `fs_diff` or `followup_cmd` |
| DB | INSERT/UPDATE rowcount > 0 | SELECT that reads back the new row/value and asserts on its content. | `db_select` |
| Hook | Exit code 0 | Captured `stdout` JSON parsed and matched against expected shape/fields. | `stdout_parse` |
| Local UI toggle (exemption) | Modal closed, input cleared, dropdown collapsed — no external effect | The UI absence/presence IS the effect — document as such. | `local_ui_toggle` |

### Why this matters (concrete case, 2026-04-20)

`admin-impersonate-menu-item` E2E was declared pass because:
- Screenshot `07-impersonation-active-banner.png` contained the banner text "You are impersonating dfhilder@gmail.com.".
- Banner-text regex matched → `bannerVisible = true` → gate checks passed.

But the target effect — dfhilder's sheets/folders/plan rendering in the dashboard — was never asserted. The screenshot happened to show "Loading..." and an empty sidebar. No follow-up assertion read the sheet list after load. A broken impersonation flow that only fires the banner but never swaps the data would pass the old gate. This is exactly the failure the `effect_observed` postcondition now blocks.

### Recording the evidence

For each scenario in `state.json.scenarios[]`:

```jsonc
{
  "name": "admin-impersonates-dfhilder",
  "surface": "ui",
  "ack_evidence": {
    "type": "dom_state_query",
    "reference": "artifacts/screenshots/07-impersonation-active-banner.png",
    "note": "banner text visible"
  },
  "effect_evidence": {
    "type": "dom_diff",
    "reference": "artifacts/screenshots/07a-impersonation-dashboard-loaded.png",
    "assertion": "dfhilderSheetTitles !== adminSheetTitles && planBoxText includes 'Lite'"
  }
}
```

If `effect_evidence` is `null`, `{}`, or its `type` is missing, the gate `effect_observed` check fails with `cause: effect_unverified`. Reviewers and the R14 watchdog use this field.

## Artifacts directory (required)

```
.smt/features/<slug>/artifacts/
├── ui/
│   ├── <scenario>.webm           (video recording — Playwright)
│   ├── <scenario>-<step>.png     (screenshot per decisive moment)
│   └── console.log               (browser console)
├── cli/
│   └── <scenario>.transcript     (argv + stdin + stdout + stderr + exit)
├── api/
│   └── <scenario>.log            (request/response trace)
├── db/
│   └── <scenario>.sql.log        (queries + before/after state)
└── hook/
    ├── <scenario>.input.json
    ├── <scenario>.output.json
    └── <scenario>.exit            (exit code, one integer)
```

Per exercised surface at least one artifact file must exist. Zero artifacts for an exercised surface = **gate fail**.

## Gate enforcement (hook)

The E2E gate verifies (rejects on any miss):

1. `build_clean` — `npm run build` (or equivalent) exit 0
2. `artifacts_exist` — the artifacts/ directory exists and contains at least one of the required files for each surface the test claims to have exercised
3. `real_interface_invoked` — `state.json.events` entry for this skill includes `evidence.type: exit_code | parse | diff` referencing an artifact path (not `file_present` pointing to a test file)
4. `no_interface_mocks` — code paths exercised during E2E do not go through stub/mock modules for the surface under test (static check on imports during run logs)
5. `per_surface_artifact_present` — if the tasker declared `surface: [ui, api]`, both `ui/*` and `api/*` artifacts must exist
6. `effect_observed` — every `state.json.scenarios[]` entry has a populated `effect_evidence` object with a valid `type` (one of: `dom_diff`, `dom_state_query`, `http_get_after`, `fs_diff`, `followup_cmd`, `db_select`, `stdout_parse`, `local_ui_toggle`) and a non-empty `reference`. `local_ui_toggle` is accepted only when the operation has no durable external effect. An entry with `effect_evidence: null` or `effect_evidence.type: ack_only` fails the gate with `cause: effect_unverified`.

If a run reports "all tests passed" but produces no artifacts, the gate flips the event to `result: fail`, `cause: artifact_missing` or `cause: mocked_interface` or `cause: effect_unverified`, and routes via the producer chain.

## Iron Law compliance

- **No evasion** (Principle #2): claiming E2E pass without artifacts is a Critic Watchdog violation (see `scripts/critic-watchdog.mjs` R11). CRITICAL-severity block.
- **File is truth** (Principle #5): test-runner stdout alone is not truth. Artifacts on disk are.
- **No retry** (Principle #4): on fail, the producer chain routes to `workflow-coding`; do not re-run the same runner hoping for a different result.

## Constraints (unchanged from prior versions)

- No modification or deletion of PROD data (explicit user permission required).
- When login is needed, use `E2E_TEST_ID` / `E2E_TEST_PW` from `.env`.
- When data is missing, ask the user to insert it — do not fabricate fixtures to silently pass.

## Scoped execution (principle 8)

```bash
# Only specs related to changed files — scoped by surface
npx playwright test <changed_specs>            # UI
node scripts/cli-e2e.mjs <scenario>            # CLI
pytest tests/http/<scenario>.py                # HTTP API
```

Full regression runs only when `workflow-human-check` explicitly requests it.

## Fail routing (producer)

| Cause | Route |
|-------|-------|
| `assertion` | `workflow-coding` |
| `build` | `workflow-coding` |
| `typecheck` | `workflow-coding` |
| `artifact_missing` | `workflow-e2e` (self-rerun with correct runner) |
| `mocked_interface` | `workflow-e2e` (self-rerun without mocks) |
| `insufficient_scenario` | `workflow-e2e-review` signals this; route to coding |

## Relationship to other skills

- `workflow-write-test` — writes RED unit/integration tests. **Not E2E**.
- `workflow-verify` Phase 1 — runs existing test suites. **Not E2E** (that's Phase 3).
- `workflow-verify` Phase 3 — a light-touch E2E smoke reusing this skill's contract. Same real-interface rules apply.
