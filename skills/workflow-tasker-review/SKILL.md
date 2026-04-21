---
name: workflow-tasker-review
version: 2.4.1
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
min_verification_rounds: 2   # v3.1 — mid-pipeline review (omission + contradiction). Edge-case dropped for speed.
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

## Overview

95% consensus review of `plan.md`. Multi-angle assessment of side-effects, scope, and feasibility. This is the last gate before test-writing or coding begins — a bad plan that passes here becomes wasted implementation.

**Core principle:** Two independent enforcements must both hold — 95% consensus between advocate/critic/arbitrator AND 3-round pass (omission, contradiction, edge case).

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-tasker-review to run 95% consensus + 3-round verification on `plan.md`."

## The Iron Law

```
NO IMPLEMENTATION SKILL WITHOUT 95% CONSENSUS AND 3/3 REVIEW ROUNDS AT pass
```

Both conditions are gated. `consensus_reached` and `contains_decision: pass` both required. Declaring pass with `completed_rounds < 3` is blocked by hook.

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

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "Advocate and critic agree, skip arbitrator" | Arbitrator computes the score that decides the verdict. Skipping = no verdict. |
| "90% agreement is close enough" | The threshold is 95%. 90% is not pass. Run another round. |
| "5 rounds hit — just pass it" | 5 rounds exceeded = Stall Cascade Level 2. Escalate, do not force-pass. |
| "The plan is short, skip review entirely" | Short plans hide the most implicit assumptions. Review is non-optional. |
| "Side effects are obvious, omit the section" | `## Side Effects` is mandatory. Empty == "none" — which the reviewer will then challenge. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "We already reviewed the brainstorm" | Plan ≠ brainstorm. Plan introduces task decomposition, team assignment, TDD count — all new review surface. |
| "Consensus is performative" | 95% is calibrated to catch hidden risks. Drop it and risks slip to coding. |
| "Just this once" | Iron Law has no exceptions. |

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

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL on `pass`:**
- Mode with TDD: `workflow-write-test`
- Mode with `exempt.tdd === true` (e.g., `/simple-fix` for CSS/copy/typo): `workflow-coding`

**On `fail`:** route to `workflow-tasker`.
**On `reshape`:** route to `workflow-investigate`.
**On consensus exceeded (5 rounds):** Stall Cascade Level 2.

Do NOT:
- Invoke `workflow-coding` directly when TDD is not exempt
- Stop after pass, report "plan approved", or ask for approval
- Offer A/B/continue choices — Iron Law #1 forbids pausing at non-human-check stages
