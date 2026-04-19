# Smelter: /implement — Lightweight Build on Existing Code

Run the `implement` mode on $ARGUMENTS. Use for building features on top of existing code, extensions, or incremental additions. Lighter than `/plan` (brainstorm is `depth: light`).

Backed by `modes/implement.json`. Allowed workflow skills: full 13-skill pipeline.

## Task
$ARGUMENTS

## Protocol

1. `scripts/state-schema.mjs` seeds `.smt/features/<slug>/task/<task>.state.json` with `mode: implement`.
2. Entry skill is `workflow-brainstorm` with `depth: light` — a brief interview (scope, constraints, must-not-touch).
3. `extend` magic keyword (e.g., "extend", "add to", "덧붙여") SKIPS brainstorm.
4. Flow: brainstorm(light) → brainstorm-review → investigate → investigate-review → tasker → tasker-review → write-test → coding → agent-review → e2e → e2e-review → team-code-review → human-check.
5. Review skills (brainstorm-review, investigate-review, tasker-review, agent-review, e2e-review, team-code-review) run **Multi-Pass Verification** (3 rounds per spec §9-3).

## Magic-keyword branches

- `extend` / `add to` / `덧붙여` → SKIP `workflow-brainstorm` (Protocol step 3)
- `css` / `style` / `i18n` → `workflow-write-test` TDD-exempt flag (per `modes/implement.json.magic_keywords`)

## When to use /implement vs /plan

| Signal | Mode |
|--------|------|
| "Extend existing feature with X" | /implement |
| "Add new feature on top of Y" | /implement |
| "Rework / rewrite / re-architect" | /plan |
| "Greenfield / new product" | /plan |

`target_type` declared by `workflow-tasker`:
`extend_existing` / `new_feature` / `refactor` / `bug_fix` / `migration`.

## Iron Law

- Iron Law #4 (no retry): failures route via producer chain.
- Iron Law #7: queues are independent per task; specialist agents may be assigned by tasker.
- Scoped testing only (spec §14-3) — no repo-wide `pnpm test` before `workflow-human-check`.

## Auto-routing note

Mode classifier patterns that trigger `/implement`: "build X", "add X", "implement X", "make X", Korean equivalents. Explicit `/implement` overrides.
