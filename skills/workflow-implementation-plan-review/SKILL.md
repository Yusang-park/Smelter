---
name: workflow-implementation-plan-review
version: 0.51
type: workflow
consumes: implementation-plan.md
produces: implementation-plan-review.md
default_pattern: B
default_agents: [advocate, critic, arbitrator]
supports_patterns: [A, B]
team_template:
  B:
    agents: [advocate, critic, arbitrator]
    consensus_threshold: 0.95
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
    - file_exists: "implementation-plan-review.md"
    - contains_decision: "pass|fail|reshape"
---

# workflow-implementation-plan-review

## Overview

Reviews `implementation-plan.md` before tests are written. The review checks whether the plan is grounded in code evidence, whether technology choices are justified, and whether user-facing trade-offs were surfaced when needed.

**Announce at start:** "I'm using workflow-implementation-plan-review to verify code evidence, reuse decisions, and implementation trade-offs before TDD."

## Review Criteria

- The chosen approach cites current codebase evidence.
- The file map names exact create/modify/test paths and responsibilities.
- Existing technologies and patterns are reused unless the plan justifies a new choice.
- Any new technology has explicit trade-offs and a recorded user decision.
- `extend_existing` work reuses the existing feature plan when sufficient.
- The change queue is concrete enough for independent executor contexts: each task has RED command, expected RED failure, GREEN implementation target, and GREEN command.
- Test strategy covers changed behavior and regression risk.
- The plan contains no placeholders (`TBD`, `TODO`, "similar to", vague validation/testing instructions).

## Output

`implementation-plan-review.md`:

- `## Verdict` — `pass` / `fail` / `reshape`.
- `## Evidence Review` — cited confirmation or gaps.
- `## Technology Decision Review` — reuse/new-tech trade-off assessment.
- `## Required Changes` — concrete fixes on fail.

## Fail Routing

- `fail` → `workflow-implementation-plan`.
- `reshape` → `workflow-investigate` when code evidence is insufficient.

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL on `pass`:** `workflow-write-test`

Do NOT:
- Invoke `workflow-coding` directly when TDD is not exempt.
- Route to `workflow-tasker`; `/implement` no longer uses tasker as its planning stage.
- Stop after pass or ask for approval outside `workflow-human-check`.
