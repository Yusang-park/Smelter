# Smelter: /verify — Non-modifying Verification

Run the `verify` mode on $ARGUMENTS. Use for **점검** (health check) and **테스트** (run tests) without modifying the codebase. The experience follows superpowers verification-before-completion: evidence before claims, fresh command output before any pass/fail statement, and a report the user can inspect.

Backed by the Archon-native `smelter-verify` workflow. Allowed workflow skills: `workflow-verify`, `workflow-e2e`, `workflow-e2e-review`, `workflow-human-check`.

## Task
$ARGUMENTS

## Protocol

1. Archon creates a workflow run and `$ARTIFACTS_DIR`.
2. Entry node uses `workflow-verify` — records verification concerns before real-interface execution:
   - **Phase 1: Test code execution** (vitest/jest/pytest, scoped)
   - **Phase 2: Code logic inspection** (tsc, eslint, doc-sync)
   - **Phase 3: E2E interface scope** (surfaces/scenarios for `workflow-e2e`)
3. Output: `verify_report.md` with test/static results and E2E scope requirements.
4. `workflow-e2e` drives the real interface for any required surface and captures artifacts.
5. `workflow-e2e-review` verifies artifacts and effect evidence.
6. `workflow-human-check` finalizes. If verification found failures, missing evidence, or blockers, it must summarize those findings and ask a problem-focused native `AskUserQuestion` (`rework` / `hold` / `upgrade`) before any completion or commit options are offered.

## When to use

| Signal | Mode |
|--------|------|
| "테스트 해봐 / 돌려봐 / 실행해봐" | /verify |
| "점검해봐 / health check" | /verify |
| "run the tests" / "run verification" | /verify |
| "테스트하고 문제 있으면 고쳐" | /verify → /fix (auto-chain) |
| "점검 후 수정해" | /verify → /fix (auto-chain) |
| "맥락 파악해" / "검증해봐" (static read) | `/explore` (not `/verify`) |

## Does NOT do

- Never modifies source code or test files. Strictly read + execute + report.
- Does not run Multi-Pass Verification (that's for review skills). One invocation = one report.
- Does not write new tests (that's `workflow-write-test` under `/fix` or `/implement`).

## Evidence-before-claims

- Do not claim tests, lint, build, E2E, or health checks pass before running the proving command in the current verification flow.
- Read the full output and record exit codes, counts, failures, and artifact paths.
- If evidence is partial, say exactly what was verified and what remains unverified.

## Iron Law

- Iron Law #1: the report is always produced (even on total failure). Session never halts here.
- Iron Law #4: no retry. If Phase 1 fails, the report captures it; routing is via producer chain + mode upgrade.
- Scoped testing (§14-3) — Phase 1 defaults to changed-file scope. Full regression only on explicit user request.

## Auto-routing

Mode classifier patterns that trigger `/verify`: "테스트 해봐", "돌려봐", "점검해봐", "실행해봐", "run the tests", "run verification", "health check". Explicit `/verify` overrides the classifier.

Compound intents chain:
- "테스트하고 수정해" → `chained_modes: ['verify', 'fix']`
- "점검하고 문제 있으면 고쳐" → `chained_modes: ['verify', 'fix']`
