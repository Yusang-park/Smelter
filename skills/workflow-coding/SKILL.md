---
name: workflow-coding
version: 2.4.1
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

Implements real code that turns RED tests GREEN.

## Pre-Gate (hook enforced)

- At least one entry in `state.json.test_cycles` with `action ∈ {added_case, modified_case}` + `run_result: fail`
- If absent, `declarer: hook, cause: tdd_cycle` → routes to `workflow-write-test`

## Post-Gate (hook enforced)

- Source file changed (`git diff --cached --name-only | grep -v '\.test\.'`)
- `tsc --noEmit` exit 0
- Scoped tests pass (only those related to changed files)

## Pattern C (parallel module split)

When tasker declares a frontend/backend split:
- Per-module agent assignment (team_runtime)
- sync_point: "api-contract" — converges at the API/interface agreement point
- Aggregator (architect) integrates; on conflict, invokes conflict-resolver

## Critic Watchdog (Pattern E, always active)

The `scripts/critic-watchdog.mjs` hook watches every Edit/Write/Bash:
- Immediately blocks test deletion, `--no-verify`, `.env` access, etc.
- On violation, appends a `skill: critic-watchdog, result: fail` event

## Iron Law compliance

- No evasion: never work around via TODO, never lean on `??` fallbacks
- No giving up: on failure, return to the producer (`workflow-write-test` or `workflow-tasker`)

## Active Feedback consumption

On entry, inject `active_feedback` entries where `target_skill == workflow-coding && resolved == false` into the prompt. On completion, mark them `resolved: true`.

## Fail routing

- `tdd_cycle` → `workflow-write-test`
- `scope_mismatch` → `workflow-tasker`
- `typecheck`/`lint`/`test_run` → self re-run (same skill, different attempt; **not a retry** — code has changed)
