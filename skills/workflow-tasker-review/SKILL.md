---
name: workflow-tasker-review
version: 0.51
type: workflow
consumes: tasks.md
produces: tasks-review.md
default_pattern: B
default_agents: [advocate, critic, arbitrator]
supports_patterns: [A, B]
team_template:
  B:
    agents: [advocate, critic, arbitrator]
    consensus_threshold: 0.95
    max_rounds: 5
    aggregator: arbitrator
result_types: [pass, fail, reshape]
min_verification_rounds: 2
verification_rounds:
  - n: 1
    focus: omission
    prompt_template: templates/verification/round-1-omission.md
  - n: 2
    focus: contradiction
    prompt_template: templates/verification/round-2-contradiction.md
gate:
  postcondition:
    - file_exists: "tasks-review.md"
    - schema_version: "0.51"
    - compact_checkbox_contract: true
    - consensus_reached: true
    - contains_decision: "pass|fail|reshape"
---

# workflow-tasker-review

Review `tasks.md` with the v0.51 compact checklist. `/fix` depends on this to prove the fix still has scope, omission, and verification evidence without a verbose plan.

Announce: `I'm using workflow-tasker-review to verify the v0.51 checklist.`

## Output Contract

Write `tasks-review.md` exactly in this compact shape:

```markdown
---
schema_version: "0.51"
verdict: pass|fail|reshape
consensus: 0.95
---

# tasks-review

- [x] works: <feature/fix success path is covered>
- [x] omissions: <no feature, review concern, or requirement is missing>
- [x] verified: <checks are sufficient and named>
- [x] side_effects: <none, or exact impacted surface>
- [x] decision: pass|fail|reshape
```

Rules:
- `pass` requires all five checkboxes checked and `consensus >= 0.95`.
- Use `fail` when the task list is incomplete; next skill is `workflow-tasker`.
- Use `reshape` when investigation is insufficient; next skill is `workflow-investigate`.
- Do not write prose sections unless a `fail` needs one evidence anchor.

## Terminal State

On `pass`: next skill is `workflow-write-test`, or `workflow-coding` when TDD is exempt.

Do not stop after review or ask whether to continue.
