# Smelter: /verify — Non-modifying Verification

Run the `verify` mode on $ARGUMENTS. Use for **점검** (health check) and **테스트** (run tests) without modifying the codebase. Produces a single `verify_report.md` covering tests + static inspection + E2E interface.

Backed by `modes/verify.json`. Allowed workflow skills: `workflow-verify`, `workflow-e2e`, `workflow-e2e-review`, `workflow-human-check`.

## Task
$ARGUMENTS

## Protocol

1. `scripts/state-schema.mjs` seeds `.smt/features/<slug>/task/<task>.state.json` with `mode: verify`, `exempt.tdd: true`.
2. Entry skill is `workflow-verify` — runs three phases in one invocation:
   - **Phase 1: Test code execution** (vitest/jest/pytest, scoped)
   - **Phase 2: Code logic inspection** (tsc, eslint, state-schema, doc-sync)
   - **Phase 3: E2E interface** (Playwright / API / CLI per 5-Surface Mapping)
3. Output: `verify_report.md` with all three sections + a summary verdict.
4. If the report verdict is `fail`, the workflow surfaces a `/fix` mode-upgrade suggestion.
5. `workflow-human-check` finalizes — user confirms or initiates rework via mode upgrade.

## When to use

| Signal | Mode |
|--------|------|
| "테스트 해봐 / 돌려봐 / 실행해봐" | /verify |
| "점검해봐 / health check" | /verify |
| "run the tests" / "run verification" | /verify |
| "테스트하고 문제 있으면 고쳐" | /verify → /fix (auto-chain) |
| "점검 후 수정해" | /verify → /fix (auto-chain) |
| "맥락 파악해" / "검증해봐" (static read) | /investigate (not /verify) |

## Does NOT do

- Never modifies source code or test files. Strictly read + execute + report.
- Does not run Multi-Pass Verification (that's for review skills). One invocation = one report.
- Does not write new tests (that's `workflow-write-test` under `/fix` or `/implement`).

## Iron Law

- Iron Law #1: the report is always produced (even on total failure). Session never halts here.
- Iron Law #4: no retry. If Phase 1 fails, the report captures it; routing is via producer chain + mode upgrade.
- Scoped testing (§14-3) — Phase 1 defaults to changed-file scope. Full regression only on explicit user request.

## Auto-routing

Mode classifier patterns that trigger `/verify`: "테스트 해봐", "돌려봐", "점검해봐", "실행해봐", "run the tests", "run verification", "health check". Explicit `/verify` overrides the classifier.

Compound intents chain:
- "테스트하고 수정해" → `chained_modes: ['verify', 'fix']`
- "점검하고 문제 있으면 고쳐" → `chained_modes: ['verify', 'fix']`
