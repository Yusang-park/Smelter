# Step 7: Utility Test (Scoped)

## Goal
Run the scoped unit/integration test suite on changed files. Ensure no regressions.

## Actions
1. Identify changed files: `git diff --name-only`
2. Run tests intersecting those files:
   - `npm test -- --testPathPattern="<area>"`
   - `pytest tests/test_<module>.py`
   - `go test ./<pkg>/...`
3. Run typecheck: `tsc --noEmit`
4. Run linter: `eslint .` / `ruff check` if configured
5. Run build if build-affecting

## Scope
**Do NOT run the full suite.** Scope to changed files only. Full-suite runs happen in CI or explicit user request.

## Gate
- `tests_pass_and_build_clean`:
  - All scoped tests pass
  - `tsc --noEmit` → 0 errors
  - Linter clean (or findings documented)
  - Build succeeds (if applicable)

## On fail
→ step-5 (fix and retry)

## Next
→ step-8 (E2E Validation)
