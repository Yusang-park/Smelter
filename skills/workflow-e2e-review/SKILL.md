---
name: workflow-e2e-review
version: 2.4.1
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
    focus: effect_verification
    prompt_template: templates/verification/round-3-effect-verification.md
gate:
  postcondition:
    - file_exists: "e2e_review.md"
    - contains_verdict: "pass|fail"
---

# workflow-e2e-review

## Overview

Reviews E2E artifacts (video, screenshots, logs, transcripts). Evaluates scenario coverage and whether real validation occurred — specifically whether the target effect was proven, not just an acknowledgement signal.

**Core principle:** Artifacts existing ≠ valid E2E. Reviewing the artifacts for ack-only failures is the final gate before team review.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-e2e-review to 3-round verify artifacts, scenario coverage, and effect evidence."

## The Iron Law

```
NO TEAM-REVIEW HANDOFF WITHOUT 3/3 ROUNDS AT pass INCLUDING EFFECT VERIFICATION
```

Round 3 is specifically `effect_verification` — it catches the ack-only failure mode that `workflow-e2e`'s gate protects against. Both layers must hold.

## Output

`e2e_review.md`:

- `## Scenario Coverage` — list of covered scenarios
- `## Missing Cases` — missing cases (if any)
- `## Artifacts Quality` — video/log quality assessment
- `## Effect Verification` — per-scenario ack vs effect classification and any ack-only failures
- `## Verdict` — `pass` / `fail`

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "Video exists, pass it" | Existence is one check. Coverage, quality, and effect verification are the others. |
| "Banner-text screenshot is enough" | Round 3 specifically catches ack-only "success" evidence. Require target-state assertion. |
| "Round 3 repeats round 1" | Round 1 is omission (any missing artifact). Round 3 is effect (does evidence prove the target state change materialized). Different. |
| "All 5 scenarios have screenshots — done" | Screenshot of "Loading..." is not the effect. Check what the DOM actually asserts. |
| "Artifact quality is subjective, skip" | Sparse logs, corrupted video, or truncated transcripts mean the evidence cannot be re-verified. Flag them. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "The runner reported all passed" | `workflow-e2e` already rejected that. This review re-verifies the artifacts themselves. |
| "Manual QA confirmed it works" | Manual QA is not an artifact on disk. Use the artifacts only. |
| "Just this once" | No exceptions. |

## Fail conditions

- Key scenarios uncovered (`insufficient_scenario`)
- Insufficient artifact quality (missing recording, sparse logs, corrupted video, etc.)
- Ack-only evidence where effect assertion is required (round 3)

## Fail routing (producer)

- `insufficient_scenario` → `workflow-coding` (the implementation may need to add scenario coverage, not the test)
- `file_absent` (artifacts missing) → `workflow-e2e`
- `effect_unverified` (ack-only) → `workflow-e2e` (re-run with effect_evidence)

## Multi-Pass Verification (3-Round Enforcement)

This skill runs **3 mandatory rounds** before declaring `pass`. Each round has a distinct focus:

| Round | Focus | Question |
|-------|-------|----------|
| 1 | Omission | Are any required artifacts (video, screenshot, log) or scenarios missing? |
| 2 | Contradiction | Do artifacts conflict with each other or with the implementation diff/plan? |
| 3 | Effect verification | Does each claimed success scenario distinguish ack from effect, and does the evidence prove the target effect actually materialized instead of only the acknowledgement signal? |

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

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL on `pass`:** `workflow-team-code-review`

**On `fail`:** route per fail condition (`workflow-coding` or `workflow-e2e`).

Do NOT:
- Skip to `workflow-human-check` — team review must run first
- Stop after pass, report "E2E review complete", or ask "shall I continue?"
- Offer A/B/continue choices — Iron Law #1 forbids pausing at non-human-check stages
