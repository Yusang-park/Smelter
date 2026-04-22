# Smelter: /fix — Bug & Logic Repair

Run the `fix` mode on $ARGUMENTS. Use for bug fixes, regressions, and logic-flow changes that require investigation before the repair.

Backed by `modes/workflow.yaml → modes.fix`. Default pipeline `fix` (8 skills); `fix_simple` (4 skills) for typo/dialogue. Extensions / new features / refactors escalate out of `/fix` to `/implement` or `/think`.

## Task
$ARGUMENTS

## Protocol

1. `scripts/state-schema.mjs` seeds `.smt/features/<slug>/task/<task>.state.json` with `mode: fix` and default pipeline `fix`.
2. Entry skill is `workflow-investigate`. No shortcut to coding.
3. `fix` flow (default): investigate → investigate-review → write-test → coding → agent-review → e2e → e2e-review → human-check. No tasker, no team-code-review.
4. `fix_simple` flow (typo/dialogue): investigate → coding → e2e → human-check.
5. `workflow-agent-review` uses Pattern B (code-reviewer + security-reviewer).

## Review rounds — /fix mode override

- All mid-pipeline reviews: **1 round** (omission only). Scope is narrow; terminal gates catch escapes.
- `workflow-e2e-review`: **2 rounds** (preserves visual + edge_case checks).
- `workflow-human-check`: **3 rounds** (user gate, unchanged).

Configured under `modes/workflow.yaml → verification_rounds.mode_overrides.fix`.

## Surface-based exemption

| Surface | E2E | TDD |
|---------|-----|-----|
| Bug fix with testable logic | yes if interface | required |
| Existing-feature behavior change | yes if user-visible | required |
| New logic | yes if interface | required |

Trivial text/CSS/i18n/config-only changes stay in `/fix` but get surface-based TDD exemption (see `document/workflow.md` §7-4). `workflow-investigate` records `target_type` + `exempt` flags so downstream stages skip TDD/E2E when appropriate.

## Magic-keyword branches

- `fix` / `bug` / `버그` / `문제` → E2E forced on for interface surface
- Magic keywords `css` / `style` / `텍스트` / `i18n` in `/fix` context do NOT auto-exempt TDD (logic change implied). Author may explicitly mark surface.

## Iron Law

- No completion claim without fresh evidence (Iron Law #5)
- No retry; failures route via producer chain (Iron Law #4)
- Do NOT delete failing tests to pass (watchdog rule #1)
- Do NOT silently widen scope (watchdog rule #7) — new scope → `workflow-human-check` mode upgrade to `/implement` or new task via `/plan`
- Scoped testing only (spec §14-3) — no repo-wide `pnpm test` before `workflow-human-check`

## Auto-routing note

Mode classifier patterns that trigger `/fix`: "fix the bug", "broken", "error", "not working", "regression", Korean equivalents. Explicit `/fix` overrides.
