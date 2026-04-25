# Smelter: /brainstorm — Ideation & Planning

Run the `brainstorm` mode on $ARGUMENTS. Use when you need to explore ideas, form a design, and produce a plan without writing product code. The experience follows the superpowers brainstorming flow: explore context, ask one question at a time, compare 2-3 approaches, present the design for approval, write the design, self-review it, then hand off to planning. Produces `brainstorm.md` and `tasks.md`; no `src/` changes.

Backed by `modes/workflow.yaml → modes.brainstorm`. Pipeline: `planning_only`.

## Task
$ARGUMENTS

## Protocol

1. `scripts/keyword-detector.mjs` seeds `.smt/features/<slug>/task/<task>.state.json` with `mode: brainstorm`.
2. Entry skill is `workflow-brainstorm` with `depth: deep`.
3. Flow: brainstorm(deep) → brainstorm-review → investigate → investigate-review → tasker → tasker-review. Terminal.
4. `read_only: true` — no workflow-write-test, no workflow-coding, no workflow-e2e.
5. `workflow-brainstorm` must use the superpowers-style checklist: context exploration, optional visual companion offer, one-at-a-time questions, approach comparison, section-by-section design approval, written design self-review, then review handoff.

## Command Contract

- `/brainstorm` is the only canonical planning/design command.
- The retired think command is removed and must not be accepted as an alias or fallback.
- Removed commands should fail closed in routing instead of mapping to `/brainstorm`.

## When to use /brainstorm vs /implement

| Signal | Mode |
|--------|------|
| "Figure out what we should build" | /brainstorm |
| "Plan the migration before touching code" | /brainstorm |
| "Extend an existing feature with X" | /implement |
| "Build this feature end-to-end" | /implement |

Once `brainstorm` completes, its artifacts (`brainstorm.md`, `tasks.md`) are consumed by `/implement`.
