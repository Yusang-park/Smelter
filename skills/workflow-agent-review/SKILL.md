---
name: workflow-agent-review
version: 2.4.1
type: workflow
consumes: src/** diff
produces: agent_review.md, "## Risks" updated
default_pattern: B
default_agents: [code-reviewer, security-reviewer]
supports_patterns: [A, B]
team_template:
  B:
    agents: [code-reviewer, security-reviewer]
    mode: dual_adversarial
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
    - file_exists: "agent_review.md"
    - contains_verdict: "pass|fail"
---

# workflow-agent-review

Immediately after implementation, a **Pattern B Dual Adversarial** review:
- `code-reviewer`: quality, readability, bugs, logic errors
- `security-reviewer`: vulnerabilities, data exposure, permissions

The two agents review **in parallel and independently**; `arbitrator` then merges results.

## Demotion condition (Pattern B → A)

Only when tasker declares `security_surface: false` does `code-reviewer` run alone (Pattern A). Default remains B.

## Output

`agent_review.md`:
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

## Fail routing

- `fail` → `workflow-coding`
- On `security` cause detection → `workflow-coding` with security guidance attached via active_feedback

## Multi-Pass Verification (3-Round Enforcement)

This skill runs **3 mandatory rounds** before declaring `pass`. Each round has a distinct focus:

| Round | Focus | Question |
|-------|-------|----------|
| 1 | Omission | Are any diff paths, error branches, or security surfaces unreviewed? |
| 2 | Contradiction | Are there inconsistencies between code review and security review findings, or with the plan? |
| 3 | Edge case | Are boundary inputs, failure modes, concurrency, and permission edge cases covered? |

### Agent assignment per round

- **Pattern A**: Prefer different agent types across rounds. If reusing the same type, reset prompt context per round (fresh perspective).
- **Pattern B**: Each round runs with 95% consensus (3 × N agents × consensus rounds).
- **Pattern D**: Lead orchestrates 3 rounds, assigning different viewpoint sub-agents.

### State recording

All rounds recorded in `state.json.team_runtime.workflow-agent-review.rounds[]`. Skill-level `pass` is declared only when `completed_rounds === 3 && all rounds result === pass`.

### Failure handling

- Any round `fail` → skill-level fail with `cause: verification_failed`, `evidence: {round, focus, findings[]}`
- Producer-chain routes to `workflow-coding` (the consumed artifact's producer)
- On re-entry after upstream fix, ALL 3 rounds re-run (not just failed ones)

### Anti-evasion enforcement

1. Do not inject prior round conclusions into current round prompts (bias prevention)
2. Critic Watchdog blocks "already verified" skip statements
3. Same agent for 3 consecutive rounds emits a warning (Pattern A should mix ≥2 types)
4. Declaring `pass` with `completed_rounds < 3` is blocked by hook
