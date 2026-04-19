---
name: workflow-brainstorm-review
version: 2.4.1
type: workflow
consumes: brainstorm.md
produces: brainstorm_review.md
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

Reviews `brainstorm.md` from the critic's perspective. Surfaces ambiguity, contradictions, and omissions.

## Output

`brainstorm_review.md`:
- `## Verdict` — `pass` / `fail` / `reshape`
- `## Issues Found` — ambiguity, contradictions, missing perspectives
- `## Suggestions` — corrective directions (on fail/reshape)
- `## Reshape Target` — only when reshape (e.g., re-run `workflow-brainstorm` itself)

## Fail routing (producer)

- `fail` → re-run `workflow-brainstorm` (augment)
- `reshape` → re-run `workflow-brainstorm` (reset scope, evidence required)

## Iron Law compliance

- No `skill` declarer allowed (principle 3). The hook only checks for the postcondition file.
- The critic may declare "no issues" (pass) but may not declare "cannot do it".

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
