# Smelter: /fix — Bug & Logic Repair

Run the `fix` mode on $ARGUMENTS. Use for bug fixes, regressions, and logic-flow changes that require investigation before the repair. The experience follows superpowers systematic debugging: reproduce, gather evidence, identify root cause, write a failing regression test, then fix the root cause.

Backed by the Archon-native `smelter-fix` workflow. The default fix path records a compact `tasks.md` checklist before coding. Extensions / new features / refactors escalate out of `/fix` to `/implement` or `/brainstorm`.

## Task
$ARGUMENTS

## Protocol

1. Archon creates a workflow run and `$ARTIFACTS_DIR`.
2. Entry node uses `workflow-investigate`. No shortcut to coding.
3. `fix` flow (default): investigate → investigate-review → tasker → tasker-review → write-test → coding → agent-review → e2e → e2e-review → human-check. No team-code-review.
4. `workflow-agent-review` uses Pattern B (code-reviewer + security-reviewer).

## Debugging contract

- No fixes before root cause evidence.
- Reproduce consistently when feasible; if not reproducible, record what data is missing and add targeted diagnostics rather than guessing.
- Check recent changes, working examples, and comparable code paths before choosing a fix.
- Form one hypothesis at a time and test it with the smallest useful observation.
- The RED test must reproduce the original bug or prove the expected corrected behavior.
- The compact task checklist must mark works, omissions, verified, and team runtime before coding on the default `fix` path.
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

Trivial text/CSS/i18n/config-only changes stay in `/fix` but get surface-based TDD exemption. `workflow-investigate` records `target_type` + `exempt` flags in artifacts so downstream stages can skip TDD/E2E when appropriate.

## Magic-keyword branches

- `fix` / `bug` / `버그` / `문제` → `target_type=bug_fix` → default `fix` pipeline (E2E forced on for interface surface)
- `typo` / `dialogue` / `text` / `텍스트` / `copy` / `i18n` → `target_type=text` and document TDD/E2E exemption in artifacts.
- `css` / `style` / `design` / `디자인` → `target_type=design`; keep visual E2E when user-visible.

## Iron Law

- No completion claim without fresh evidence (Iron Law #5)
- No retry; failures route through Archon node rework (Iron Law #4)
- Do NOT delete failing tests to pass (watchdog rule #1)
- Do NOT silently widen scope (watchdog rule #7) — new scope → `workflow-human-check` mode upgrade to `/implement` or new task via `/brainstorm`
- Scoped testing only (spec §14-3) — no repo-wide `pnpm test` before `workflow-human-check`

## Auto-routing note

Mode classifier patterns that trigger `/fix`: "fix the bug", "broken", "error", "not working", "regression", Korean equivalents. Explicit `/fix` overrides.
