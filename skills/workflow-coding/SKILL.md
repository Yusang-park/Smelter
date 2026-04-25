---
name: workflow-coding
version: 0.4.0
type: workflow
consumes: "*.test.*" (RED) OR active_feedback
produces: src files changed
default_pattern: C
default_agent: executor
supports_patterns: [A, C]
team_template:
  C:
    parallel_split_by: module
    agents: [executor]
    aggregator: architect
    conflict_resolver: conflict-resolver
    sync_point: "api-contract"
watchdog: E  # Pattern E Critic Watchdog always active
can_delegate_to: [ui-ux-pro-max, copywriting, vercel-react-best-practices, designer]
gate:
  pre:
    - tdd_cycle: "test_cycles has action=added_case|modified_case + run_result=fail"
    - allowed_in_mode: true
  post:
    - src_changed: true
    - typecheck_clean: true
    - scoped_tests_pass: true
---

# workflow-coding

## Overview

Implements real code that turns RED tests GREEN. This is the implementation stage — but it is NOT the terminal stage. `workflow-agent-review`, `workflow-e2e`, `workflow-e2e-review`, `workflow-team-code-review`, and `workflow-human-check` all still need to run before completion.

**Core principle:** Tests passing is not done. The workflow has 5+ more skills after this one. Stopping here is a completion lie.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-coding to turn RED tests GREEN. Next skill on pass: workflow-agent-review."

## The Iron Law

```
TESTS GREEN ≠ DONE. NO COMPLETION CLAIM WHILE STAGE < workflow-human-check
```

"Tests pass so the task is done" is the primary failure mode this skill prevents. The full chain from here:

```
workflow-coding → workflow-agent-review → workflow-e2e → workflow-e2e-review → workflow-team-code-review → workflow-human-check
```

If `workflow-human-check` has not run and returned a user `complete` decision, the task is NOT done. Claiming otherwise is a Critic Watchdog violation.

## Pre-Gate (hook enforced)

- At least one entry in `state.json.test_cycles` with `action ∈ {added_case, modified_case}` + `run_result: fail`
- If absent, `declarer: hook, cause: tdd_cycle` → routes to `workflow-write-test`

## Post-Gate (hook enforced)

- Source file changed (`git diff --cached --name-only | grep -v '\.test\.'`)
- `tsc --noEmit` exit 0
- Scoped tests pass (only those related to changed files)

## Coding Quality Gate

These are coding-stage constraints, not generic per-file prompt injections:

- No hardcoded secrets, tokens, credentials, or environment-specific constants.
- Handle errors explicitly; never silently swallow failures.
- Keep functions short and readable; avoid deep nesting.
- Keep files below 800 lines unless the surrounding codebase already requires a larger generated or declarative file.
- Validate external input at system boundaries before use.

## Red Flags - STOP

These thoughts mean STOP — you're rationalizing:

| Thought | Reality |
|---------|---------|
| "Tests pass so I'm done" | Tests passing is the GREEN transition, not completion. 5 more skills must run. |
| "The fix is small, skip review" | `workflow-agent-review` is non-optional. Size is not a demotion criterion. |
| "I'll skip E2E, nothing visible changed" | If the surface is UI / CLI / API / hook / script, `workflow-e2e` is mandatory. The exempt list is: css, style, typography, i18n, copy, typo, dialogue. Everything else runs E2E. |
| "I already verified locally, human-check isn't needed" | `workflow-human-check` is the ONLY allowed halting point. Skipping it is Iron Law #1 violation. |
| "Shall I continue?" / "Would you like me to proceed?" | Never ask this. The workflow chain runs autonomously until `workflow-human-check`. Iron Law #1 + autonomous chain completion. |
| "Just this once" | No exceptions. Every task every run. |
| "Code change is defensive, low-risk" | Low risk ≠ no risk. Reviewer decides severity. |
| "User will verify anyway" | That is what `workflow-human-check` is for. Not what "stopping after coding" is for. |
| "Turns out tests need to change too" | Test changes must go back through `workflow-write-test`. Do not edit tests mid-`workflow-coding`. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | Run the post-gate verifications. Evidence before claims. |
| "Linter passed" | Linter ≠ typecheck ≠ test run. Three separate checks. |
| "Scoped tests pass, full run would too" | Don't speculate. Scoped is the contract. Full regression is only on user request at human-check. |
| "The diff is clean" | Cleanness is not correctness. Review catches what diff reading misses. |
| "Review would just rubber-stamp" | If it's truly trivial, review passes in seconds. Skipping to save 30s costs hours in rework when review catches something. |
| "I'm tired and want this over" | Exhaustion ≠ excuse. Continue the chain. The session only halts at human-check. |

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| "Code change complete" | Post-gate passes + next skill dispatched | Only tests GREEN |
| "Bug fixed" | `workflow-e2e` reproduces original symptom and sees fix | Defensive code diff, assumed fixed |
| "Security-safe change" | `workflow-agent-review` Pattern B pass with security-reviewer | `code-reviewer` alone passed |
| "No regression" | `workflow-team-code-review` 95% consensus pass | Scoped tests green |

