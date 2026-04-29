---
name: workflow-coding
version: 0.55
type: workflow
consumes: "*.test.* (RED) OR active_feedback"
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
watchdog: E
can_delegate_to: [ui-ux-pro-max, copywriting, vercel-react-best-practices, designer]
gate:
  pre:
    - tdd_cycle: "events[].type=test_red or legacy failing test_cycles[] exists"
    - allowed_in_mode: true
  post:
    - src_changed: true
    - typecheck_clean: true
    - scoped_tests_pass: true
---

# workflow-coding

Implement the smallest source change that turns RED tests GREEN. This is not a terminal stage.

Announce: `I'm using workflow-coding to turn RED tests GREEN. Next skill on pass: workflow-agent-review.`

## Required Inputs

- RED evidence from `workflow-write-test`: real failing command exit, not `; echo "exit=$?"` masking.
- Or unresolved `active_feedback` targeting `workflow-coding`.
- Current `tasks.md` or implementation-plan artifact relevant to the change.

## Execution Checklist

1. Read the failing test and related source before editing.
2. Change only source files needed for the RED case or active feedback.
3. Do not edit tests in this stage. If tests are wrong or missing, route back to `workflow-write-test`.
4. Keep the patch minimal: no hardcoded secrets, no silent error swallowing, validate external input at boundaries, avoid deep nesting.
5. Run scoped tests for changed surface.
6. Run typecheck (`tsc --noEmit` or repo equivalent) when applicable.
7. If typecheck/scoped tests fail, fix and rerun; this is not a retry because code changed.

## Gates

- Pre-gate: RED evidence exists; otherwise route to `workflow-write-test`.
- Post-gate: source changed, typecheck clean, scoped tests pass.
- Full regression is opt-in at `workflow-human-check`; do not speculate it would pass.

## Forbidden

- Claiming done/fixed/complete before `workflow-human-check` returns `complete`.
- Skipping `workflow-agent-review` because the change is small.
- Skipping `workflow-e2e` for UI/CLI/API/hook/script behavior changes.
- Asking the user whether to continue; the chain is autonomous until `workflow-human-check`.
- Using TODOs or broad fallbacks to hide the defect.

## Subagents

For independent `/implement` modules, dispatch executor subagents only when parallelization is safe. Give exact task text, file map, acceptance criteria, and excerpts from `implementation-plan.md`; require self-review and test output. Subagent self-review never replaces Smelter review/E2E/human-check.

## Fail Routing

- Missing RED evidence -> `workflow-write-test`
- Scope mismatch in `/implement` -> `workflow-implementation-plan`
- Scope mismatch in `/fix` -> `workflow-investigate` or mode upgrade
- Persistent verification failure after code changes -> stay in `workflow-coding` with evidence

## Terminal State

After post-gate passes, invoke `workflow-agent-review`. Do not stop, summarize as complete, or jump directly to E2E.
