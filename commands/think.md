# Smelter: /think — Ideation & Planning

Run the `think` mode on $ARGUMENTS. Use when you need to explore ideas, form a design, and produce a plan — **without writing code**. Produces `brainstorm.md` and `tasks.md`; no src/ changes.

Backed by `modes/workflow.yaml → modes.think`. Pipeline: `planning_only`.

## Task
$ARGUMENTS

## Protocol

1. `scripts/keyword-detector.mjs` seeds `.smt/features/<slug>/task/<task>.state.json` with `mode: think`.
2. Entry skill is `workflow-brainstorm` with `depth: deep` — a structured Socratic interview on purpose, constraints, success criteria, and approaches.
3. Flow: brainstorm(deep) → brainstorm-review → investigate → investigate-review → tasker → tasker-review. Terminal.
4. Review skills run **Multi-Pass Verification** (3 rounds per spec §9-3).
5. `read_only: true` — the `exempt.tdd` and `exempt.e2e` flags are set; no workflow-write-test, no workflow-coding, no workflow-e2e.

## When to use /think vs /implement

| Signal | Mode |
|--------|------|
| "Figure out what we should build" | /think |
| "Plan the migration before touching code" | /think |
| "Extend an existing feature with X" | /implement |
| "Build this feature end-to-end" | /implement |

Once `think` completes, its artifacts (`brainstorm.md`, `tasks.md`) are consumed by `/implement` — **which resumes from `workflow-write-test`** (file-driven routing skips already-produced phases).

## Iron Laws

- Iron Law #5 (file is truth): `tasks.md` must exist and pass tasker-review before the mode is considered complete.
- Iron Law #4 (no retry): review failures route via producer chain.

## Auto-routing note

Mode classifier triggers `/think` on utterances like: "plan X", "design X", "figure out how to X", "설계해줘", "계획부터". Explicit `/think` overrides.
