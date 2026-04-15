# Step 5: Implementation

## Goal
Make the RED tests GREEN with minimal code. Then refactor.

## Actions
1. Write the smallest change that turns RED tests GREEN
2. Run tests — verify GREEN
3. Refactor for clarity (tests must stay GREEN)
4. Prefer `Edit` over `Write` — incremental changes
5. No "while I'm here" scope creep — extras become new tasks via `/tasker`

## Agents
- `executor` (sonnet) — standard implementation
- `executor-high` (opus) — multi-file refactors
- `designer` (sonnet) — UI/frontend
- `build-fixer` (sonnet) — when build breaks

## Gate
- `tests_green`: all tests from Step 4 pass
- `tsc --noEmit` → 0 errors (for TypeScript)
- No `TODO` / `FIXME` added in changed files

## Retry budget
- `max_retry: 3`
- On 3 consecutive failures → `on_max_retry: step-2` (approach is wrong)

## On fail
Diagnose: missing dependency? misread spec? subtle bug? Adjust and retry within budget.

## Next
→ step-6 (Local Agent Review)
