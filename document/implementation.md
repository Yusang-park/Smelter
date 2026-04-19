---
title: Smelter Workflow v2.3.0 — Implementation Status
status: complete
started: 2026-04-20
completed: 2026-04-20
---

# Smelter v2.3.0 Implementation Status

> Source of truth: `document/workflow.md` (spec v2.3.0).
> Principle: sequential execution, respect dependencies, no omissions.

## Phase 1 — Foundation

- [x] 1. `state.json` schema v2 → `scripts/state-schema.mjs` (SCHEMA_VERSION 2.3.0 + round validation)
- [x] 2. Mode classifier engine → `scripts/mode-classifier.mjs`
- [x] 3. Mode definition files (5) → `modes/*.json` (simple_fix, fix, investigate, plan, implement)
- [x] 4. 13 workflow-* SKILL.md → `skills/workflow-*/SKILL.md` (all English, all at version 2.3.0)

## Phase 2 — Routing

- [x] 5. Producer chain router → `scripts/route-on-fail.mjs`
- [x] 6. Auto-confirm hook (production) → `scripts/auto-confirm-v2.mjs` (Stop-hook decision tree + chained-mode auto-advance)
- [x] 7. Stall detection → `scripts/stall-detector.mjs` (6 signals + 4-Level cascade)

## Phase 3 — Parallelism (Pattern C)

- [x] 8. Parallel Delegation dispatcher → `scripts/parallel-dispatcher.mjs`
- [x] 9. Aggregator agent → `agents/aggregator.md`
- [x] 10. Conflict-Resolver agent → `agents/conflict-resolver.md`

## Phase 4 — Advanced Patterns

- [x] 11. Pattern B Dual Adversarial (agent-review) → SKILL.md encodes `code-reviewer + security-reviewer`
- [x] 12. Critic Watchdog Hook Layer 1 → `scripts/critic-watchdog.mjs` (10 rules)
- [x] 13. Critic Watchdog Agent Layer 2 → `agents/critic-watchdog.md`
- [x] 14. Pattern D Hierarchical (tasker / brainstorm) → SKILL.md templates include lead + sub-agents

## Phase 5 — Multi-Pass Verification (v2.3.0)

- [x] 15. Verification engine → `scripts/verification-rounds.mjs`
- [x] 16. Round prompt templates → `templates/verification/round-{1,2,3}*.md`
- [x] 17. 3-round enforcement in 6 review SKILL.md files
- [x] 18. Debugger agent (Cascade Level 1) → `agents/debugger.md`

## Phase 6 — Cleanup (complete)

- [x] 19. Remove step-engine directories (`workflows/`, `steps/`, `presets/`) and related scripts.
- [x] 20. Remove step-engine tests.
- [x] 21. Rewire `hooks/hooks.json` to the current skill-composition hooks only.
- [x] 22. Rewrite `document/workflow.md` and `document/implementation.md`.
- [x] 23. Update `CLAUDE.md`, `AGENTS.md`, `README.md` for the current command set.

## Summary

| Phase | Items | Status |
|-------|-------|--------|
| 1 Foundation | 4 | complete |
| 2 Routing | 3 | complete |
| 3 Parallelism | 3 | complete |
| 4 Advanced | 4 | complete |
| 5 Multi-Pass | 4 | complete |
| 6 Cleanup | 5 | complete |
| **Total** | **23/23** | **complete** |

## Execution rules

- Mark `[x]` immediately on task completion.
- Respect dependency order; do not start next task until previous is verified.
- On failure, follow Appendix C dependency graph in `document/workflow.md` for re-routing.
- Any code change here requires matching updates in `document/workflow.md` per root `CLAUDE.md` documentation-sync rule.

## Utility skills (mode-unrestricted)

- `skills/deep-interview/SKILL.md` — planning-first requirement discovery.
- `skills/queue/SKILL.md` — `/queue <intent>` soft redirect; queues a new task to run after current work finishes without interrupting.

Utility skills are not subject to mode whitelist (Iron Law #6). They are available inside any workflow skill or command.

## Active task tracking

In-flight Smelter dev tasks live under `.smt/features/<slug>/task/<task>.state.json` (schema 2.3.0). `scripts/feature-version-check.mjs report` surfaces any state layouts that drift from the current schema so they can be cleaned up.
