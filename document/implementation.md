---
title: Smelter Workflow v2.4.1 — Implementation Status
status: complete
started: 2026-04-20
completed: 2026-04-20
---

# Smelter v2.4.1 Implementation Status

> Source of truth: `document/workflow.md` (spec v2.4.1).
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
- [x] 12. Critic Watchdog Hook Layer 1 → `scripts/critic-watchdog.mjs` (12 rules)
- [x] 13. Critic Watchdog Agent Layer 2 → `agents/critic-watchdog.md`
- [x] 14. Pattern D Hierarchical (tasker / brainstorm) → SKILL.md templates include lead + sub-agents

## Phase 5 — Multi-Pass Verification (v2.4.1)

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
- `commands/queue.md` — `/queue <intent>` soft redirect; queues a new task to run after current work finishes without interrupting.

Utility skills are not subject to mode whitelist (Iron Law #6). They are available inside any workflow skill or command.

## Active task tracking

In-flight Smelter dev tasks live under `.smt/features/<slug>/task/<task>.state.json` (schema 2.3.0). `scripts/feature-version-check.mjs report` surfaces any state layouts that drift from the current schema so they can be cleaned up.

## Phase 10 — Harness Integrity (v2.4.2)

Closes four structural gate-bypass defects identified 2026-04-20 (single atomic commit).

- [x] T1. `scripts/mode-classifier.mjs` — Korean declarative `한다/했` suffix; `firstSentence()` helper wired into `classify()` so paste-polluted prompts keep intent. Tests: `scripts/mode-classifier.test.mjs` (30 cases).
- [x] T2. `scripts/pre-tool-enforcer.mjs` — PreToolUse block on agent `Write`/`Edit` targeting `**/.smt/features/**/task/*.state.json`. Escape hatch `SMT_HOOK_WRITE=1`. Tests: `scripts/pre-tool-enforcer.test.mjs` (13 cases).
- [x] T3. `scripts/skill-stage-transition.mjs` (new) + `hooks/hooks.json` PostToolUse `Skill` matcher — invoking an allowed workflow skill auto-transitions state. Deferred-completion list: `workflow-e2e`, `workflow-e2e-review`, `workflow-agent-review`, `workflow-team-code-review`, `workflow-verify`, `workflow-human-check`. Tests: `scripts/skill-stage-transition.test.mjs` (12 cases).
- [x] T4. `scripts/state-validator.mjs` (new) + `state-schema.writeState()` integration + `critic-watchdog.mjs` R13 — evidence cross-validation. Every `completed_stages` entry must have a pass event with a resolvable `evidence.path`. R13 catches Bash-based bypass. Tests: `scripts/state-validator.test.mjs` (14 cases).
- [x] T5. `scripts/stop-stage-enforcer.mjs` — renamed from `scripts/stop-e2e.mjs`; unified Stop-hook stage-progression guard. Workflow modes (fix/implement/plan) cannot Stop before reaching a terminal stage (`workflow-human-check`, `done`, or chain end). Order-aware `pickNextStage` (looks forward from `current_stage` index in `allowed_skills` before falling back). Legacy E2E reminder preserved as fallback. Tests: `scripts/stop-stage-enforcer.test.mjs` (15 cases — C1-C11 stage progression, C12-C13 session-aware, C14-C15 stuck-loop).
- [x] T6. **Session-aware active-state resolution** — `stop-stage-enforcer.findActiveStatePath`, `critic-watchdog.readActiveState`, `skill-stage-transition.resolveActiveState`, and `auto-confirm.findActiveTaskState` now accept `sessionId` and prefer `.smt/state/active-feature-<sessionId>.json` over the global `.smt/active_task` pointer. Closes the active-pointer race where a concurrent session's slash command swaps the global pointer and drags this session's Stop / auto-confirm / state-transition chain onto the wrong feature. `pre-tool-enforcer` and `statusline-hud` were already session-aware. Tests: `scripts/stop-stage-enforcer.test.mjs` C12/C13 + `scripts/auto-confirm.test.mjs` "per-session pointer overrides global active_task".
- [x] T7. **Stuck-loop escape** — `stop-stage-enforcer.mjs` now tracks a per-project + per-session loop counter at `/tmp/smelter-stop-loop-<projectHash>-<sessHash>.json`. Signature = `slug:mode:current_stage:completed_count`. After `STUCK_LOOP_THRESHOLD` (default 3) consecutive identical-signature blocks (no PostToolUse:Skill advanced state in between), Stop is allowed with a stuck-loop warning so the agent and user can break the loop. Counter resets on signature change or 30-min staleness. Reproduces and resolves the 2026-04-20 incident where another session looped indefinitely on `feature-mo6thp2b-a22b64, mode=fix, stage=null` because the agent could only respond with text. Tests: `scripts/stop-stage-enforcer.test.mjs` C14/C15.

Artifacts: `.smt/features/harness-integrity-4-fixes/{plan.md,brainstorm.md,investigation.md,tasks.md,decisions.md}`.

## Phase 11 — Slug Stability (v2.4.3)

Closes the slug-instability defect observed empirically: every prompt was creating a new `.smt/features/<slug>/` directory, orphaning prior work within the same session.

- [x] C. `scripts/keyword-detector.mjs` — new `shouldCreateNewFeature(directory, sessionId, prompt, source)` in `seedWorkflowState`. Rules:
  - Slash commands always create new feature (explicit intent).
  - Prompts matching `새 feature | 새 기능 | 새 피처 | new feature | 다른 작업 | 새로 시작` create new.
  - Otherwise, per-session pointer `.smt/state/active-feature-<session_id>.json` is inspected — if the pointed state's `current_stage !== 'done'`, reuse the existing feature (no new directory, no new state file).
  - Concurrent-session safe: per-session pointer keyed by `session_id` so one session never drags another's feature.

Tests: 5 new cases in `scripts/keyword-detector.test.mjs` (`CSS1–CSS5`) cover natural-language reuse, slash-command new, post-slash reuse, explicit-new phrase, and cross-session isolation. Live E2E (5 scenarios piped through real `keyword-detector.mjs` stdin) matches expected behavior.

Not in scope (explicitly deferred): A (write-path hardening — handled in a parallel session as stage-based), B (simple-fix already exists; no middle tier needed), D (schema_version migration — not a current pain point).

## Phase 12 — auto-confirm + classifier fit (v2.4.4)

Closes three gaps observed 2026-04-20 when a one-paragraph documentation-guidance prompt (`Read 툴을 쓰도록 가이드를 넣어줘`) routed to `/fix` and triggered the full repair chain.

- [x] H1. `scripts/mode-classifier.mjs` — `simple_fix` pattern set extended with doc/comment/guide add patterns (`가이드 (넣어|추가)`, `주석 (넣어|추가|달아)`, `설명 (넣어|추가|보강)`, `문서화`/`문서 (넣어|추가|보강)`, `docstring`, `add|insert|append (a )?(comment|doc|docs|docstring|guide|note)`). Noun-before-verb requirement keeps pattern narrow. Tests: `scripts/mode-classifier.test.mjs` (10 new cases, 40 total).
- [x] H2. `scripts/auto-confirm.mjs` — `decide()` pass-branch now names the next skill via `pickNextStage(state)` (imported from `stop-stage-enforcer.mjs`; single-direction dep). `buildPromptInjection` `advance` case emits the explicit skill name when `payload.skill` is set. Removes the prior vague "Advance to the next skill per current mode" which forced the agent to guess from context. Tests: `scripts/auto-confirm.test.mjs` (4 new cases).
- [x] H3. `scripts/auto-confirm.mjs` — stuck-loop guard. Per-project + per-session loop counter at `/tmp/smelter-auto-confirm-loop-<projectHash>-<sessHash>.json`. Signature = `slug:mode:current_stage:decision_action`. After `AUTO_CONFIRM_STUCK_THRESHOLD` (3) consecutive identical-signature runs with no state progression, CLI entry halts with stderr warning so session can end cleanly. Stale counter TTL 30 min. Mirrors stop-stage-enforcer's loop guard but fires earlier (per action-aware signature) to cover decide()-level churn. Tests: `scripts/auto-confirm.test.mjs` (7 new cases).

Artifacts: `.smt/features/auto-confirm-훅을-개선할-수-있는-방법은-사실-이번-변경은-simple-fix여/task/{plan.md,investigation.md,investigation-review.md,tasks.md,tasks-review.md}`.

Totals: `mode-classifier.test.mjs` 40 pass, `auto-confirm.test.mjs` 85 pass.

## Phase 13 — Session isolation (global `.smt/active_task` removal, v2.4.5)

Closes the defect where concurrent Claude Code sessions sharing a project would overwrite each other's workflow chain target. `.smt/active_task` was a single global file rewritten by every slash command, so a second session's `/fix` would strand the first session's mid-flow chain. T6 (session-aware readers) mitigated reads; this phase completes the cut by removing writes too.

- [x] T8a. **keyword-detector stops writing global pointers** — `scripts/keyword-detector.mjs:seedWorkflowState` reuse branch (previously lines 272, 276) and create branch (previously 367, 388) no longer write `.smt/active_task` nor the non-scoped `.smt/state/active-feature.json` when `session_id` is present. Per-session pointer `.smt/state/active-feature-<sessionId>.json` is primary; non-scoped pointer is retained only as a session-less fallback for legacy CLI / `session-sim.mjs`.
- [x] T8b. **Consumer fallbacks collapsed** — `stop-stage-enforcer.findActiveStatePath`, `critic-watchdog.readActiveState`, `skill-stage-transition.resolveActiveState`, `auto-confirm.findActiveTaskState` all drop the `.smt/active_task` fallback branch. Resolution is now: per-session pointer → non-scoped pointer (session-less only) → null. `auto-confirm` preserves its "most-recently-modified *.state.json" tail for test-fixture convenience.
- [x] T8c. **critic-watchdog R12 session-aware** — `rule12_workflowStageRequired` now reads `.smt/state/active-feature-<sessionId>.json` when `input.session_id` is set, matching `pre-tool-enforcer.mjs:97-99`. A concurrent session's non-scoped pointer can no longer fire R12 against this session's edits.
- [x] T9. **`clearActiveFeature()` extended** — `scripts/keyword-detector.mjs:clearActiveFeature(directory, sessionId)` now unlinks the per-session pointer AND the legacy `.smt/active_task` (transitional), not just the non-scoped `active-feature.json`. Fixes the latent bug where `/cancel` left a stale per-session pointer so the next prompt silently resumed the cancelled chain.
- [x] T10. **Security tests re-targeted** — `skill-stage-transition.test.mjs` S1/S2 previously forged `.smt/active_task`. Post-migration the attack surface is the per-session pointer's `slug` field (slug → path construction). Tests rewritten to forge adversarial slugs and assert containment + canonical-shape checks still reject them.

**Tests updated:**
- `scripts/stop-stage-enforcer.test.mjs` — `setupProject({ sessionId })` writes per-session pointer when given a session; C12/C13 rewritten; 15/15 pass.
- `scripts/skill-stage-transition.test.mjs` — `seedState` writes per-session pointer; S1/S2 attack-vector updated; 12/12 pass.
- `scripts/auto-confirm.test.mjs` — `findActiveTaskState` test names updated to reflect new resolution order; 85/85 pass.
- `scripts/workflow-scenarios.test.mjs` — CLI smoke test writes per-session pointer; 111/111 pass after aligning schema assertions with the current `state-schema.mjs` enums.
- `scripts/pre-tool-enforcer.test.mjs` — unchanged; `.smt/active_task` write-block is still tested and still holds (defense-in-depth).

Artifacts: `.smt/features/왜-또-휴먼-체크-안하지/task/{migration-investigation.md,tasks.md,tasker_review.md}`.

## Phase 14 — stop-stage-enforcer recovery + entry-stage seed + broadened guard (v2.4.6)

Closes three defects observed 2026-04-20 that caused `/fix`/`/investigate`/`/plan` to stall in a "same state" Stop loop:

- [x] F1. **File corruption repaired** — `scripts/stop-stage-enforcer.mjs` previously contained a pasted diff artifact at line 5786 plus scattered non-ASCII glyphs (lines 212/492/805/940/1095/1244/1374/1510/1626–5790) that Node ESM rejected with `SyntaxError`. File reauthored cleanly (≈330 lines) preserving all prior exports.
- [x] F2. **Entry stage seeded** — `scripts/keyword-detector.mjs:seedWorkflowState` now sets `state.current_stage = modeCfg.entry_skill` when the entry skill is in `allowed_skills`. Prevents Stop from blocking on `current_stage=null` every round; the first `workflow-*` skill invocation now advances from a known entry stage instead of guessing. Tests: `scripts/test-keyword-detector.mjs` (expects `workflow-investigate` for `/fix`).
- [x] F3. **Guard set broadened** — `WORKFLOW_MODES_FOR_STAGE_GUARD` extended from `{fix, implement, plan}` to include `{investigate, verify, simple_fix}`. All Smelter modes now enforce terminal-stage exit. Single-stage modes (`verify`, `simple_fix`) pass via `isTerminalStage()` since their only allowed_skill is the last. Tests: `scripts/stop-stage-enforcer.test.mjs` C16 (investigate non-terminal → block + advance).
- [x] F4. **Session-aware summary** — `stop-stage-enforcer.main()` now calls `getActiveFeatureSummary(cwd, stdinJson.session_id)` so a concurrent session's non-scoped pointer can no longer supply the wrong E2E surface. Tests: `scripts/stop-stage-enforcer.test.mjs` C17 (two features, session selects the right summary).

Totals: `stop-stage-enforcer.test.mjs` 17/17, `test-keyword-detector.mjs` 6/6, `workflow-scenarios.test.mjs` 111/111, `auto-confirm.test.mjs` 86/86, `critic-watchdog.test.mjs` 9/9.
