# Step 9: Team Code Review

## Goal
3-agent consensus review (advocate / critic / arbitrator) until 95% agreement. Final quality gate before human review.

## Actions
1. Spawn three agents in parallel:
   - `advocate` — argues for merging as-is
   - `critic` — argues against, finds issues
   - `arbitrator` — weighs both sides, decides
2. Collect verdict: CRITICAL / HIGH / MEDIUM / LOW / NONE
3. Iterate until 95% consensus (max 3 rounds)

## Agents
- `code-reviewer` (opus) as advocate
- `critic` (opus) as critic
- `architect` (opus) as arbitrator

## Consensus threshold
95%

## On fail (by severity)
- `critical` → step-3 (plan was fundamentally wrong)
- `high` → step-3 (significant rework needed)
- `medium` → step-5 (implementation fix)
- `low` → continue (log in `decisions.md` as known limitation)

## Skip condition
Not run in qa mode (simpler review in step-6 is sufficient).

## Next
→ step-10 (Human Review)
