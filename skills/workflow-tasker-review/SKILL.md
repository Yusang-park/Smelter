---
name: workflow-tasker-review
version: 2.4.1
type: workflow
consumes: plan.md
produces: tasker_review.md
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
min_verification_rounds: 3
verification_rounds:
  - n: 1
    focus: omission
    prompt_template: templates/verification/round-1-omission.md
  - n: 2
    focus: contradiction
    prompt_template: templates/verification/round-2-contradiction.md
  - n: 3
    focus: edge_case
    prompt_template: templates/verification/round-3-edge-case.md
gate:
  postcondition:
    - file_exists: "tasker_review.md"
    - consensus_reached: true
    - contains_decision: "pass|fail|reshape"
---

# workflow-tasker-review

95% consensus review of `plan.md`. Multi-angle assessment of side-effects, scope, and feasibility.

## Pattern B consensus process

```
advocate:   advocate for plan merits and feasibility
critic:     call out risks, side effects, and omissions
arbitrator: synthesize both sides and compute the score
→ repeat rounds until agreement ≥ 95% (max 5)
```

## Output

`tasker_review.md`:
- `## Consensus` — agreement rate per round
- `## Side Effects` — impact on existing functionality
- `## Verdict` — `pass` / `fail` / `reshape`
- `## Required Changes` — concrete requirements on fail

## Fail routing (producer)

- `fail` (plan needs revision) → `workflow-tasker`
- `reshape` (investigation itself is insufficient) → `workflow-investigate`
- Consensus not reached (5 rounds exceeded) → Producer chain Level 2 (stall cascade)

## Cause classification

- `scope_mismatch` — plan vs. investigation mismatch
- `side_effect` — impact on other features detected

## Multi-Pass Verification (3-Round Enforcement)

This skill runs **3 mandatory rounds** before declaring `pass`. Each round has a distinct focus:

| Round | Focus | Question |
|-------|-------|----------|
| 1 | Omission | Is any required task, TDD target, or queue item missing? |
| 2 | Contradiction | Does the plan conflict with investigation findings or the chosen approach? |
| 3 | Edge case | Are side-effect scenarios, rollback paths, and risky migrations considered? |

### Agent assignment per round

- **Pattern A**: Prefer different agent types across rounds. If reusing the same type, reset prompt context per round (fresh perspective).
- **Pattern B**: Each round runs with 95% consensus (3 × N agents × consensus rounds).
- **Pattern D**: Lead orchestrates 3 rounds, assigning different viewpoint sub-agents.

### State recording

All rounds recorded in `state.json.team_runtime.workflow-tasker-review.rounds[]`. Skill-level `pass` is declared only when `completed_rounds === 3 && all rounds result === pass`.

### Failure handling

- Any round `fail` → skill-level fail with `cause: verification_failed`, `evidence: {round, focus, findings[]}`
- Producer-chain routes to `workflow-tasker` (the consumed artifact's producer)
- On re-entry after upstream fix, ALL 3 rounds re-run (not just failed ones)

### Anti-evasion enforcement

1. Do not inject prior round conclusions into current round prompts (bias prevention)
2. Critic Watchdog blocks "already verified" skip statements
3. Same agent for 3 consecutive rounds emits a warning (Pattern A should mix ≥2 types)
4. Declaring `pass` with `completed_rounds < 3` is blocked by hook
