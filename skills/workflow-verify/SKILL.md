---
name: workflow-verify
version: 2.4.1
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

Non-modifying verification of the current codebase. Runs three phases in a single skill invocation and produces one consolidated report. Used as the entry skill of `/verify` mode.

## Three phases (all mandatory)

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

### Phase 3 — E2E interface verification

> **Phase 3 is NOT a test-runner phase.** Phase 1 already ran test code.
> Phase 3 exercises the **real interface** per `workflow-e2e` (§8 of `document/workflow.md`).

Drive the actual interface that users / callers / clients touch. Every exercised surface must produce an artifact file under `.smt/features/<slug>/artifacts/`. Zero-artifact runs fail this phase.

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

Phase 3 inherits the full `workflow-e2e` real-interface contract, including the Effect-vs-Ack rule and `state.json.scenarios[].effect_evidence` requirement. A run with artifacts but no effect evidence still fails Phase 3.

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
- surfaces exercised: <ui | cli | api | db | hook>
- scenarios: <...>
- artifacts:
  - <path>

## Summary verdict
- Result: pass | fail
- If fail → suggested next mode: /fix (for bugs) / /simple-fix (for trivial fixes)
```

## Pass / fail semantics

The skill itself **completes** as soon as all three phases have run and the report file exists. "Pass" vs "fail" in the report is an **evaluation of the codebase**, not of the skill.

- Skill `pass` (hook gate): `verify_report.md` exists with all three phase sections.
- Report verdict = `pass`: zero phase-1 failures, zero phase-2 errors, zero phase-3 assertion failures.
- Report verdict = `fail`: any failure in any phase → the report's `suggested next mode` drives routing.

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
