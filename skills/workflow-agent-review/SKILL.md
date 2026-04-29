---
name: workflow-agent-review
version: 0.55
type: workflow
consumes: src/** diff
produces: agent-review.md, "## Risks" updated
default_pattern: B
default_agents: [code-reviewer, security-reviewer]
supports_patterns: [A, B]
team_template:
  B:
    agents: [code-reviewer, security-reviewer]
    mode: dual_adversarial
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
    - file_exists: "agent-review.md"
    - contains_verdict: "pass|fail"
---

# workflow-agent-review

## Overview

Immediately after implementation, a **Pattern B Dual Adversarial** review:

- `code-reviewer`: quality, readability, bugs, logic errors
- `security-reviewer`: vulnerabilities, data exposure, permissions

The two agents review **in parallel and independently**; `arbitrator` then merges results.

**Core principle:** Implementation is unverified until two independent reviewers (code + security) both pass through 2 rounds (omission, contradiction).

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-agent-review to run Pattern B dual adversarial review + 2-round verification on the diff."

## The Iron Law

```
NO E2E HANDOFF WITHOUT DUAL REVIEW AT pass AND 2/2 ROUNDS AT pass
```

Two independent enforcements must both hold:

1. Both `code-reviewer` and `security-reviewer` return `pass` (Pattern B consensus)
2. Both verification rounds return `pass`

Declaring pass with `completed_rounds < 2` or only one reviewer is blocked by hook.

## Demotion condition (Pattern B → A)

Only when tasker declares `security_surface: false` does `code-reviewer` run alone (Pattern A). Default remains B. The demotion is a tasker-time decision; `workflow-agent-review` cannot demote itself.

## Output

`agent-review.md`:

- `## Code Review` — code-reviewer findings
- `## Security Review` — security-reviewer findings
- `## Risks Added` — updates to the `## Risks` section (LOW/MEDIUM/HIGH/CRITICAL)
- `## Verdict` — `pass` / `fail`

## Risks section

```markdown
## Risks
- [LOW] <style / naming improvement suggestion>
- [MEDIUM] <possible minor bug>
- [HIGH] <major logic flaw>
- [CRITICAL] <data loss / security vulnerability>
```

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "The diff is small, skip security-reviewer" | Pattern B demotion is a tasker decision, not a reviewer decision. Run both unless `security_surface: false` was declared. |
| "Code-reviewer passed, ship it" | Pattern B needs BOTH reviewers. One is not consensus. |
| "Only round 1 is needed for small diffs" | Hook blocks sub-2 pass. Run both rounds. |
| "Reviewer disagrees with me, I'm right" | Push back with evidence, not confidence. If you cannot verify, say so and ask. |
| "Findings are just style, ignore them" | LOW findings go in `## Risks`. Ignoring is not the same as acknowledging. |
| "We already reviewed this in the previous session" | Session-local. Re-verify. Critic Watchdog blocks "already verified" skips. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "The reviewer doesn't understand the context" | Provide missing context, don't dismiss findings. |
| "Great point!" / "You're absolutely right!" | Forbidden response. Technical acknowledgment or reasoned pushback only. |
| "Let me implement that now" (before verification) | Verify the reviewer's finding is technically correct for THIS codebase first. Then implement. |
| "I'll bundle feedback for later" | Fix Critical immediately. Fix Important before proceeding to `workflow-e2e`. Minor goes in `## Risks`. |

## Forbidden Responses

When receiving review feedback, NEVER say:

- "You're absolutely right!" — performative; forbidden per `feedback_precision` memory
- "Great point!" / "Excellent feedback!" — performative
- "Let me implement that now" — before technical verification

INSTEAD:

- Restate the technical requirement
- Ask clarifying questions if unclear
- Push back with technical reasoning if incorrect
- Just start working on verified fixes (actions > words)

## Fail routing

- `fail` → `workflow-coding`
- On `security` cause detection → `workflow-coding` with security guidance attached via active_feedback

## Multi-Pass Verification (2-Round Enforcement)

This skill runs **2 mandatory rounds** before declaring `pass`. Each round has a distinct focus:

| Round | Focus | Question |
|-------|-------|----------|
| 1 | Omission | Are any diff paths, error branches, or security surfaces unreviewed? |
| 2 | Contradiction | Are there inconsistencies between code review and security review findings, or with the plan? |

### Agent assignment per round

- **Pattern A**: Prefer different agent types across rounds. If reusing the same type, reset prompt context per round (fresh perspective).
- **Pattern B**: Each round runs with 95% consensus (3 × N agents × consensus rounds).
- **Pattern D**: Lead orchestrates 2 rounds, assigning different viewpoint sub-agents.

### State recording

All rounds recorded in `state.json.team_runtime.workflow-agent-review.rounds[]`. Skill-level `pass` is declared only when `completed_rounds === 2 && all rounds result === pass`.

### Failure handling

- Any round `fail` → skill-level fail with `cause: verification_failed`, `evidence: {round, focus, findings[]}`
- Producer-chain routes to `workflow-coding` (the consumed artifact's producer)
- On re-entry after upstream fix, both rounds re-run (not just failed ones)

### Anti-evasion enforcement

1. Do not inject prior round conclusions into current round prompts (bias prevention)
2. Critic Watchdog blocks "already verified" skip statements
3. Declaring `pass` with `completed_rounds < 2` is blocked by hook

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL on `pass`:** `workflow-e2e`

**On `fail`:** route to `workflow-coding` with `active_feedback`.

Do NOT:
- Skip to `workflow-team-code-review` — `workflow-e2e` must run first on interface-changing surfaces
- Stop after pass, report "review complete", or ask "shall I run E2E?"
- Offer A/B/continue choices — Iron Law #1 forbids pausing at non-human-check stages

If the surface is in `exempt_if_surface: [style, typography, typo, dialogue]`, the mode's configuration may route directly to `workflow-team-code-review`. Otherwise `workflow-e2e` is mandatory.

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
