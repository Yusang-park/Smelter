# Step 4: Test Design (TDD)

## Goal
Write tests FIRST. Verify they fail (RED) before any implementation.

## Actions
1. For each task, write minimum 10 tests per task surface:
   - Happy path (3+)
   - Boundary conditions (2+)
   - Error cases (2+)
   - Edge cases (2+)
   - Integration (1+)
2. Test file MUST be created before any source file
3. Run tests — they MUST fail with a meaningful error (not "not implemented")
4. Commit: `test: add failing tests for <task>` (optional, TDD checkpoint)

## Exemption (qa mode only)
Skip TDD if change surface is:
- CSS / style / typography
- i18n / copy-only
- Typo in comments/docs
- Pure dialogue (no code change)

Record `TDD: exempt (<reason>)` in `features/<slug>/decisions.md`.

## Agents
- `tdd-guide` (sonnet) — enforces test-first discipline

## Gate
- `tests_exist_and_red`: tests are in place AND failing
- 10+ tests per non-exempt task

## On fail
- If tests green before implementation: they're testing the wrong thing. Rewrite.
- If tests can't be written: the plan is wrong. Return to step-3.

## Next
→ step-5 (Implementation)
