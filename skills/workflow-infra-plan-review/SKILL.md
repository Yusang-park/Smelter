---
name: workflow-infra-plan-review
version: 0.51
type: workflow
consumes: infra-plan.md
produces: infra-plan-review.md
default_pattern: B
default_agent: arbitrator
can_delegate_to: [security-reviewer, critic, arbitrator]
gate:
  postcondition:
    - file_exists: "infra-plan-review.md"
    - verdict_recorded: true
---

# workflow-infra-plan-review

## Review Focus

Review `infra-plan.md` for infrastructure safety and completeness.

Check:

- Inventory covers account/profile, region/stage, resources, and owners.
- Destructive commands have explicit scope and approval gate.
- Data-loss resources have backup/export handling or an explicit non-backup rationale.
- Out-of-scope resources are protected.
- Execution commands are ordered from low-risk reads to mutations.
- Verification proves the requested infrastructure state, not just command success.
- Required documentation updates are named.

## Output

Write `infra-plan-review.md` with:

- `Verdict: pass` or `Verdict: fail`.
- Findings with file/section references.
- Required fixes when failing.

## Terminal State

- On pass: invoke `workflow-infra-execute`.
- On fail: return to `workflow-infra-plan` with the findings.
