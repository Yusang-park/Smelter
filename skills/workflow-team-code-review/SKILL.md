---
name: workflow-team-code-review
version: 0.55
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
    - file_exists: "team_review.md"
    - consensus_reached: true
    - severity_classified: true
---

# workflow-team-code-review

## Overview

The final team review. Re-examines the whole implementation from 3 independent perspectives (advocate / critic / arbitrator). This is distinct from `workflow-agent-review`:

- `workflow-agent-review` = diff-scoped, dual adversarial (code + security), runs immediately after coding
- `workflow-team-code-review` = whole-task scope, 3-role consensus, runs after E2E — last technical gate before human-check

**Core principle:** The last technical gate before human-check must see the whole task (diff + artifacts + prior reviews) from 3 independent perspectives and reach 95% consensus.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-team-code-review to run 95% consensus + 2-round review on the complete task."

## The Iron Law

```
NO HUMAN-CHECK HANDOFF WITHOUT 95% CONSENSUS AND 2/2 ROUNDS AT pass
```

Both must hold: `consensus_reached === true` AND `completed_rounds === 2 && all rounds result === pass`.

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

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "workflow-agent-review passed, this is rubber-stamp" | Team review sees the WHOLE task + E2E artifacts. Agent review saw only the diff. New findings here are common. |
| "95% is close to 90%" | Threshold is 95%. 90% is not pass. Run another round. |
| "Advocate and critic have stopped disagreeing early — force consensus" | 95% computed by arbitrator, not forced. |
| "All findings are MEDIUM, route to coding and call it done" | MEDIUM routes to coding. But the review itself still needs 2-round pass before the handoff. |
| "Prior agent-review findings are auto-resolved by now" | Re-verify that each finding has been addressed in the diff. Missing resolutions are `HIGH`. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Nothing will change in round 2" | Round 2 targets contradiction. Absence is what the round reveals. |
| "Skip round 2 — contradictions are too rare" | Contradictions in review evidence are costly. Round 2 catches them. |
| "I'm tired" | Iron Law applies. |

## Consensus not reached

5 rounds exceeded → enter section 11-7 Stall Cascade Level 2. Do NOT force-pass.

## Multi-Pass Verification (2-Round Enforcement)

This skill runs **2 mandatory rounds** before declaring `pass`. Each round has a distinct focus:

| Round | Focus | Question |
|-------|-------|----------|
| 1 | Omission | Are any diff paths, prior review findings, or plan items unaddressed? |
| 2 | Contradiction | Are there conflicts between advocate/critic findings, or with earlier review artifacts? |

### Agent assignment per round

- **Pattern A**: Prefer different agent types across rounds. If reusing the same type, reset prompt context per round (fresh perspective).
- **Pattern B**: Each round runs with 95% consensus (3 × N agents × consensus rounds).
- **Pattern D**: Lead orchestrates 2 rounds, assigning different viewpoint sub-agents.

### State recording

All rounds recorded in `state.json.team_runtime.workflow-team-code-review.rounds[]`. Skill-level `pass` is declared only when `completed_rounds === 2 && all rounds result === pass`.

### Failure handling

- Any round `fail` → skill-level fail with `cause: verification_failed`, `evidence: {round, focus, findings[]}`
- Producer-chain routes to the skill's consumed-artifact producer based on severity (`workflow-tasker` or `workflow-coding`)
- On re-entry after upstream fix, both rounds re-run (not just failed ones)

### Anti-evasion enforcement

1. Do not inject prior round conclusions into current round prompts (bias prevention)
2. Critic Watchdog blocks "already verified" skip statements
3. Declaring `pass` with `completed_rounds < 2` is blocked by hook

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL on `pass`:** `workflow-human-check`

**On `fail`:** route per severity:
- `CRITICAL` / `HIGH` → `workflow-tasker`
- `MEDIUM` → `workflow-coding`
- `LOW` → record in `## Risks`, proceed to human-check

**On consensus exceeded (5 rounds):** Stall Cascade Level 2.

Do NOT:
- Declare the task complete here — only `workflow-human-check` does that
- Stop after pass, report "all reviews passed", or ask "shall I finalize?"
- Offer A/B/continue choices — `workflow-human-check` is the next skill and it's the ONLY allowed halting point

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