## Pattern C (parallel module split)

When tasker declares a frontend/backend split:

- Per-module agent assignment (team_runtime)
- sync_point: "api-contract" — converges at the API/interface agreement point
- Aggregator (architect) integrates; on conflict, invokes conflict-resolver

## Subagent execution discipline

For `/implement` tasks with independent queue items, follow the superpowers subagent-driven development experience without changing Smelter's gates:

- Dispatch a fresh executor context per independent task or module when parallelization is safe.
- Give each executor the exact task text, file map, acceptance criteria, and relevant excerpts from `implementation-plan.md`; do not make the subagent rediscover the whole plan from session history.
- Require implementer self-review before handoff: spec compliance, tests run, and concerns explicitly reported.
- Run Smelter's existing review chain after coding; implementer self-review never replaces `workflow-agent-review`, `workflow-e2e`, or `workflow-team-code-review`.
- If a subagent reports `NEEDS_CONTEXT` or `BLOCKED`, provide missing context, narrow the task, or route back to the producer skill. Do not blindly retry the same prompt.

## Critic Watchdog (Pattern E, always active)

The `scripts/critic-watchdog.mjs` hook watches every Edit/Write/Bash:

- Immediately blocks test deletion, `--no-verify`, `.env` access, etc.
- Blocks declarations of "done", "complete", "finished", "fixed" when stage < `workflow-human-check`
- On violation, appends a `skill: critic-watchdog, result: fail` event

## Iron Law compliance

- **No halt on fail** (#1): on gate fail, route to producer, do not stop the session
- **No evasion** (#2): never work around via TODO, never lean on `??` fallbacks to hide bugs
- **No self-failure** (#3): cannot declare "impossible" — specific cause + evidence required
- **No retry** (#4): `typecheck`/`lint`/`test_run` self re-run is **not a retry** (code has changed between runs)
- **File is truth** (#5): `.smt/features/*/task/*.state.json` drives routing, not the model's impression
- **Scoped testing** (#8): run only tests related to changed files; full regression is opt-in at human-check

## Active Feedback consumption

On entry, inject `active_feedback` entries where `target_skill == workflow-coding && resolved == false` into the prompt. On completion, mark them `resolved: true`.

## Fail routing

- `tdd_cycle` → `workflow-write-test`
- `scope_mismatch` in `/fix` → `workflow-investigate` or mode upgrade to `/implement`
- `scope_mismatch` in `/implement` → `workflow-implementation-plan`
- `typecheck`/`lint`/`test_run` → self re-run (same skill, different attempt; **not a retry** — code has changed)

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL:** `workflow-agent-review`

After the post-gate passes (src changed + typecheck clean + scoped tests pass), the ONLY valid next action is dispatching `workflow-agent-review`. Do NOT:

- Stop the session, report completion, say "bug fixed", "task done", or "implementation complete"
- Invoke `workflow-e2e` directly (it comes after agent-review)
- Ask the user "would you like me to continue with review?" — Iron Law #1, autonomous chain completion
- Offer A/B/complete/skip choices — never

The only halting point in the full chain is `workflow-human-check`. Until then, the next skill is always already determined — in this case, `workflow-agent-review`.
