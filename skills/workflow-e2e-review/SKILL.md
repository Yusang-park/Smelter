---
name: workflow-e2e-review
version: 2.3.0
type: workflow
consumes: artifacts/
produces: e2e_review.md
default_pattern: A
default_agent: code-reviewer
supports_patterns: [A]
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
    - file_exists: "e2e_review.md"
    - contains_verdict: "pass|fail"
---

# workflow-e2e-review

Reviews E2E artifacts (video, screenshots, logs). Evaluates scenario coverage and whether real validation occurred.

## Output

`e2e_review.md`:
- `## Scenario Coverage` — list of covered scenarios
- `## Missing Cases` — missing cases (if any)
- `## Artifacts Quality` — video/log quality assessment
- `## Verdict` — `pass` / `fail`

## Fail conditions

- Key scenarios uncovered (`insufficient_scenario`)
- Insufficient artifact quality (missing recording, sparse logs, etc.)

## Fail routing (producer)

- `insufficient_scenario` → `workflow-coding` (the implementation may need to add scenario coverage, not the test)
- `file_absent` (artifacts missing) → `workflow-e2e`

## Multi-Pass Verification (3-Round Enforcement)

This skill runs **3 mandatory rounds** before declaring `pass`. Each round has a distinct focus:

| Round | Focus | Question |
|-------|-------|----------|
| 1 | Omission | Are any required artifacts (video, screenshot, log) or scenarios missing? |
| 2 | Contradiction | Do artifacts conflict with each other or with the implementation diff/plan? |
| 3 | Edge case | Are artifact-coverage scenarios for errors, retries, slow networks, and boundary inputs present? |

### Agent assignment per round

- **Pattern A**: Prefer different agent types across rounds. If reusing the same type, reset prompt context per round (fresh perspective).
- **Pattern B**: Each round runs with 95% consensus (3 × N agents × consensus rounds).
- **Pattern D**: Lead orchestrates 3 rounds, assigning different viewpoint sub-agents.

### State recording

All rounds recorded in `state.json.team_runtime.workflow-e2e-review.rounds[]`. Skill-level `pass` is declared only when `completed_rounds === 3 && all rounds result === pass`.

### Failure handling

- Any round `fail` → skill-level fail with `cause: verification_failed`, `evidence: {round, focus, findings[]}`
- Producer-chain routes to `workflow-e2e` (the consumed artifact's producer)
- On re-entry after upstream fix, ALL 3 rounds re-run (not just failed ones)

### Anti-evasion enforcement

1. Do not inject prior round conclusions into current round prompts (bias prevention)
2. Critic Watchdog blocks "already verified" skip statements
3. Same agent for 3 consecutive rounds emits a warning (Pattern A should mix ≥2 types)
4. Declaring `pass` with `completed_rounds < 3` is blocked by hook
