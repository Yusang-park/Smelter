---
name: workflow-investigate-review
version: 0.4.0
type: workflow
consumes: investigation.md
produces: investigation-review.md
default_pattern: A
default_agent: explore-high
supports_patterns: [A]
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
    - file_exists: "investigation-review.md"
    - contains_decision: "pass|fail|reshape"
---

# workflow-investigate-review

## Overview

Reviews `investigation.md`. Identifies missing coverage, excess, and risks before the active mode's next planning or execution stage consumes it.

**Core principle:** Downstream stages only get evidence that survives 2-round review. Partial review is not review.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-investigate-review to run 2-round verification on `investigation.md`."

## The Iron Law

```
NO DOWNSTREAM HANDOFF WITHOUT 2/2 REVIEW ROUNDS AT pass
```

Skill-level `pass` requires `completed_rounds === 2 && all rounds result === pass`. Declaring `pass` with `completed_rounds < 2` is blocked by hook.

## Output

`investigation-review.md`:

- `## Verdict` — `pass` / `fail` / `reshape`
- `## Coverage Check` — whether any area is missing
- `## Risks Validated` — re-validated risks
- `## Reshape Target` — upstream skill on reshape (e.g., `workflow-brainstorm`)

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "The investigation looks fine, skip round 2" | Hook blocks sub-2 pass. Run both rounds. |
| "No contradictions, round 2 is wasted" | Round 2 finds the contradictions. Absence is what the round discovers. |
| "Reshape feels heavy, downgrade to fail" | If scope is wrong, reshape. Calling reshape `fail` wastes the investigate re-run without fixing the upstream brainstorm. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Coverage is good enough" | Reviewer decides, not implementer. Record the verdict. |
| "Risks are already in brainstorm" | `## Risks Validated` is a fresh re-evaluation, not a copy. |
| "Just this once" | No exceptions. Iron Law applies to every run. |

## Routing

- `pass` → next skill in the active mode's default order
- `fail` → re-run `workflow-investigate` (a specific area may be designated)
- `reshape` → `workflow-brainstorm` (scope was wrong from the planning stage; evidence required)

## Mode-specific exits

- `/brainstorm` mode: on pass, `workflow-tasker`
- `/implement` mode: on pass, `workflow-implementation-plan`
- `/fix` mode: on pass, `workflow-write-test`
- `/explore` mode: on pass, `mode_transition` gate

## Multi-Pass Verification (2-Round Enforcement)

This skill runs **2 mandatory rounds** before declaring `pass`. Each round has a distinct focus:

| Round | Focus | Question |
|-------|-------|----------|
| 1 | Omission | Is any required area (schema, API surface, UI, security, docs) missing? |
| 2 | Contradiction | Are there conflicting findings across areas or with the brainstorm? |

### Agent assignment per round

- **Pattern A**: Prefer different agent types across rounds. If reusing the same type, reset prompt context per round (fresh perspective).
- **Pattern B**: Each round runs with 95% consensus (3 × N agents × consensus rounds).
- **Pattern D**: Lead orchestrates 2 rounds, assigning different viewpoint sub-agents.

### State recording

All rounds recorded in `state.json.team_runtime.workflow-investigate-review.rounds[]`. Skill-level `pass` is declared only when `completed_rounds === 2 && all rounds result === pass`.

### Failure handling

- Any round `fail` → skill-level fail with `cause: verification_failed`, `evidence: {round, focus, findings[]}`
- Producer-chain routes to `workflow-investigate` (the consumed artifact's producer)
- On re-entry after upstream fix, both rounds re-run (not just failed ones)

### Anti-evasion enforcement

1. Do not inject prior round conclusions into current round prompts (bias prevention)
2. Critic Watchdog blocks "already verified" skip statements
3. Declaring `pass` with `completed_rounds < 2` is blocked by hook

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL on `pass`:**
- `/brainstorm` mode → `workflow-tasker`
- `/implement` mode → `workflow-implementation-plan`
- `/fix` mode → `workflow-write-test`
- `/explore` mode → `mode_transition` gate (may route to `/brainstorm`, `/implement`, or `/fix` per suggested next mode)

**On `fail`:** route back to `workflow-investigate`.
**On `reshape`:** route back to `workflow-brainstorm`.

Do NOT:
- Invoke `workflow-coding`, `workflow-write-test`, or any implementation skill
- Stop on pass, report completion, or ask "shall I continue?"
- Offer A/B/continue choices — Iron Law #1 forbids pausing at non-human-check stages

## Evidence Integrity (Mechanical Enforcement)

Every `fail` verdict MUST cite at least one anchor in the strict form:

**Evidence:** `path/to/file.ext:LINE[-LINE]` "verbatim quote substring"

Rules:
- The path must exist on disk at this session's cwd.
- The quoted substring must appear on the cited line (or within the range).
- Quote is a substring match after whitespace normalization — not a regex.
- A `PostToolUse` hook (`scripts/review-evidence-verifier.mjs`) blocks writes that violate these rules.
- Do not paraphrase — quote the line verbatim.
- If you cannot produce a verified anchor, the symptom is not grounded; do not emit a fail verdict.
