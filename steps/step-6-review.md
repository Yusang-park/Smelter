# Step 6: Local Agent Review

## Goal
Get immediate quality feedback from specialized review agents. Fix findings before broader tests.

## Actions
1. Invoke `code-reviewer` on all changed files
2. Invoke `security-reviewer` if changes touch: auth, input validation, secrets, network I/O, file I/O
3. Record findings in `features/<slug>/decisions.md` under `## Risks`
4. Fix CRITICAL + HIGH issues immediately

## Agents
- `code-reviewer` (sonnet) — always
- `security-reviewer` (sonnet) — conditional on surface

## Repeat
Up to 3 rounds of fix → re-review.

## On fail (by category)
- `code_quality` → step-5 (fix and retry)
- `bug` → step-5
- `security` → step-5 (CRITICAL only)
- `plan_mismatch` → step-3 (plan was wrong)
- `edge_case` → step-3 (add tasks for missed cases)

## Gate
- 0 CRITICAL findings
- 0 HIGH findings (or justified in `decisions.md`)
- MEDIUM findings documented, deferred to follow-up if acceptable

## Next
→ step-7 (Utility Test)
