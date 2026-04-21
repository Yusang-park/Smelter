---
name: workflow-brainstorm-review
version: 2.4.1
type: workflow
consumes: brainstorm.md
produces: brainstorm-review.md
default_pattern: B
default_agent: critic
supports_patterns: [A, B]
team_template:
  B:
    agents: [critic]
    mode: adversarial_single
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
    - file_exists: "brainstorm_review.md"
    - contains_decision: "pass|fail|reshape"
---

# workflow-brainstorm-review

## Overview

Reviews `brainstorm.md` from the critic's perspective. Surfaces ambiguity, contradictions, and omissions before any investigation or task-breakdown work consumes them.

**Core principle:** A design is not approved until three independent review rounds (omission, contradiction, edge case) all return `pass`. Partial review is not review.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-brainstorm-review to run 3-round verification on `brainstorm.md`."

## The Iron Law

```
NO DOWNSTREAM HANDOFF WITHOUT 3/3 REVIEW ROUNDS AT pass
```

Skill-level `pass` is declared only when `completed_rounds === 3 && all rounds result === pass`. Declaring `pass` with `completed_rounds < 3` is blocked by hook.

## Output

`brainstorm_review.md`:

- `## Verdict` — `pass` / `fail` / `reshape`
- `## Issues Found` — ambiguity, contradictions, missing perspectives
- `## Suggestions` — corrective directions (on fail/reshape)
- `## Reshape Target` — only when reshape (e.g., re-run `workflow-brainstorm` itself)

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "Looks complete to me, skip rounds 2 and 3" | Multi-Pass 3-Round Enforcement is non-negotiable. Hook blocks sub-3 pass. |
| "The design is obviously fine" | Obviousness is rationalization. Round 1 = omission, round 2 = contradiction, round 3 = edge case. Each catches different bugs. |
| "Round 1 passed, ship it" | Skill-level pass requires ALL three rounds at pass. One round is not pass. |
| "Same reviewer for all three rounds" | Pattern A should mix ≥2 agent types. Same type for 3 consecutive rounds emits a warning. Reset context if you must reuse. |
| "Include prior round findings in the next round to save time" | Bias prevention: do NOT inject prior round conclusions into current round prompts. |
| "We already verified this last session" | Stage-completion is session-local. Re-verify on every run. Critic Watchdog blocks "already verified" skips. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "No contradictions visible → skip round 2" | Invisibility is what round 2 reveals. Run it. |
| "Edge cases are for later" | Later = never. Capture them now or lose them. |
| "The critic agrees with the plan" | Agreement is not the verdict. `pass` vs. `fail` vs. `reshape` is. Record it. |
| "Just this once" | No exceptions. Every round every run. |

## Iron Law compliance

- No `skill` declarer allowed (Iron Law principle 3). The hook only checks for the postcondition file.
- The critic may declare "no issues" (`pass`) but may not declare "cannot do it".

## Multi-Pass Verification (3-Round Enforcement)

This skill runs **3 mandatory rounds** before declaring `pass`. Each round has a distinct focus:

| Round | Focus | Question |
|-------|-------|----------|
| 1 | Omission | Is anything required (scope, constraints, perspectives) missing? |
| 2 | Contradiction | Are there logical conflicts within the brainstorm or with prior artifacts? |
| 3 | Edge case | Are boundary conditions, unusual personas, or special scenarios covered? |

### Agent assignment per round

- **Pattern A**: Prefer different agent types across rounds. If reusing the same type, reset prompt context per round (fresh perspective).
- **Pattern B**: Each round runs with 95% consensus (3 × N agents × consensus rounds).
- **Pattern D**: Lead orchestrates 3 rounds, assigning different viewpoint sub-agents.

### State recording

All rounds recorded in `state.json.team_runtime.workflow-brainstorm-review.rounds[]`. Skill-level `pass` is declared only when `completed_rounds === 3 && all rounds result === pass`.

### Failure handling

- Any round `fail` → skill-level fail with `cause: verification_failed`, `evidence: {round, focus, findings[]}`
- Producer-chain routes to `workflow-brainstorm` (the consumed artifact's producer)
- On re-entry after upstream fix, ALL 3 rounds re-run (not just failed ones)

### Anti-evasion enforcement

1. Do not inject prior round conclusions into current round prompts (bias prevention)
2. Critic Watchdog blocks "already verified" skip statements
3. Same agent for 3 consecutive rounds emits a warning (Pattern A should mix ≥2 types)
4. Declaring `pass` with `completed_rounds < 3` is blocked by hook

## Fail routing (producer)

- `fail` → re-run `workflow-brainstorm` (augment)
- `reshape` → re-run `workflow-brainstorm` (reset scope, evidence required)

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL on `pass`:** `workflow-investigate`

**On `fail` or `reshape`:** route back to `workflow-brainstorm` (producer chain).

Do NOT:
- Invoke `workflow-tasker`, `workflow-coding`, or any execution skill
- Stop the session on a pass verdict, report completion, or ask "shall I continue?"
- Offer A/B/continue choices — Iron Law #1 forbids pausing at non-human-check stages
