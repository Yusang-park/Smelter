---
name: workflow-verify
version: 0.51
type: workflow
consumes: current codebase (no RED requirement)
produces: verify_report.md
default_pattern: A
default_agent: qa-tester
supports_patterns: [A, C]
team_template:
  C:
    parallel_split_by: phase
    agents: [qa-tester, code-reviewer, qa-tester]
    aggregator: arbitrator
    sync_point: verify_report.md
can_delegate_to: [e2e-testing-patterns, tdd-guide]
gate:
  postcondition:
    - file_exists: "verify_report.md"
    - all_phases_reported: true
---

# workflow-verify

## Overview

Non-modifying verification of the current codebase. Runs test and static verification, records E2E scope requirements, and produces `verify_report.md`. Used as the entry skill of `/verify` mode before the pipeline proceeds to `workflow-e2e`, `workflow-e2e-review`, and `workflow-human-check`.

**Core principle:** Evidence before claims. A pass/fail statement is only valid after the proving command or artifact has been freshly produced and read.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-verify to run tests + static checks, record E2E scope, and produce `verify_report.md` before real-interface verification."

## The Iron Law

```
NO VERIFY CLAIM WITHOUT FRESH EVIDENCE
```

The skill completes when `verify_report.md` exists with fresh Phase 1 and Phase 2 evidence plus a Phase 3 E2E scope section that tells `workflow-e2e` what real interface must be exercised. Skipping evidence = gate fail.

## Verification concerns

### Phase 1 — Test code execution
Run the project's existing test suites, scoped to the changed surface when possible.

```bash
# scoped unit / integration (example — adapt per project)
pnpm vitest run <changed_test_files>

# or pytest, jest, go test — whatever the repo ships
```

Record pass/fail counts, failing case names, error snippets.

### Phase 2 — Code logic inspection (static)
Run static analyzers to catch logic issues without executing the code.

```bash
pnpm typecheck            # or: tsc --noEmit
pnpm lint                 # eslint / prettier
node scripts/feature-version-check.mjs report   # state schema integrity
node scripts/session-end.mjs --dry              # forbidden-reference scan
```

Record: typecheck errors, lint violations, state-schema drift, doc-sync issues.

### Phase 3 — E2E interface scope

> **Phase 3 is NOT satisfied by a test-runner command.** Phase 1 already ran test code.
> This skill records which real interfaces must be exercised. The next pipeline stage, `workflow-e2e`, drives those interfaces and captures artifacts.

Record the actual interface that users / callers / clients touch. Every required surface must later produce an artifact file under `.smt/features/<slug>/artifacts/`. Zero-artifact E2E runs fail in `workflow-e2e` / `workflow-e2e-review`.

| Surface | Real interface | Required artifact |
|---------|----------------|-------------------|
| UI / Frontend | Real browser, Playwright launched | video (.webm) + screenshots (.png) |
| CLI / Script | Real subprocess (stdin, argv, exit code) | command transcript (argv + stdin + stdout + stderr + exit) |
| HTTP API | Real server on a real port + real fetch/curl | request/response log (method, path, status, body, timing) |
| Database | Real DB engine | query log + before/after state samples |
| Hook script | Real `cat payload \| node hook.mjs` | input/output JSON samples + exit code |

Disallowed in Phase 3:
- Calling an internal handler function directly instead of through the interface.
- Mocking the interface under test (MSW for the HTTP surface, stubs for the DB driver, etc.).
- Running only `pnpm test` / `vitest run` — that's Phase 1.
- Recording only an acknowledgement signal (toast, banner, modal close, spinner idle, HTTP 2xx, exit code 0) without separately asserting the target effect that was supposed to materialize.

Phase 3 hands off to the full `workflow-e2e` real-interface contract, including the Effect-vs-Ack rule and `state.json.scenarios[].effect_evidence` requirement. A run with artifacts but no effect evidence still fails downstream E2E review.

Scope by the changed surface; full regression only on explicit user request (`workflow-human-check`).

## Output — `verify_report.md`

