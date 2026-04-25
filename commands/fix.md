# Smelter: /fix — Bug & Logic Repair

Run the `fix` mode on $ARGUMENTS. Use for bug fixes, regressions, and logic-flow changes that require investigation before the repair. The experience follows superpowers systematic debugging: reproduce, gather evidence, identify root cause, write a failing regression test, then fix the root cause.

Backed by `modes/workflow.yaml → modes.fix`. Default pipeline `fix` (8 skills); `fix_simple` (4 skills) routes to exactly two surfaces — `text` (텍스트 수정) and `design` (디자인 수정). Extensions / new features / refactors escalate out of `/fix` to `/implement` or `/brainstorm`.

## Task
$ARGUMENTS

## Protocol

1. `scripts/state-schema.mjs` seeds `.smt/features/<slug>/task/<task>.state.json` with `mode: fix` and default pipeline `fix`.
2. Entry skill is `workflow-investigate`. No shortcut to coding.
3. `fix` flow (default): investigate → investigate-review → write-test → coding → agent-review → e2e → e2e-review → human-check. No tasker, no team-code-review.
4. `fix_simple` flow (only `target_type ∈ {text, design}`): investigate → coding → e2e → human-check.
5. `workflow-agent-review` uses Pattern B (code-reviewer + security-reviewer).

## Debugging contract

- No fixes before root cause evidence.
- Reproduce consistently when feasible; if not reproducible, record what data is missing and add targeted diagnostics rather than guessing.
- Check recent changes, working examples, and comparable code paths before choosing a fix.
- Form one hypothesis at a time and test it with the smallest useful observation.
- The RED test must reproduce the original bug or prove the expected corrected behavior.
- If three distinct fix attempts fail, stop patching and route back to planning or architecture review.

## Review rounds

- Every review skill uses the same **2 rounds**: omission and contradiction.
- There is no `/fix`-specific round override.

Configured under `modes/workflow.yaml → verification_rounds.rounds`.

## Surface-based exemption

| Surface | E2E | TDD |
|---------|-----|-----|
| Bug fix with testable logic | yes if interface | required |
| Existing-feature behavior change | yes if user-visible | required |
| New logic | yes if interface | required |

Trivial text/CSS/i18n/config-only changes stay in `/fix` but get surface-based TDD exemption (see `document/workflow.md` §7-4). `workflow-investigate` records `target_type` + `exempt` flags so downstream stages skip TDD/E2E when appropriate.

## Magic-keyword branches

- `fix` / `bug` / `버그` / `문제` → `target_type=bug_fix` → default `fix` pipeline (E2E forced on for interface surface)
- `typo` / `dialogue` / `text` / `텍스트` / `copy` / `i18n` → `target_type=text` → `fix_simple` (tdd + e2e exempt)
- `css` / `style` / `design` / `디자인` → `target_type=design` → `fix_simple` (tdd exempt; e2e kept for visual check)

`fix_simple` is pinned to exactly these two surfaces (`text`, `design`). No other target_type routes there.

## Iron Law

- No completion claim without fresh evidence (Iron Law #5)
- No retry; failures route via producer chain (Iron Law #4)
- Do NOT delete failing tests to pass (watchdog rule #1)
- Do NOT silently widen scope (watchdog rule #7) — new scope → `workflow-human-check` mode upgrade to `/implement` or new task via `/brainstorm`
- Scoped testing only (spec §14-3) — no repo-wide `pnpm test` before `workflow-human-check`

## Auto-routing note

Mode classifier patterns that trigger `/fix`: "fix the bug", "broken", "error", "not working", "regression", Korean equivalents. Explicit `/fix` overrides.
