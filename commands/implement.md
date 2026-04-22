# Smelter: /implement — Feature Development

Run the `implement` mode on $ARGUMENTS. Use for building features on top of existing code, extensions, or incremental additions. Lighter than `/think` (brainstorm is `depth: light`).

Backed by `modes/workflow.yaml → modes.implement`. Pipeline: `full` (13 skills) for new features / refactors / migrations; `extend_light` (9 skills) when target_type is `extend_existing`.

## Task
$ARGUMENTS

## Protocol

1. `scripts/state-schema.mjs` seeds `.smt/features/<slug>/task/<task>.state.json` with `mode: implement`.
2. Entry skill is `workflow-brainstorm` with `depth: light` — a brief interview (scope, constraints, must-not-touch).
3. `extend` magic keyword (e.g., "extend", "add to", "덧붙여") sets `target_type: extend_existing` and routes to `extend_light` — skipping brainstorm, brainstorm-review, tasker-review, and team-code-review.
4. `full` flow (default): brainstorm(light) → brainstorm-review → investigate → investigate-review → tasker → tasker-review → write-test → coding → agent-review → e2e → e2e-review → team-code-review → human-check.
5. `extend_light` flow: investigate → investigate-review → tasker → write-test → coding → agent-review → e2e → e2e-review → human-check.
6. Review skills run **Multi-Pass Verification** (mid_pipeline=2, terminal=3; unchanged for /implement).

## Magic-keyword branches

- `extend` / `add to` / `덧붙여` → `target_type: extend_existing` → `extend_light` pipeline (skips brainstorm + brainstorm-review via target-type dispatch).
- `css` / `style` / `i18n` → `workflow-write-test` TDD-exempt flag.

## When to use /implement vs /think

| Signal | Mode |
|--------|------|
| "Extend existing feature with X" | /implement |
| "Add new feature on top of Y" | /implement |
| "Rework / rewrite / re-architect" | /think (then /implement) |
| "Greenfield / new product" | /think (then /implement) |

`target_type` declared by `workflow-tasker`:
`extend_existing` / `new_feature` / `refactor` / `bug_fix` / `migration`.

## Iron Law

- Iron Law #4 (no retry): failures route via producer chain.
- Iron Law #7: queues are independent per task; specialist agents may be assigned by tasker.
- Scoped testing only (spec §14-3) — no repo-wide `pnpm test` before `workflow-human-check`.

## Auto-routing note

Mode classifier patterns that trigger `/implement`: "build X", "add X", "implement X", "make X", Korean equivalents. Explicit `/implement` overrides.
