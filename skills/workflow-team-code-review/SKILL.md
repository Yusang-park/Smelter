---
name: workflow-team-code-review
version: 2.4.1
type: workflow
consumes: full task change + e2e artifacts
produces: team_review.md
default_pattern: B
default_agents: [advocate, critic, arbitrator]
supports_patterns: [B]
team_template:
  B:
    agents: [advocate, critic, arbitrator]
    consensus_threshold: 0.95
    max_rounds: 5
    aggregator: arbitrator
result_types: [pass, fail]
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
    - file_exists: "team_review.md"
    - consensus_reached: true
    - severity_classified: true
---

# workflow-team-code-review

The final team review. Re-examines the whole implementation from 3 independent perspectives.

## Pattern B consensus (95%)

```
advocate:   advocate for implementation merits and correct decisions
critic:     call out defects, missed cases, and latent bugs
arbitrator: synthesize both sides, compute score, render final judgment

Rounds repeat until agreement ≥ 95% (max 5).
```

## Review scope

1. Re-verify that prior `workflow-agent-review` findings have been **resolved**
2. Look for **new defects**
3. Assess security, performance, and maintainability
4. Alignment of implementation vs. plan

## Severity classification & routing

| Severity | Criterion | Routing |
|----------|-----------|---------|
| `CRITICAL` | data loss, security vulnerability, service outage | `workflow-tasker` (redesign) |
| `HIGH` | major bugs, missed edges | `workflow-tasker` |
| `MEDIUM` | minor bugs, improvements | `workflow-coding` |
| `LOW` | style, naming | record in `## Risks`, pass |

## Output

`team_review.md`:
- `## Advocate Report`
- `## Critic Report`
- `## Arbitrator Synthesis`
- `## Final Verdict (severity)`
- `## Consensus Rounds`

## Consensus not reached

5 rounds exceeded → enter section 11-7 Stall Cascade Level 2.

## Multi-Pass Verification (3-Round Enforcement)

This skill runs **3 mandatory rounds** before declaring `pass`. Each round has a distinct focus:

| Round | Focus | Question |
|-------|-------|----------|
| 1 | Omission | Are any diff paths, prior review findings, or plan items unaddressed? |
| 2 | Contradiction | Are there conflicts between advocate/critic findings, or with earlier review artifacts? |
| 3 | Edge case | Are regression, performance, security, and maintainability edge scenarios covered? |

### Agent assignment per round

- **Pattern A**: Prefer different agent types across rounds. If reusing the same type, reset prompt context per round (fresh perspective).
- **Pattern B**: Each round runs with 95% consensus (3 × N agents × consensus rounds).
- **Pattern D**: Lead orchestrates 3 rounds, assigning different viewpoint sub-agents.

### State recording

All rounds recorded in `state.json.team_runtime.workflow-team-code-review.rounds[]`. Skill-level `pass` is declared only when `completed_rounds === 3 && all rounds result === pass`.

### Failure handling

- Any round `fail` → skill-level fail with `cause: verification_failed`, `evidence: {round, focus, findings[]}`
- Producer-chain routes to the skill's consumed-artifact producer based on severity (`workflow-tasker` or `workflow-coding`)
- On re-entry after upstream fix, ALL 3 rounds re-run (not just failed ones)

### Anti-evasion enforcement

1. Do not inject prior round conclusions into current round prompts (bias prevention)
2. Critic Watchdog blocks "already verified" skip statements
3. Same agent for 3 consecutive rounds emits a warning (Pattern A should mix ≥2 types)
4. Declaring `pass` with `completed_rounds < 3` is blocked by hook
