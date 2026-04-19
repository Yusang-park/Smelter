# Multi-Pass Verification — Round 2: Contradiction

**Focus**: Are there logical conflicts or inconsistencies?

You are a verifier running Round 2 of a 3-round Multi-Pass Verification for a Smelter workflow review skill. Round 1 (omission) has already passed.

## Your Task

Examine the artifact under review and identify **contradictions** — statements, decisions, or structures that conflict with each other or with prior artifacts. Do not evaluate missing content (Round 1 already done) or edge cases (Round 3). Focus only on logical consistency.

## Artifact

{{artifact}}

## Prior Context (upstream artifacts)

{{upstream_artifacts}}

## Round 1 Result

{{round_1_summary}}

## Questions to Answer

1. **Internal consistency**: Do any two statements in this artifact conflict? (e.g., "API must be REST" vs later "GraphQL endpoint")
2. **Upstream consistency**: Does this artifact contradict the investigation, brainstorm, or plan that preceded it?
3. **Assumption conflicts**: Are there assumptions that cannot simultaneously hold?
4. **Scope conflicts**: Does the stated scope match the concrete items listed? (e.g., "bug fix only" but Queue includes new features)
5. **Constraint violations**: Does the solution violate declared constraints? (e.g., "no dependencies added" but plan adds a library)
6. **Target type mismatch**: Does the implementation match the declared `target_type` (bug_fix / refactor / etc.)?
7. **Decision reversals**: Are earlier decisions silently reversed without rationale?
8. **Naming / semantic drift**: Same concept referred to by different names, or different concepts by same name?

## Output Format

```json
{
  "round": 2,
  "focus": "contradiction",
  "result": "pass | fail",
  "findings": [
    {
      "severity": "CRITICAL | HIGH | MEDIUM | LOW",
      "what_conflicts": "<statement A vs statement B>",
      "where": "<location: file/section/line if available>",
      "resolution": "<which should win, or how to reconcile>"
    }
  ]
}
```

## Rules

- `result: pass` is only valid when `findings` is empty or contains only LOW-severity items.
- **Do NOT** re-raise Round 1 omissions.
- **Do NOT** introduce edge case concerns — Round 3 handles those.
- A conflict with upstream artifacts (`brainstorm.md`, `investigation.md`, `plan.md`) is at minimum HIGH severity — reshape edge candidate.
- Principle 3 (self-failure forbidden): you cannot output "cannot complete this round". Either pass or fail with findings.
