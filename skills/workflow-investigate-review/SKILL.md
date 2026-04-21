---
name: workflow-investigate-review
version: 2.4.1
type: workflow
consumes: investigation.md
produces: investigation-review.md
default_pattern: A
default_agent: explore-high
supports_patterns: [A]
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
    - file_exists: "investigate_review.md"
    - contains_decision: "pass|fail|reshape"
---

# workflow-investigate-review

## Overview

Reviews `investigation.md`. Identifies missing coverage, excess, and risks before tasker consumes.

**Core principle:** Tasker only gets evidence that survives 3-round review. Partial review is not review.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-investigate-review to run 3-round verification on `investigation.md`."

## The Iron Law

```
NO TASKER HANDOFF WITHOUT 3/3 REVIEW ROUNDS AT pass
```

Skill-level `pass` requires `completed_rounds === 3 && all rounds result === pass`. Declaring `pass` with `completed_rounds < 3` is blocked by hook.

## Output

`investigate_review.md`:

- `## Verdict` — `pass` / `fail` / `reshape`
- `## Coverage Check` — whether any area is missing
- `## Risks Validated` — re-validated risks
- `## Reshape Target` — upstream skill on reshape (e.g., `workflow-brainstorm`)

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "The investigation looks fine, skip rounds 2–3" | Hook blocks sub-3 pass. Run all rounds. |
| "No contradictions, round 2 is wasted" | Round 2 finds the contradictions. Absence is what the round discovers. |
| "Edge cases can be caught in tasker-review" | Each review catches different bugs. Do not defer. |
| "Reshape feels heavy, downgrade to fail" | If scope is wrong, reshape. Calling reshape `fail` wastes the investigate re-run without fixing the upstream brainstorm. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Coverage is good enough" | Reviewer decides, not implementer. Record the verdict. |
| "Risks are already in brainstorm" | `## Risks Validated` is a fresh re-evaluation, not a copy. |
| "Just this once" | No exceptions. Iron Law applies to every run. |

## Routing

- `pass` → next skill in the mode's default order (`workflow-tasker` or `mode_transition`)
- `fail` → re-run `workflow-investigate` (a specific area may be designated)
- `reshape` → `workflow-brainstorm` (scope was wrong from the planning stage; evidence required)

## Mode-specific exits

- `investigate` mode: on pass, `mode_transition` gate
- `fix`/`implement` mode: on pass, `workflow-tasker`
- `plan` mode: on pass, `workflow-tasker`

## Multi-Pass Verification (3-Round Enforcement)

This skill runs **3 mandatory rounds** before declaring `pass`. Each round has a distinct focus:

| Round | Focus | Question |
|-------|-------|----------|
| 1 | Omission | Is any required area (schema, API surface, UI, security, docs) missing? |
| 2 | Contradiction | Are there conflicting findings across areas or with the brainstorm? |
| 3 | Edge case | Are boundary data paths, rare code paths, or external-system edge behaviors covered? |

### Agent assignment per round

- **Pattern A**: Prefer different agent types across rounds. If reusing the same type, reset prompt context per round (fresh perspective).
- **Pattern B**: Each round runs with 95% consensus (3 × N agents × consensus rounds).
- **Pattern D**: Lead orchestrates 3 rounds, assigning different viewpoint sub-agents.

### State recording

All rounds recorded in `state.json.team_runtime.workflow-investigate-review.rounds[]`. Skill-level `pass` is declared only when `completed_rounds === 3 && all rounds result === pass`.

### Failure handling

- Any round `fail` → skill-level fail with `cause: verification_failed`, `evidence: {round, focus, findings[]}`
- Producer-chain routes to `workflow-investigate` (the consumed artifact's producer)
- On re-entry after upstream fix, ALL 3 rounds re-run (not just failed ones)

### Anti-evasion enforcement

1. Do not inject prior round conclusions into current round prompts (bias prevention)
2. Critic Watchdog blocks "already verified" skip statements
3. Same agent for 3 consecutive rounds emits a warning (Pattern A should mix ≥2 types)
4. Declaring `pass` with `completed_rounds < 3` is blocked by hook

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL on `pass`:**
- `/plan`, `/implement`, `/fix` mode → `workflow-tasker`
- `/investigate` mode → `mode_transition` gate (may route to `/plan` or `/fix` per suggested next mode)

**On `fail`:** route back to `workflow-investigate`.
**On `reshape`:** route back to `workflow-brainstorm`.

Do NOT:
- Invoke `workflow-coding`, `workflow-write-test`, or any implementation skill
- Stop on pass, report completion, or ask "shall I continue?"
- Offer A/B/continue choices — Iron Law #1 forbids pausing at non-human-check stages
