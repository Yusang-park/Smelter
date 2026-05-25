# Tasks: {{FEATURE_NAME}}

> Human-readable task checklist for this session.
> Machine-owned automation state lives in `.smt/features/<slug>/state/summary.json`.
> Rule: NEVER mark complete without passing tests.

## Ownership
- `tasks.md` / `task/*.md` → human-readable planning and execution checklist
- `state/workflow.json` → step engine state
- `state/summary.json` → hook/automation summary state (`e2e_required`, `e2e_done`, `tests_pass`, `current_step`, etc.)

## Summary JSON example
```json
{
  "surface": ["hook"],
  "e2e_required": true,
  "e2e_done": false,
  "tests_pass": false,
  "current_step": "step-4",
  "status": "in_progress"
}
```

## Checklist policy
- Human checkboxes may remain in this document.
- Hooks should not parse this whole file as the automation source of truth when `summary.json` is available.


## Status Legend
- [ ] = pending
- [~] = in progress  
- [x] = done (tests passing)
- [!] = blocked

---

## Phase 1: Setup

- [ ] Task 1

## Phase 2: Implementation

- [ ] Task 2

## Phase 3: Tests (TDD — write BEFORE implementation)

- [ ] Write unit tests
- [ ] Write integration tests
- [ ] Run RED (tests must fail first)
- [ ] Implement to GREEN
- [ ] Write E2E tests

## Phase 4: Completion Checklist

- [ ] Unit tests passing
- [ ] Integration tests passing (if applicable)
- [ ] E2E tests passing
- [ ] `tsc --noEmit` clean
- [ ] tasks.md fully checked

---
Created: {{DATE}}
Last updated: {{DATE}}
