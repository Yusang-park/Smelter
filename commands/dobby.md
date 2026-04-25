# Smelter: /dobby — Free-form (no pipeline)

Run the `dobby` mode on $ARGUMENTS. Use when you want to edit code WITHOUT running a workflow pipeline. The ONLY gate is `workflow-human-check` — user review before commit.

Backed by `modes/workflow.yaml → modes.dobby`. Pipeline: `dobby_only` (1 skill).

## Task
$ARGUMENTS

## Protocol

1. `scripts/state-schema.mjs` seeds `.smt/features/<slug>/task/<task>.state.json` with `mode: dobby`, `task_type: freeform`, `step: EXECUTE`, and `allowed_skills: [workflow-human-check]`.
2. No investigate / tasker / write-test / coding-review / e2e / agent-review stages run — edit code directly while the freeform `EXECUTE` guard is active.
3. When edits are complete, invoke `workflow-human-check` to present a diff and await the user's pass verdict.
4. `git commit` is blocked by `pre-tool-enforcer.mjs` until `workflow-human-check` records a pass event.

## When to use

- Trivial mechanical edits where the full `/fix` workflow is overkill.
- User has already decided the approach and only wants the change applied + reviewed.
- Exploratory code changes the user wants to eyeball before committing.

## When NOT to use

- New features or refactors (use `/implement` or `/brainstorm`).
- Bug fixes where investigation is required (use `/fix`).
- Anything where TDD / E2E / multi-agent review would catch defects the human might miss.

## Iron Law

- Iron Law #1 — still applies. Do NOT claim completion without a `workflow-human-check` pass event.
- `git commit` gate is preserved: user must explicitly approve via `workflow-human-check` before commit.
- TDD (Rule 5) exempt by mode default — user owns correctness.
- Freeform source edits are allowed only in `step: EXECUTE`; if state is not in EXECUTE, reseed `/dobby` instead of bypassing the guard.

## Auto-routing note

`/dobby` is slash-only. The natural-language mode classifier does NOT route to `dobby` — invoking the escape hatch must be explicit.