```markdown
## Phase 1 — Tests
- runner: <vitest | jest | pytest | ...>
- scope: <paths>
- total: <N>  pass: <n>  fail: <m>
- failures:
  - <case_name> — <file:line> — <error excerpt>

## Phase 2 — Static Inspection
- typecheck: <pass | N errors>
- lint: <pass | N violations>
- state-schema: <pass | orphan features>
- doc-sync: <pass | drift items>

## Phase 3 — E2E Interface
- required surfaces: <ui | cli | api | db | hook | none>
- required scenarios: <...>
- artifact status: pending workflow-e2e | exempt with reason

## Summary verdict
- Result: pass | fail
- If fail → suggested next mode: /fix (for bugs or trivial fixes; surface exemptions cover CSS/copy/typo)
```

## Pass / fail semantics

The skill itself **completes** as soon as tests/static checks have run, E2E scope has been recorded, and the report file exists. "Pass" vs "fail" in the report is an **evaluation of the codebase evidence so far**, not permission to skip downstream E2E or human-check.

- Skill `pass` (hook gate): `verify_report.md` exists with Phase 1, Phase 2, and Phase 3 E2E-scope sections.
- Report verdict = `pass_so_far`: zero Phase 1 failures and zero Phase 2 errors; E2E still proceeds when a surface is required.
- Report verdict = `fail`: any Phase 1 or Phase 2 failure → the report's `suggested next mode` drives routing after the user decision.

## Fail routing (producer chain)

- `test_run` cause → `workflow-coding` (tests broke; fix code) → likely `whitelist_violation` in `/verify` mode → mode upgrade to `/fix` (or chain auto-advance)
- `typecheck` / `lint` / `build` cause → same: mode upgrade to `/fix`
- `assertion` cause (e2e) → same
- `file_absent` (verify_report.md missing) → self-rerun

## Iron Law compliance

- Never modifies source code or tests. Strictly read + execute + report.
- Never halts — emits a report even if phases fail.
- No retries — one pass per invocation; routing on fail.

## Scope exemption

`exempt.tdd == true` (mode default) → skips writing **new** tests, but still runs existing ones in Phase 1. `exempt.e2e == false` by default → E2E Phase 3 is mandatory unless tasker explicitly flags the change as having no interface surface.

## Multi-Pass Verification

This is **not** a review skill. It does not run Multi-Pass rounds. One invocation = one report.

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "Phase 1 passed, report clean" | Report needs tests, static checks, and E2E scope. Downstream E2E still runs when required. |
| "Phase 3 is just like `pnpm test`" | Phase 3 is real-interface E2E, not a test runner. `pnpm test` is Phase 1. Phase 3 requires artifacts. |
| "Ack signal is enough for Phase 3" | Phase 3 inherits `workflow-e2e`'s Effect-vs-Ack rule. Ack alone fails. |
| "I'll skip Phase 2 if Phase 1 passed" | Typecheck / lint / state-schema / doc-sync catch different bugs than tests. |
| "Looks good" | Looks good is not evidence. Run the command, read the output, record the result. |
| "One failure means I should modify tests to make them pass" | `workflow-verify` NEVER modifies source or tests. It reads + runs + reports only. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "No interface surface, skip Phase 3" | Tasker decides `exempt.e2e`. If not declared exempt, run Phase 3. |
| "Full regression would take too long" | Scoped by changed surface. Full regression is only on `workflow-human-check` request. |
| "I already ran this last session" | Re-run. Session-local state is irrelevant; `verify_report.md` must be fresh. |

## Terminal State — Required Next Skill

**Skill completes** when `verify_report.md` exists with tests, static inspection, and E2E scope sections. The required next skill is determined by the `/verify` pipeline.

| Report verdict | Next action |
|----------------|-------------|
| `pass_so_far` with E2E required | `workflow-e2e` |
| `pass_so_far` with no interface surface | `workflow-human-check` may summarize the no-E2E rationale |
| `fail` with bug / regression | Continue to human-check with suggested mode upgrade to `/fix` unless the active chain explicitly routes recovery |
| `fail` with trivial diff (typo / CSS / copy) | Suggest `/fix` with surface exemption |
| `file_absent` (report missing) | Self-rerun |

`/verify` is read-only by design. It does not chain into implementation skills. Mode upgrade to `/fix` is an explicit user decision, not an automatic source-edit transition.

Do NOT:
- Modify source code or tests to "fix" phase failures within this skill
- Invoke `workflow-coding` directly — that is a mode upgrade decision
- Skip producing `verify_report.md` because "all passed locally"
- Stop after `verify_report.md` when `workflow-e2e` or `workflow-human-check` remains in the active pipeline
