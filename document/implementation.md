---
title: Smelter Workflow v3 — Implementation Status
status: in_progress
started: 2026-04-20
updated: 2026-04-21
---

# Smelter v3 Implementation Status

> Source of truth: `document/workflow.md`.
> Principle: sequential execution, respect dependencies, no omissions.

## Release v3.1.1 — 2026-04-22

Patch release. Headline: **Review Evidence Verifier** — closes the hallucinated-anchor loop where `workflow-*-review` skills could emit fail verdicts citing non-existent file:line anchors, routing indefinitely to `workflow-coding`.

Contents:
- Review evidence verifier hook (`scripts/review-evidence-verifier.mjs`) + 10 unit + 12 E2E scenarios.
- Evidence Integrity clauses in 5 fail-routing review skills + `document/workflow.md` §9-4.
- Auto-confirm classifier continue-bias + review-fail routing hardening (prevents pass-advance when prose verdict is fail).
- Session state staleness guard (`ACTIVE_STATE_MAX_AGE_MS`).
- Caveman integration correction — vendored upstream skill source, codex-mode propagation to sub-agents / statusline HUD.
- Model-mode switch test fix (`scripts/test-model-mode-switch.mjs` — reset path assertion setup).
- Surface extraction helper + state schema updates (`scripts/lib/surface-extraction.mjs`, `scripts/state-schema.mjs`).

Files changed: see git log for this release.

## Phase v3.2 — `/fix` pipeline collapse + per-mode round override (2026-04-23)

User reported `/fix` still felt slow despite v3.1 target-type dispatch. Root cause: `medium` pipeline (11 skills, including tasker/tasker-review/team-code-review) triggered for any bug with >3 files or multi-surface, and every mid-pipeline review still ran 2 rounds. v3.2 simplifies.

- [x] v3.2-1. **`medium` pipeline removed + /fix pipelines renamed.** `/fix` collapses to two pipelines: `fix` (8 skills, all `bug_fix` regardless of scope) and `fix_simple` (4, typo/dialogue — renamed from `minimal` for clarity). `extend_existing`/`new_feature`/`refactor`/`migration` all return `upgrade_required` for `/fix` → escalate.
- [x] v3.2-2. **`extend_light` pipeline added** for `/implement + target_type: extend_existing`. 9 skills: investigate → investigate-review → tasker → write-test → coding → agent-review → e2e → e2e-review → human-check. Brainstorm family + tasker-review + team-code-review dropped because the existing feature defines scope and Pattern B agent-review suffices at this scale.
- [x] v3.2-3. **Per-mode round override** — `verification_rounds.mode_overrides.fix: { default: 1, workflow-e2e-review: 2, workflow-human-check: 3 }`. `getVerificationRounds(skill, modeName?, cfg?)` signature extended; modeName lookup takes precedence over bucket default. Non-/fix modes unchanged (mid=2, terminal=3).
- [x] v3.2-4. **`selectPipeline` simplified** — scope-dependent `upgrade_to_medium_when` branch deleted. `target_type_routing` is now a string map. Mode gates: `/fix + extend_existing → upgrade_required`; `/implement + extend_existing → extend_light`; `/implement + others → full`.
- [x] v3.2-5. **`modes.implement.target_type_dispatch: true`** — enables /implement to honor extend_existing routing. Other target_types stay on declared `full` pipeline.
- [x] v3.2-6. **Tests** — `workflow-loader.test.mjs` rewritten to cover fix/extend_light/medium-removal/per-mode rounds (33 tests). `keyword-detector.test.mjs` MK2/MK3 updated to assert 8-skill fix instead of 11-skill medium. `workflow-scenarios.test.mjs` SCENARIO 1 + fixModeState helper switched to fix order; new `fullPipelineState` helper for generic producer-chain tests that need tasker/team-code-review whitelisting.
- [x] v3.2-7. **Docs** — `document/workflow.md` §3.2/§3.2.1/§3.2.2/§4-2/§4-3 updated. `commands/fix.md` + `commands/implement.md` rewritten to reflect new pipelines + /fix round override.

### Expected time savings (common `/fix bug_fix` path)

| v3.1 medium (complex) | v3.2 fix | Savings |
|-----------------------|----------------|---------|
| 11 skills × mid rounds (4 × 2) + terminal (3 × 3) | 8 skills × mid rounds (3 × 1) + terminal (2 × 3 + 1 × 2) | ~40% fewer review rounds; tasker + tasker-review + team-code-review eliminated. |

---

## Phase v3.1 — `/fix` speed/quality balance (2026-04-22)

### Review Evidence Verifier (2026-04-22)

- [x] `scripts/review-evidence-verifier.mjs` — new PostToolUse(`Edit|Write`) hook. When a review artifact (`*_review.md` / `*-review.md`) is written with a `fail` verdict, every symptom must be grounded in a strict anchor `**Evidence:** `path:line[-line]` "quote"`. Hook resolves path (abs or cwd-relative), checks line bounds, and asserts the normalized quote appears in the cited line/range. On any violation: `decision: block` with a path-specific reason. `fail` verdict with zero anchors is also blocked.
- [x] `scripts/review-evidence-verifier.test.mjs` — 10 real-subprocess E2E cases (stdin JSON → stdout JSON).
- [x] `hooks/hooks.json` + `settings.json` — registered under PostToolUse matcher `Edit|Write`.
- [x] Evidence Integrity section appended to 5 fail-routing review skills: `workflow-investigate-review`, `workflow-tasker-review`, `workflow-agent-review`, `workflow-e2e-review`, `workflow-team-code-review`. `workflow-brainstorm-review` is exempt (reshape edges, not producer chain).
- [x] `document/workflow.md` §9-4 — canonical rule specification + grandfathering note.

### Auto-confirm classifier + review-fail routing hardening (2026-04-22)

- [x] `scripts/auto-confirm.mjs::buildClassifierPrompt` — continue-biased with explicit pattern list: conditional ("원하면", "if you want"), question-offer ("만들까요", "할까요", "지금 실행?", "proceed now?"), remaining-work ("남은 건", "what remains"). HARD RULE: single concrete next step without branching options → always continue.
- [x] `AUTO_CONFIRM_STUCK_THRESHOLD` lowered from 3 → 2. Same signature repeated twice escapes with yellow stderr warning.
- [x] `detectReviewVerdict` + `detectReviewFailCause` helpers added. `decide()` stage_complete branch for `*-review` skills now routes via `route-on-fail` when the prose verdict is `fail` instead of blindly advancing via `pickNextStage`.
- [x] `scripts/skill-stage-transition.mjs` — PostToolUse:Skill pass-event auto-write now reads the review artifact and writes `result: 'fail'` + `cause` when the artifact declares a fail verdict. Closes the path where `decide()` would see `last.result === 'pass'` and advance forward despite the actual fail verdict.
- [x] `findActiveTaskState` — mtime-fallback staleness guard (`ACTIVE_STATE_MAX_AGE_MS = 1h`). Casual-chat sessions no longer pick up abandoned state.json files from prior workflow runs.

### Caveman integration correction (2026-04-22)

- [x] Replaced the hardcoded SessionStart concise prompt with vendored upstream Caveman skill content from `skills/caveman/SKILL.md`.
- [x] `src/rules/defaults.ts` now exports `CAVEMAN_SYSTEM_PROMPT` from the same vendored skill source.
- [x] Added targeted regression tests for SessionStart Caveman injection and defaults export behavior.
- [x] Synced Codex model-mode into `~/.smt/config.json.codexMode` during `SessionStart` so Stop/UserPromptSubmit hooks can reliably detect codex sessions even when only `SMELTER_MODEL_MODE=codex` is present.
- [x] Extended `scripts/auto-confirm.mjs::pickSubAgentModel()` to treat `SMELTER_MODEL_MODE=codex` the same as `CODEX_MODE=1`, forcing queued sub-agents onto `haiku` in codex windows.
- [x] Hardened `scripts/keyword-detector.mjs` so an LLM `passthrough:true` hint is overridden when the current session already has an active, non-terminal workflow pointer. This preserves Smelter continuation in codex windows instead of silently dropping the session out of workflow mode. Transcript-paste passthrough remains exempt.
- [x] Fixed multi-window mode bleed by making `scripts/claude-wrapper.mjs` inject `SMELTER_MODEL_MODE=codex` (+ `CODEX_MODE=1`) for codex launches and `SMELTER_MODEL_MODE=claude` for regular launches, so `scripts/lib/subagent-classifier.mjs` can resolve model family from session env before shared state files.
- [x] Fixed `scripts/statusline-hud.mjs` to prefer Codex mode label over raw stdin `display_name` in Codex windows, so HUD shows `Codex ...` instead of leaking plain `gpt-5.4`.
- [x] Fixed concurrent codex/claude window bleed via `CLAUDE_CONFIG_DIR` scoping. `scripts/set-model-mode.mjs::applyCodexMode()` now writes `additionalModelOptionsCache` to the codex-scoped file `~/.claude/.claude-<sha8(NFC(dir))>.json` (matches the Claude binary's `gS()` resolver), and `scripts/claude-wrapper.mjs` injects `CLAUDE_CONFIG_DIR=~/.claude` into the codex child so Claude Code reads that scoped file instead of the global `~/.claude.json`. Plain `claude` windows (no wrapper, no env) keep reading the global file which is never mutated → concurrent codex/claude windows are fully isolated. `~/.claude/` remains the shared dir for settings/agents/commands/hooks. Codex child exit only runs a legacy-global `clearModelCache()` safety net; the scoped file is intentionally left populated so a concurrent second codex window isn't disrupted when the first exits (every codex launch writes the same constant `CODEX_MODEL_OPTIONS`, so stale is indistinguishable from fresh). Plain `claude` through the wrapper also no longer clears the scoped file for the same reason.


User reported: brainstorm→review cycle + tasker + reshape → `/fix` takes longer than `/implement` (inverted). v3.1 balances speed and quality by (a) collapsing the three split YAML configs into one unified file, (b) adding target-type pipeline dispatch in `/fix`, (c) reducing mid-pipeline review rounds from 3 to 2, and (d) enforcing workflow-human-check before `git commit`.

- [x] v3.1-1. **Unified config** → `modes/workflow.yaml` (single file). Deleted the v3 split (`modes/skills.yaml`, `modes/pipelines.yaml`, `modes/modes.yaml`).
- [x] v3.1-2. **Target-type dispatch** — `selectPipeline(mode, {target_type, file_count, surface_count})` in `workflow-loader.mjs`. `/fix` picks pipeline at runtime: `typo`/`dialogue` → `minimal` (4 skills), simple `bug_fix` → `light` (8 skills), complex `bug_fix` / `extend_existing` → `medium` (11 skills). `new_feature`/`refactor`/`migration` → `upgrade_required` (escalate to `/implement` or `/think`). Cuts tasker overhead on trivial fixes. **Superseded by v3.2** — see below.
- [x] v3.1-3. **Verification round split** — `verification_rounds: { mid_pipeline: 2, terminal: 3 }` in `workflow.yaml`. Mid reviews (brainstorm-review, investigate-review, tasker-review, agent-review) drop to 2 rounds (omission + contradiction; edge-case dropped for speed). Terminal reviews (e2e-review, team-code-review, human-check) stay at 3 rounds. `min_verification_rounds: 2` in 4 SKILL.md files; 3 kept in e2e-review and team-code-review.
- [x] v3.1-4. **`getVerificationRounds(skill)` helper** in `workflow-loader.mjs` — reads skill's `rounds` bucket field from `workflow.yaml`. Default `mid_pipeline`.
- [x] v3.1-5. **Commit gate** — `pre-tool-enforcer.mjs` PreToolUse:Bash rule: when command starts with `git commit` AND state.mode ∈ {fix, implement} AND workflow-human-check not passed → block with clear reason. Closes queued bug: agent committing before human-check.
- [x] v3.1-6. **Human-check visual render** — `skills/workflow-human-check/SKILL.md` new section "Visual Artifact Rendering (v3.1)": `Read` tool invocation on every `.png`/`.jpg`/`.webm` under artifacts/; multimodal inline render in terminal; user sees output before `AskUserQuestion`.
- [x] v3.1-7. **Tests** — `scripts/lib/workflow-loader.test.mjs` expanded to 28 tests covering v3.1 features (selectPipeline × 6, getVerificationRounds × 3, unified-file load, legacy-file absence).
- [x] v3.1-8. **Docs** — `document/workflow.md` §4 updated for v3.1 pipelines + target-type dispatch + round split.

### Non-regression verification

All suites green after v3.1: workflow-loader 28/28, auto-confirm 115/115, workflow-scenarios 118/118, mode-classifier 39/39, skill-stage-transition 17/17, state-validator 18/18, pre-tool-enforcer 13/13, critic-watchdog 24/24, keyword-detector 26/26. **398/398 pass.**

### Deferred to future phase

- Reshape-event gate (original queued bug about `workflow-investigate` running twice). Deferred because investigating revealed the reported trace was spec-conformant §5-2 reshape; the true pain point was the `critic-watchdog` plan.md false-positive, which v3.1-2 (target_type dispatch) + Part B (mode-aware R07, still in `.smt/features/smelter-v3-duplicate-skill-fix/` design) addresses.
- Brainstorm iteration audit: the session that produced this phase itself ran through 3 brainstorm→review cycles before committing. Post-analysis lives in the deferred design doc.

---

## Phase v3 — Mode Simplification + Superpowers Hybridization (2026-04-21)

Consolidates six modes into five, removes v2 legacy (modes/*.json, /plan, /simple-fix), and adopts file-driven routing from obra/superpowers while preserving Smelter's hook-enforced workflow fixing.

- [x] v3-1. Three-file YAML config → `modes/skills.yaml` + `modes/pipelines.yaml` + `modes/modes.yaml`.
- [x] v3-2. Loader → `scripts/lib/workflow-loader.mjs` + `scripts/lib/workflow-loader.test.mjs` (16 tests passing).
- [x] v3-3. `scripts/state-schema.mjs::MODES` → 5 v3 modes (`think/fix/implement/investigate/verify`). `CAUSE_ENUM` extended with `visual_mismatch` + `e2e_infra_missing`.
- [x] v3-4. `scripts/keyword-detector.mjs` — v3 loader only; legacy JSON fallback removed; `COMMAND_TO_MODE` + `COMMAND_CONFIG` + slash-command regex + `validCommands` all v3.
- [x] v3-5. `scripts/mode-classifier.mjs` — `EXPLICIT_COMMANDS` + `MODES_WHITELIST` v3.
- [x] v3-6. `scripts/lib/subagent-classifier.mjs` — `VALID_MODES` set + `MODE_CLASSIFIER_PROMPT` v3.
- [x] v3-7. `scripts/skill-stage-transition.mjs` — uses `workflow-loader.getMode` (no more `modes/<mode>.json` read).
- [x] v3-8. `scripts/auto-confirm.mjs::detectModeTransitionSignal` — regex alternation extended to v3 set.
- [x] v3-9. `scripts/session-end.mjs::EXPECTED_COMMANDS` — v3 set; section 3 now validates `modes.yaml/pipelines.yaml/skills.yaml` presence and rejects leftover `modes/*.json`.
- [x] v3-10. Delete `modes/*.json` (6 files: fix/implement/investigate/plan/simple_fix/verify.json).
- [x] v3-11. Delete `commands/plan.md` + `commands/simple-fix.md`. Create `commands/think.md`. Update `commands/implement.md` to reference `modes/modes.yaml`.
- [x] v3-12. `skills/workflow-e2e/SKILL.md` — new `## Infra Preflight` section: harness auto-install (Playwright) when absent, new gate postcondition `e2e_infra_present`.
- [x] v3-13. `skills/workflow-e2e-review/SKILL.md` — new `## Visual Inspection` section: every screenshot opened, 3+ video frames reviewed, failures emit `cause: visual_mismatch` → routes to `workflow-coding`.
- [x] v3-14. Test fixtures updated: `scripts/lib/__fixtures__/mode-classifier-stub.mjs` (plan→think, simple_fix→fix); `scripts/auto-confirm.test.mjs`, `scripts/workflow-scenarios.test.mjs`, `scripts/skill-stage-transition.test.mjs`, `scripts/keyword-detector.test.mjs`, `scripts/mode-classifier.test.mjs`, `scripts/lib/subagent-mode-classifier.test.mjs` — all v3.
- [x] v3-15. `document/workflow.md` §1-2 + §4 + §5-1 producer chain + §5-4 upgrade graph updated for v3.
- [x] v3-16. `document/workflow.md` — §1-2 mode summary, §4 mode definitions, §5-1 producer chain (new causes), §5-4 upgrade diagram, §7 file tree, §11-5b auto-confirm reference all updated. Routing table + mode summary now v3.
- [x] v3-17. `document/workflow.ko.md` — §1-2 auto-routing + mode summary tables + magic keyword table + §4 mode definitions (think/fix headers), upgrade diagram, file tree all synced to v3.
- [x] v3-18. All test suites green under v3: auto-confirm 115/115, workflow-scenarios 118/118, mode-classifier 39/39, workflow-loader 16/16, keyword-detector 26/26, skill-stage-transition 17/17, state-validator 18/18, critic-watchdog 24/24, pre-tool-enforcer 13/13, dev-install 25/25, plus hook-audit/transcript-reader/feature-summary/yellow-tag/post-tool-verifier/tool-retry/auto-confirm-consumer/subagent-mode-classifier — **421/421 pass**.
- [x] v3-19. `scripts/keyword-detector.mjs` collateral fixes discovered during migration:
  - `main()` gated by `import.meta.url === argv[1]` — prevented `node --test` runner hangs when the module was imported for in-process unit tests.
  - `isTranscriptPaste` counts total pattern occurrences (was distinct-pattern-count), so two ⏺ bullets alone trigger the heuristic (TPP4).
  - `extractExplicitHarnessCommand` regex uses `[\s\S]*` instead of `.*` so `/fix` prefix matches when followed by multi-line pasted transcript (TPP6).

### Added user requirements (2026-04-21)

- **Terminal human-check**: `fix` + `implement` pipelines end with `workflow-human-check` (enforced by pipeline shape in `pipelines.yaml`). Plan §8.
- **E2E lock-in**: infrastructure auto-install when missing (Playwright for UI); visual artifacts inspected frame-by-frame, mismatch loops back to `workflow-coding`. Plan §7.
- **Removed v2 legacy completely**: no fallback code paths, no backward-compat aliases. `/plan` and `/simple-fix` fully deleted. Plan rollout §Rollout Plan.

### Added user requirements (2026-04-22)

- **E2E credentials policy** (`skills/workflow-e2e/SKILL.md` §Credentials, `document/workflow.md` §8-4, `document/workflow.ko.md` §6-3):
  - Auth-required scenarios read secrets from a git-ignored `.env.e2e` at the project root (never `.env`, never committed).
  - Canonical variables: `E2E_ACCOUNT_ID`, `E2E_ACCOUNT_PW`, `E2E_COOKIE`, `E2E_KEY` (scenario-specific keys use the `E2E_` prefix).
  - New fail `cause: missing_credentials` — evidence `file_absent` (missing `.env.e2e`) or `parse` (missing key). Halts for user to populate the file; fabricating values or mocking auth is disallowed.

---

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

## Phase 15 — Workflow chain enforcement (B안 Phase 1, v2.4.7)

Closes the Stop-loop observed after v2.4.6: seeded `current_stage=entry_skill` was never advanced because the PostToolUse:Skill hook only accepted `workflow-*` skills and the main agent usually answered in prose without actually invoking `workflow-investigate`. The Stop hook kept blocking with the same reason; `STUCK_LOOP_THRESHOLD` was the only exit. User spec: "메인이 완료하지 않은 stage는 올리지 말고, 완료한 stage는 올라가도록".

- [x] F1. **skill-stage-transition extended to entry commands** — `scripts/skill-stage-transition.mjs` now recognises `Skill(skill: 'fix'|'investigate'|'plan'|'implement'|'verify'|'simple-fix')`. When the invoked command matches `state.mode`, the hook seeds `current_stage = <mode>.entry_skill` (read from `modes/<mode>.json`) and writes state via `writeState` (idempotent). `completed_stages` stays empty so `state-validator.validateEvidenceIntegrity` (Iron Law #5) is not violated. Tests: `scripts/skill-stage-transition.test.mjs` ST-E1..ST-E4 (new; 16 cases total).
- [x] F2. **stop-stage-enforcer entry_not_started wording** — `scripts/stop-stage-enforcer.mjs:buildBlockReason` now emits `[Stage] entry_not_started: invoke Skill(skill: '<stage>') ...` when `completed_stages.length === 0 && events.length === 0`. Previous "advance to <next>" was misleading because it pointed past a stage that had never actually run. Mid-chain still uses "advance to" wording. Tests: `scripts/stop-stage-enforcer.test.mjs` E1/E2 + C16 updated (19 cases total).
- [x] F3. **Watchdog R15 — stage-skipping code edit** — `scripts/critic-watchdog.mjs:rule15_stageSkipOnCodeEdit`. Fires on `Edit/Write` of source files (`src/`, `scripts/`, `bin/`, `lib/`, `hooks/`) when `current_stage !== 'workflow-coding'` and the mode allows `workflow-coding`. Test files exempt. Block reason instructs `Skill(skill: 'workflow-coding')`. Distinct from R05 (coding stage + no RED) and R12 (null stage). Tests: `scripts/critic-watchdog.test.mjs` (4 new R15 cases, 13 total).
- [x] F4. **auto-confirm MANDATORY injection + direction + lastAssistantText** — `scripts/auto-confirm.mjs`:
  - `decide()` now tags `payload.direction ∈ { 'enter', 'advance', 'back' }` on `enter_skill` / `advance` results. Producer-chain routing via `route-on-fail` uses `'back'`.
  - New `formatMandatoryInjection({ skill, direction, subAgentModel, state, lastAssistantText })` emits `[MANDATORY WORKFLOW STEP]` block with `You MUST invoke Skill(skill: '<next>') as the FIRST tool call of your reply.` and embeds main's previous message (400-char truncated) so the sub-agent classifier pattern carries forward context (condition 1 requirement).
  - `buildPromptInjection` now accepts `{ lastAssistantText }` and CLI entry plumbs `input.last_assistant_text` through. Tests: `scripts/auto-confirm.test.mjs` (3 new MANDATORY cases, 89 total).

**User conditions satisfied (Phase 1):**
| Requirement | Mapping |
|---|---|
| 1. 경량 서브에이전트로 last message + workflow 지시 텍스트 | `formatMandatoryInjection` embeds last message; consumer injects on next turn; `Task(subagent_type=...)` reference kept |
| 2. 메인이 workflow 불이행 시 지시 | R15 block-with-guidance + MANDATORY injection |
| 3. stop hook이 미완료 stage를 상승시키면 안됨 | stop-stage-enforcer is read-only; wording changed to `entry_not_started` so agent sees "enter" not "advance" |
| 4. 이전 단계로 회귀 지시 | `direction='back'` tag + `go BACK to <skill>` wording in injection |
| 5. watchdog로 단계 전환 유도 | R15 blocks stage-skipping edits; guides toward proper `Skill(skill: 'workflow-coding')` |

**Phase 2 (added same release):** Stage-completion classifier satisfies both user conditions — stage must NOT advance until the work is done, and stage MUST advance once the work IS done.

- [x] G1. **`classifyStageCompletionViaSubAgent`** — new in `scripts/auto-confirm.mjs`. Spawns the lightweight model (sonnet/haiku) with `buildStageCompletionPrompt({ lastMessage, currentStage, mode })`. Returns `{ verdict: 'complete'|'incomplete'|'unknown', summary }`. Tests inject stubs via `SMT_STAGE_CLASSIFIER_CMD` env var.
- [x] G2. **`shouldRunStageCompletionClassifier`** — gate that fires only when `current_stage` is set, `lastAssistantText` has substance, and no pass event exists for the current stage yet. Avoids per-Stop sub-agent churn.
- [x] G3. **`decide()` stage-complete / stage-incomplete branches** — invoked before the legacy `classify_needed` fallback. `stage_complete` payload carries `{ stage, nextSkill, summary, artifact, lastMessage }`. `stage_incomplete` carries `{ stage, summary }`.
- [x] G4. **Auto-artifact write on `stage_complete`** — CLI entry writes a canonical artifact (`investigation.md`, `tasks.md`, …) with classifier summary + main's last message excerpt when the artifact is missing. **Iron Law #5 safe**: we do NOT flip `completed_stages` here. The artifact only enables the next legitimate `skill-stage-transition` run (after the main invokes the workflow-* skill) to record pass legitimately.
- [x] G5. **Injection templates** — `buildPromptInjection` handles `stage_complete` (MANDATORY: invoke `Skill(skill: '<nextSkill>')`, with artifact-verification reminder) and `stage_incomplete` (MANDATORY: re-invoke `Skill(skill: '<stage>')`, reason from classifier summary).

Tests: 9 new in `scripts/auto-confirm.test.mjs` (prompt shape, gate, decide branches, injection shape). Totals: auto-confirm 98, stop-stage-enforcer 19, critic-watchdog 13, skill-stage-transition 16, workflow-scenarios 111, test-keyword-detector 6, pre-tool-enforcer 13.

**Phase 3 — MANDATORY directive embedded in Stop reason (same release).** Observation: the auto-confirm queue-drop injection only triggers on the next `UserPromptSubmit`, but when Claude Code re-invokes the main agent after a `Stop` `decision: block`, the only signal the agent receives is the Stop `reason` string. Without MANDATORY text in the reason, the agent often reads a passive description and idles. Phase 3 closes this by making the reason itself actionable.

- [x] H1. **`mandatoryDirective({ skill, direction, state })`** — new in `scripts/stop-stage-enforcer.mjs`. Produces `[MANDATORY WORKFLOW STEP] mode=<m>, current_stage=<s>, <ENTER|ADVANCE to|go BACK to> <skill> (direction=<dir>). You MUST invoke Skill(skill: '<skill>') as the FIRST tool call of your reply. Do not answer in prose before the Skill call — the Skill invocation IS the reply.`
- [x] H2. **`buildBlockReason` now emits MANDATORY directive** — both entry_not_started (direction=enter, skill=current_stage) and non-terminal (direction=advance, skill=nextStage) branches append the directive after the `[Stage]` prefix. Legacy E2E reminder pathway unchanged.
- [x] H3. Tests: `stop-stage-enforcer.test.mjs` P3-M1 / P3-M2 (MANDATORY text, direction tag, correct skill embedded). 21 cases total.

Result: when Stop blocks, the agent's resumption input contains the full Skill invocation directive, not just a reminder — closing the "agent idles after Stop" gap in auto mode. Final totals after Phase 3: auto-confirm 98, stop-stage-enforcer 21, critic-watchdog 13, skill-stage-transition 16, workflow-scenarios 111, test-keyword-detector 6, pre-tool-enforcer 13 (**278 total**).

**Phase 4 — transcript_path plumbing + R13 bash-c unwrap (same release).** Observed two silent defects in production:

1. **Phase 2 classifier never fired in real sessions**: Claude Code Stop hook stdin carries `transcript_path` but NOT `last_assistant_text`. `scripts/auto-confirm.mjs:721` read `input.last_assistant_text || ''` and always got empty string, so `shouldRunStageCompletionClassifier` returned false and the stage-completion path was skipped. The field had been a test-only convention in `scripts/auto-confirm.test.mjs` and `scripts/session-sim.mjs`.
2. **R13 false-positive on `bash -c 'ls …'`**: read-only commands wrapped in `bash -c '…'` matched the `interpreterExec` regex (`bash \s+ -c`) and were blocked even though the body was `ls`/`cat`/etc.

Fixes (atomic):

- [x] J1. **`scripts/lib/transcript-reader.mjs` (new)** — `readLastAssistantText(transcriptPath)` parses the JSONL transcript, scans from the bottom, and returns the last assistant message's concatenated text parts. Handles both flat (`{ role, content }`) and nested (`{ type: 'message', message: { role, content } }`) envelopes. Oversize guard `TRANSCRIPT_MAX_BYTES = 8 MiB`. Never throws (hook-safe). Tests: `scripts/lib/transcript-reader.test.mjs` (13 cases).
- [x] J2. **`scripts/auto-confirm.mjs` fallback** — CLI entry now prefers `input.last_assistant_text` (test fixtures + legacy) but falls back to `readLastAssistantText(input.transcript_path)` when the explicit field is missing. Production Stop hook stdin now drives the classifier correctly. Regression test: Phase 4 section in `auto-confirm.test.mjs` (JSONL transcript + stubbed classifier → exit 2 with queue; previously would have halted with empty message).
- [x] J3. **`scripts/critic-watchdog.mjs` R13 unwrap** — new `unwrapShellCExec(cmd)` helper strips `bash -c '…'` / `sh -c "…"` / `zsh -c '…'` wrappers. `isPureReadCmd(body)` now checks each `;`/`&&`/`||`-separated statement against an expanded read-tool list (`cat|head|tail|ls|grep|rg|jq|echo|printf|true|:|…`). `interpreterExec`, `shellMutators`, `apiWriters`, `openForWrite`, `redirectTarget`, `heredocToTarget` all re-check against the unwrapped body. `bash -c` itself is no longer treated as an interpreter-exec trigger. Tests: `critic-watchdog.test.mjs` (3 new R13 cases — wrapped read allowed, pipeline of reads allowed, wrapped `node -e` writing state still blocked; 16 total).

Final totals after Phase 4: auto-confirm 99, stop-stage-enforcer 21, critic-watchdog 16, skill-stage-transition 16, workflow-scenarios 111, test-keyword-detector 6, pre-tool-enforcer 13, transcript-reader 13 (**295 total**).

**Phase 5 — Implement/verify/fail/replan cycle validation (same release).** Per queued follow-up: add explicit scenario coverage for the full failure-recovery loop (구현 → 검증 → 실패 시 원인 확인 → 필요한 만큼만 계획 보정 → 다시 구현 → 다시 검증) so the workflow is proved not to deadlock under common failure patterns.

- [x] K1. `scripts/workflow-scenarios.test.mjs` SCENARIO 16 (7 cases):
  - 16-A coding typecheck fail → self-rerun, then pass → advance to agent-review
  - 16-B coding scope_mismatch → route back to tasker → re-plan → advance
  - 16-C verify mode fail(test_run) → producer chain to workflow-coding
  - 16-D e2e fail(assertion) → coding → re-coding pass → re-e2e pass → advance to e2e-review
  - 16-E multi-cycle: typecheck fail → lint fail → pass → advance (no deadlock)
  - 16-F tasker-review fail → tasker → pass → advance
  - 16-G agent-review security fail → coding → pass → advance (whitelist preserved)
  - Every step asserts `direction` tag (`back` on producer chain, `advance` on forward).
- [x] K2. SCENARIO 15 `validActions` allowlist now includes `stage_complete` / `stage_incomplete` (Phase 2 additions).

Final totals after Phase 5: auto-confirm 99, stop-stage-enforcer 21, critic-watchdog 16, skill-stage-transition 16, workflow-scenarios 118, test-keyword-detector 6, pre-tool-enforcer 13, transcript-reader 13 (**302 total**).

Totals after Phase 15: `stop-stage-enforcer.test.mjs` 19, `skill-stage-transition.test.mjs` 16, `critic-watchdog.test.mjs` 13, `auto-confirm.test.mjs` 89, `workflow-scenarios.test.mjs` 111, `test-keyword-detector.mjs` 6, `pre-tool-enforcer.test.mjs` 13.

## Phase 14 — stop-stage-enforcer recovery + entry-stage seed + broadened guard (v2.4.6)

Closes three defects observed 2026-04-20 that caused `/fix`/`/investigate`/`/plan` to stall in a "same state" Stop loop:

- [x] F1. **File corruption repaired** — `scripts/stop-stage-enforcer.mjs` previously contained a pasted diff artifact at line 5786 plus scattered non-ASCII glyphs (lines 212/492/805/940/1095/1244/1374/1510/1626–5790) that Node ESM rejected with `SyntaxError`. File reauthored cleanly (≈330 lines) preserving all prior exports.
- [x] F2. **Entry stage seeded** — `scripts/keyword-detector.mjs:seedWorkflowState` now sets `state.current_stage = modeCfg.entry_skill` when the entry skill is in `allowed_skills`. Prevents Stop from blocking on `current_stage=null` every round; the first `workflow-*` skill invocation now advances from a known entry stage instead of guessing. Tests: `scripts/test-keyword-detector.mjs` (expects `workflow-investigate` for `/fix`).
- [x] F3. **Guard set broadened** — `WORKFLOW_MODES_FOR_STAGE_GUARD` extended from `{fix, implement, plan}` to include `{investigate, verify, simple_fix}`. All Smelter modes now enforce terminal-stage exit. Single-stage modes (`verify`, `simple_fix`) pass via `isTerminalStage()` since their only allowed_skill is the last. Tests: `scripts/stop-stage-enforcer.test.mjs` C16 (investigate non-terminal → block + advance).
- [x] F4. **Session-aware summary** — `stop-stage-enforcer.main()` now calls `getActiveFeatureSummary(cwd, stdinJson.session_id)` so a concurrent session's non-scoped pointer can no longer supply the wrong E2E surface. Tests: `scripts/stop-stage-enforcer.test.mjs` C17 (two features, session selects the right summary).

Totals: `stop-stage-enforcer.test.mjs` 17/17, `test-keyword-detector.mjs` 6/6, `workflow-scenarios.test.mjs` 111/111, `auto-confirm.test.mjs` 86/86, `critic-watchdog.test.mjs` 9/9.

## Phase 15 — Slug preamble pruning (v2.4.7)

Closes the defect observed 2026-04-20 where `.smt/features/you-are-a-command-classifier-for-a-cli-tool-called/` was created when the Haiku classifier's system prompt ("You are a command classifier for a CLI tool called 'smelter'…") reached `keyword-detector.mjs::deriveSlug` as user input. The existing `SMELTER_CLASSIFIER_SUBPROCESS` env guard (Phase 2-3 §2-3) still prevents the primary leak vector, but stale `.smt/features/<you-are-a-…>/` directories from pre-guard runs kept being resurrected via active-feature pointers across sessions.

- [x] S1. **`deriveSlug` hardened** — `scripts/keyword-detector.mjs:209` replaces the naive `slice(0, 80)` truncation with a two-stage pipeline: `stripSystemPreamble` (regex removes `You are (a|an|the)? …`, Korean 당신은/너는, `Skill:/Role:/Context:` labels, echoed `successfully loaded skill:` banners, `[MAGIC KEYWORD: …]` tags) → tokenize → drop leading filler tokens (a/an/the/for/to/of/is/are/and/or/…) → re-join (`-`) → slice to 50. Source window widened from 80 → 120 chars so the stripped remainder still carries enough domain words.
- [x] S2. **Unit coverage** — `scripts/keyword-detector.test.mjs` adds 4 tests: SLUG1 "You are a …" preamble stripped + domain word surfaces, SLUG2 leading "the" dropped, SLUG3 "Skill: … successfully loaded skill:" banner stripped, SLUG4 Korean 당신은 preamble stripped. All via `spawnSync` integration against the real hook entry point.

Example transformation (defense-in-depth layer):
- Input: `"You are a command classifier for a CLI tool called \"smelter\". Classify the user's prompt…"`
- Old slug: `you-are-a-command-classifier-for-a-cli-tool-called` (50 chars, all preamble)
- New slug: `command-classifier-for-a-cli-tool-called-smelter-c` (50 chars, leads with domain noun)

Totals: `keyword-detector.test.mjs` SLUG1–4 pass (4/4 new). Pre-existing CSS1/CSS3 failures in the same suite are unrelated feature-reuse pointer issues, not affected by this change (Korean-only prompts tokenize identically under the new and old logic).

## Phase 16 — Interrogative fallback in mode-classifier

Closes the defect observed 2026-04-21 where a pure inquiry prompt (`[로그와함께]  sf private key가 따로 필요한건지?\n\n    키노출 절대 금지.`) misrouted to `/fix` and seeded a full repair chain. The prompt has no `investigate` keyword; all priority rules miss; `classify()` falls back to `DEFAULT_MODE='fix'` with trigger `default:unclassified`.

- [x] H2. `scripts/mode-classifier.mjs` — new branch between the priority sweep and the final fallback: when `intent` (the `firstSentence()` slice) ends with ASCII `?` (U+003F) or full-width `？` (U+FF1F), return `{ mode: 'investigate', trigger: 'default:interrogative' }`. Runs AFTER every priority rule so imperative verbs still win (e.g. `버그 고쳐줘?` stays `fix` via priority-10 `/고쳐줘/`). DEFAULT_MODE is unchanged — non-question unstructured prompts still fall to `fix`.
- [x] H2-tests. `scripts/mode-classifier.test.mjs` — 11 new cases in section `H2`: reported-bug prompt, trigger-label assertion, `~인지?`/`~까?`/`~나요?`, English `Is X needed?`/`Should we X?`, full-width `？`, plus 3 negatives (`버그 고쳐줘?` → fix, `fix this bug?` → fix, plain non-question → fix default).

E2E (CLI surface): 5 real-subprocess scenarios captured under `.smt/features/다른-세션에서-로그와함께-sf-private-key가-따로-필요한건지-키노출-절대-금지-과/artifacts/cli/` with full argv+stdin+stdout+exit transcripts; the reported prompt now returns `mode=investigate, trigger=default:interrogative`.

Totals: `mode-classifier.test.mjs` 55 pass (44 prior + 11 new).

## Phase 17 — Interactive-skill Stop-hook stasis (v2.4.8)

Closes the infinite `entry_not_started` loop observed 2026-04-21 when a workflow-brainstorm / workflow-investigate / workflow-tasker skill is actively asking the user a multi-turn question. The canonical artifact (`brainstorm.md`, `investigation.md`, `tasks.md`) is only written at the END of the Q&A — so between Q1 and Q_n, both `state.completed_stages` and `state.events` stay empty while the skill IS in fact invoked. `stop-stage-enforcer.mjs::buildBlockReason` read that as "skill has not been invoked yet" and forced re-entry on every turn; `auto-confirm.mjs::detectRiskKeyword` simultaneously matched risk words inside legitimate option text (e.g. Korean `위험`) and routed to `spawn_sub_tasker`.

- [x] I1. **Transcript invocation detector** — `scripts/lib/transcript-reader.mjs` adds `hasSkillInvocationSinceLastUserText(transcriptPath, skillName)` and `lastAssistantQuestionShape(transcriptPath)` + a pure `classifyQuestionShape(text)` helper. Anchor: last `role: 'user'` entry carrying a `type: 'text'` part — skips user-role `tool_result` envelopes so the current turn's tool loop stays inside the window. Success gate: matching `tool_result` with `is_error !== true`. Fail-closed on missing / oversize / parse errors (returns `false`).
- [x] I2. **stop-stage-enforcer in-progress branch** — `scripts/stop-stage-enforcer.mjs::evaluate` now accepts `transcriptPath` + an injectable `invocationCheck` seam; after `isTerminalStage`, if `current_stage` is set with empty completed/events AND the skill was invoked in the current turn, return `{action: 'continue'}`. Genuine drift (no matching `tool_use` since the last user-text anchor) still emits `entry_not_started`. Stuck-loop counter resets naturally via the existing `clearLoopCounter` on continue.
- [x] I3. **auto-confirm shape gate** — `scripts/auto-confirm.mjs::decide` accepts `questionShape` and skips the `spawn_sub_tasker` branch when shape ∈ `{multi_choice, yes_no, open_question}`. Placed AFTER the `workflow-human-check` / `_awaiting_mode_upgrade` / `done` halt conditions so those pauses remain authoritative. Shape detection is conservative: bare trailing `?` alone is NOT enough — a bullet / option line is required, so rhetorical prose with `위험` still spawns (regression guard).
- [x] I4. **Unit coverage** — 8 new transcript-reader cases (INT1-INT7 invocation detection + 6 shape classifier cases), 7 new stop-stage-enforcer cases (INT1-INT7 interactive-skill), 7 new auto-confirm cases (shape-gate multi_choice / yes_no / open_question pass-through + none regression + legacy caller + human-check halt safety). All 165 touched-surface tests green.

Totals: `transcript-reader.test.mjs` 28/28, `stop-stage-enforcer.test.mjs` 30/30, `auto-confirm.test.mjs` 107/107.

## Phase 18 — Cross-session pointer bleed on missing per-session pointer (v2.4.8)

Closes the Stop-hook advancement loop observed 2026-04-21 when a fresh session inherits a stale non-scoped `active-feature.json` left by a prior session but has no per-session pointer of its own. Two reader paths silently fell back to non-scoped / mtime-latest state, dragging another session's feature into today's session and driving the classifier to issue `advance to workflow-X` on every Stop event.

- [x] P1. **`auto-confirm.findActiveTaskState`** — when `sessionId` is provided but `.smt/state/active-feature-<sessionId>.json` is absent, return `null` immediately instead of scanning for the most-recently-modified `*.state.json` under `.smt/features/*/task/`. The mtime-latest fallback is retained only for the session-less branch (test fixtures, legacy CLI / `session-sim.mjs`).
- [x] P2. **`stop-stage-enforcer.getActiveFeatureSummary`** — when `sessionId` is provided, the candidate list now contains ONLY the per-session pointer path. The non-scoped `active-feature.json` is consulted solely when `sessionId` is absent. Matches the strict behavior of `findActiveStatePath` (line 66-71) which already honored session isolation.
- [x] P3. **Test coverage** — added `auto-confirm.test.mjs` "sessionId present + no per-session pointer MUST NOT use mtime fallback (cross-session bleed guard)" + `stop-stage-enforcer.test.mjs` C18 "sessionId present + no per-session pointer MUST NOT fall back to non-scoped pointer". Three pre-existing auto-confirm tests that relied implicitly on mtime fallback (`active state + classifier stub → continue`, `active state + pass event + session_id`, `parallel sessions do not cross-pollinate`) were updated to seed a per-session pointer explicitly, reflecting the production reality that a session with active work has a session-scoped pointer.

Totals: `auto-confirm.test.mjs` 107/107 (1 new + 3 migrated), `stop-stage-enforcer.test.mjs` 30/30 (1 new). All 13 test suites green.

## Phase 19 — Transcript-paste passthrough + entry_not_started cancel hint (v2.4.8)

Closes the false-positive classifier seed observed 2026-04-21 where pasting a Claude Code session log (e.g. `[master <sha>] fix: …`, `⏺ …`, `Stop hook error: …`) routed through the `\bfix\b` legacy pattern → mode-classifier → state seeding, spawning a full `/fix` chain for a message the user intended as a question *about* a prior session.

- [x] Q1. **Transcript-paste heuristic** — `scripts/keyword-detector.mjs` adds `TRANSCRIPT_PATTERNS` (5 regexes: `⏺` bullet, `⎿` connector, `Stop hook (error|feedback)`, `Ran N stop hooks`, `[master <sha>]` / `[main <sha>]` banners) and pure-function `isTranscriptPaste(text)`. Threshold: **≥2 distinct pattern hits** — deterministic, early-exits at 2 matches, immune to percentage-of-lines instability on short prompts.
- [x] Q2. **Passthrough wiring** — `detectNaturalLanguageCommand` returns `{ passthrough: true, matched: 'transcript-paste', source: 'passthrough' }` when the predicate fires, BEFORE the `ruleClassify` / `legacyPatternMatch` call. `main()` already treats passthrough as a no-seed path. Rollback lever: `SMELTER_SKIP_TRANSCRIPT_HEURISTIC=1` env var disables the predicate call.
- [x] Q3. **`/cancel` hint in entry_not_started** — `scripts/stop-stage-enforcer.mjs::buildBlockReason` entry_not_started branch appends one line: *"If this input was a reference (pasted log, quoted content) and not a real task: /cancel to clear the seeded state."* Provides a user-visible escape for spurious seeds that still slip through (`[Stage] mid-flow` branch intentionally omits the hint — real work is in progress).
- [x] Q4. **Test coverage** — 11 new `keyword-detector.test.mjs` cases (`TPP1-TPP11`): verbatim transcript fixture, single incidental mention, ≥2 distinct marker threshold, `[master <sha>]` banner, explicit `/fix` slash bypass, `detectNaturalLanguageCommand` passthrough shape, mixed paste+question (transcript-dominant wins — pinned decision), empty/whitespace, env-var rollback. 1 new `stop-stage-enforcer.test.mjs` case (`CH1`): entry_not_started reason contains `/cancel` substring.
- [x] Q5. **E2E coverage** — two hook-script scenarios under `.smt/features/nurl-master-fc8915cb-fix-resolve-domain-via-secret/artifacts/hook/` with full input.json + output.json + exit triples. S1: verbatim transcript paste yields `{"continue":true}` and no `.smt/features/` seeding (fs_diff). S2: seeded state with `current_stage=workflow-investigate`, `completed_stages=[]`, `events=[]` triggers a `decision: block` whose `reason` ends with the `/cancel` hint substring (stdout_parse).

Totals: `keyword-detector.test.mjs` +11 cases, `stop-stage-enforcer.test.mjs` 31/31 (1 new).

## Phase 20 — workflow-human-check halt-guard scoping (v2.4.9)

Closes the Stop-hook advance-to-`workflow-write-test` loop observed 2026-04-21 when a fix-mode task sat at `current_stage='workflow-human-check'` without a matching `workflow-human-check` pass event in `state.events`. The prior guard at `auto-confirm.mjs::decide` checked only `lastEvent.result === 'pass'`, so a pass event from any prior skill (e.g. `workflow-tasker-review`) bypassed the halt and the generic `last.result === 'pass'` branch picked the next uncompleted skill via `pickNextStage()` — re-entering the chain past the terminal approval gate.

- [x] R1. **Scoped halt predicate** — `scripts/auto-confirm.mjs::decide` now scopes the halt clearance to `events.some(e => e && e.skill === 'workflow-human-check' && e.result === 'pass')`. `Array.isArray` normalization on both `state.events` and `state.completed_stages` handles malformed / undefined state files. `legacyCompleted` (completed_stages includes `workflow-human-check`) preserves progression for pre-Fix-B states without a migration script.
- [x] R2. **Terminal-approval short-circuit** — On `humanCheckPassed || legacyCompleted`, the guard short-circuits to `action: 'session_wrap'` so a genuine human-check approval does not fall through to the generic `last.result === 'pass'` advance branch below. Without this, `pickNextStage()` would return the first uncompleted skill after a completed approval.
- [x] R3. **Unit coverage** — 3 new cases in `scripts/auto-confirm.test.mjs`: prior-skill pass event → halt (regression guard), legacy completed_stages → session_wrap (fallback path), empty events → halt (defensive). The pre-existing `workflow-human-check with pass event` case tightened from `notEqual('halt')` to `equal('session_wrap')` so ambiguous advance paths can no longer silently pass.
- [x] R4. **Hook E2E** — `.smt/features/what-s-fix-2/artifacts/hook/` captures two subprocess scenarios with input.json + output.json + exit + stderr triples. Scenario A seeds `current_stage='workflow-human-check'` + prior-skill pass event → asserts exit 0 + empty stdout (halt path, not the pre-fix advance path). Scenario B no-state baseline.
- [x] R5. **Doc sync** — `document/workflow.md` §11-4 item 2 rewritten to spell out the scoped pass-event predicate, the legacy fallback, and the session_wrap short-circuit.

Totals: `auto-confirm.test.mjs` 110/110 (3 new + 1 tightened). Hook E2E: 2/2 scenarios pass.

## Phase 21 — Mode-classifier LLM refactor (v2.4.9)

Replaces the bilingual regex `RULES` table, `classifyChain`, paste-sanitizer (`firstSentence`), and the HARD/SOFT reject lists inside `scripts/mode-classifier.mjs` with an OAuth-authenticated Claude CLI call (`classifyMode` in `scripts/lib/subagent-classifier.mjs`, scaffolded as Stage 1 under the same feature). The new `classify(input, { cwd, sessionId })` runs four ordered layers — explicit slash, pure shell/git passthrough, LLM, safe fallback — so deterministic paths stay in regex and contextual language work goes to the model.

- [x] R1. **Four-layer classifier** — Layer 1 (`EXPLICIT_COMMANDS`) and Layer 2 (`PASSTHROUGH_PATTERNS`, tightened to `$`-anchored full-input matches) preserve deterministic short-circuits. Layer 3 invokes `classifyMode` via `execFileSync` (synchronous — `keyword-detector.mjs::main` is sync-coupled) and threads `{ cwd, sessionId }` so per-session cache isolation holds. Layer 4 reacts to LLM failure with interrogative-then-`fix` fallback.
- [x] R2. **Deletions** — `RULES` (6 blocks, ~120 lines), `PASSTHROUGH_HARD_REJECT`, `PASSTHROUGH_SOFT_REJECT`, `CHAIN_ACTION_MAP`, `CHAIN_CONNECTIVES`, `classifyChain`, `firstSentence`, and the pre-LLM interrogative rule are removed. Only `EXPLICIT_COMMANDS`, `PASSTHROUGH_PATTERNS`, `DEFAULT_MODE`, and `MODES_WHITELIST` remain as module-local constants. `classifyMagicKeywords` was removed in v3.2; surface extraction now lives in `scripts/lib/surface-extraction.mjs` (natural-language path via `classifyMode`, slash-arg path via `parseSlashArgs`).
- [x] R3. **Caller wire-up** — `scripts/keyword-detector.mjs::detectNaturalLanguageCommand` now accepts `{ cwd, sessionId }` and forwards them to `classify`, so `scripts/lib/subagent-classifier.mjs` can key its per-session `mode-classifier-cache.json` without falling back to `process.cwd()` + empty session. `legacyPatternMatch` is retained as a belt-and-suspenders fallback for `default:*` triggers (LLM parse failure chain).
- [x] R4. **Test harness** — introduces `scripts/lib/__fixtures__/mode-classifier-stub.mjs`, a prompt-lookup-table stub (no regex) wired into three test files via `SMELTER_MODE_CLASSIFIER_MODULE`:
    - `scripts/mode-classifier.test.mjs` — 37 cases covering all four layers plus magic-keywords + empty input + LLM-throw fallback (RED→GREEN).
    - `scripts/keyword-detector.test.mjs::runDetector` — subprocess env pre-load so chain/state seeding is deterministic; in-process tests (`detectNaturalLanguageCommand` direct calls) also load the stub at module top.
    - `scripts/workflow-scenarios.test.mjs` SCENARIO 13 — switches from real LLM to stub via dynamic import + env-var, eliminating the LLM-drift failures the real CLI produced across runs.
- [x] R5. **Test suite status** — `mode-classifier.test.mjs` 37/37 pass; `subagent-mode-classifier.test.mjs` 4/4 pass; `workflow-scenarios.test.mjs` 118/118 pass; `keyword-detector.test.mjs` 24/26 pass (2 pre-existing failures untouched by this refactor: TPP4 `isTranscriptPaste` distinct-pattern accounting bug, TPP6 `extractExplicitHarnessCommand` single-line anchor).
- [x] R6. **Doc sync** — `document/workflow.md` §1-2 rewritten as a four-layer table with LLM as Layer 3 and the `default:interrogative` wording scoped to Layer 4. §1-3 Magic Keywords gains a note that surface detection stays regex-based (hints, not a mode decision). Feature record at `.smt/features/feature-mo6xifxb-ac5a1e/classifier-llm-refactor.md` stages all work back to Stage 1.

Totals: classifier & scenarios 159/159 green, keyword-detector 24/26 green (pre-existing). Test wall time dropped ~90× once the stub displaced real-LLM roundtrips (`keyword-detector.test.mjs` 145s → 1.6s).

## Phase 22 — Workflow integrity: artifact basename unification + auto-synthesis removal + Stop-hook consolidation (v2.4.10)

Three interlocked fixes identified 2026-04-21 via investigation at `.smt/features/all/task/`.

**Fix #1 — Canonical artifact basename unification:**
- [x] 1-1. `scripts/skill-stage-transition.mjs` — replace literal `SKILL_ARTIFACT` map with `SKILL_ARTIFACT_BASENAME` import from `state-validator.mjs` (single source of truth; eliminates drift between the two definitions).
- [x] 1-2. `scripts/skill-stage-transition.test.mjs` — regression test: source must have no literal `SKILL_ARTIFACT = {` assignment.
- [x] 1-3. `skills/workflow-brainstorm-review/SKILL.md` → `produces: brainstorm-review.md` (was `brainstorm_review.md`); `skills/workflow-investigate-review/SKILL.md` → `produces: investigation-review.md` (was `investigate_review.md`); `skills/workflow-tasker/SKILL.md` → `produces: tasks.md` (was `plan.md, target_type, …`); `skills/workflow-tasker-review/SKILL.md` → `consumes: tasks.md`, `produces: tasks-review.md` (was `plan.md` / `tasker_review.md`).
- [x] 1-4. `scripts/state-validator.test.mjs` — 4 contract tests: each SKILL.md `produces:` first token must match `SKILL_ARTIFACT_BASENAME[skill]`.
- [x] 1-5. `document/workflow.md` §3 skill table — rows 2/4/5/6/7 updated to hyphen-form basenames and `tasks.md` consumes.

**Fix #2 — Remove auto-confirm stage_complete artifact auto-synthesis:**
- [x] 2-1. `scripts/auto-confirm.mjs` — delete lines 811-832 auto-synthesis block (Iron Law #5: artifacts written by the skill producer only, never the Stop hook).
- [x] 2-2. `scripts/auto-confirm.mjs::buildPromptInjection` stage_complete case — when artifact non-null: emit Write-tool directive instructing agent to write canonical artifact; when null: emit explicit "no canonical artifact required" line. Removes "auto-written at" language.
- [x] 2-3. `scripts/auto-confirm.mjs::decide` — Fix B: scope `workflow-human-check` halt clearance to pass events where `e.skill === 'workflow-human-check'`; add `legacyCompleted` fallback for pre-Fix-B states; short-circuit to `session_wrap` on terminal approval.
- [x] 2-4. `scripts/auto-confirm.test.mjs` — Fix #2 tests: no `auto-generated artifact` header, no `writeFileSync(absPath,…)` pattern, Write-tool directive present, auto-written absent, null-artifact clause present, prior-skill pass → halt, legacy completed → session_wrap, empty events → halt.

**Fix #3 — Fold stop-stage-enforcer into auto-confirm (single Stop hook):**
- [x] 3-1. `scripts/stop-stage-enforcer.mjs` — DELETED.
- [x] 3-2. `scripts/stop-stage-enforcer.test.mjs` — DELETED.
- [x] 3-3. `scripts/auto-confirm.mjs` — port `pickNextStage`, `isTerminalStage`, `ALWAYS_TERMINAL_STAGES` inline as local exports; remove `import { pickNextStage } from './stop-stage-enforcer.mjs'`.
- [x] 3-4. `scripts/auto-confirm.mjs::autoConfirmSignature` — replace action string with `completed_stages.length` (monotonically increasing; resets on genuine forward progress; closes dual-counter gap).
- [x] 3-5. `scripts/auto-confirm.mjs` CLI entry — wrap inner classifier call with `STAGE_CLASSIFIER_TIMEOUT_MS = 10000` so a hung sub-agent cannot starve the Stop hook's 120 s wall-clock budget.
- [x] 3-6. `hooks/hooks.json` + `settings.json` — remove `stop-stage-enforcer.mjs` entry; raise `auto-confirm` timeout from 20 s/45 s to 120 s; remove stale `model` key.
- [x] 3-7. `scripts/cancel-propagator.mjs` — add `loopCounterPaths(directory, sessionId)` helper; `clearLegacyState` now also cleans both the auto-confirm and legacy stop-loop `/tmp` counter files.
- [x] 3-8. `scripts/workflow-scenarios.test.mjs` SCENARIO 13 — switch to `mode-classifier-stub.mjs` via env var + dynamic import for LLM-stable assertions.
- [x] 3-9. `scripts/auto-confirm.test.mjs` — Fix #3 tests: `completedCount`-based signature, `no-state:0` null-state form, terminal-stage halt behavior, `stop-stage-enforcer.mjs` deleted assertion.
- [x] 3-10. `document/workflow.md` §11-5b + §11-5c — rewrite to reflect single-hook architecture; update timeout from 45 s to 120 s; attribute `pickNextStage`/`isTerminalStage` to `auto-confirm.mjs`.

Totals (scoped surface): `auto-confirm.test.mjs` 110+/110+ pass, `skill-stage-transition.test.mjs` pass, `state-validator.test.mjs` pass, `workflow-scenarios.test.mjs` pass.

## Phase 23 — Superpowers-style enforcement language port (v2.4.1+)

Motivation 2026-04-21: recurring symptom of agents stopping at `workflow-coding` and skipping `workflow-agent-review` → `workflow-e2e` → `workflow-e2e-review` → `workflow-team-code-review` → `workflow-human-check`. Tests pass → agent declares "done" without any hook firing, because the linguistic act of self-claiming completion was not addressable by the existing state-based gates.

Root cause: Smelter's `workflow-*/SKILL.md` files described technical gates (postconditions, artifact presence) but lacked the linguistic enforcement that `obra/superpowers` skills carry — Iron Law blocks, Red Flags tables, Rationalization Prevention, explicit Terminal Next-Skill, Forbidden Responses. The model had no canonical language pattern to refuse premature completion.

**Fix #1 — Per-skill enforcement layout (14 skills):**
- [x] 1-1. `skills/workflow-brainstorm/SKILL.md` — added Overview + Iron Law + Red Flags + Rationalization Prevention + Scope decomposition + Terminal Next-Skill (`workflow-brainstorm-review`).
- [x] 1-2. `skills/workflow-brainstorm-review/SKILL.md` — added enforcement blocks; Terminal Next-Skill on `pass`: `workflow-investigate`.
- [x] 1-3. `skills/workflow-investigate/SKILL.md` — added Iron Law `NO PLAN WITHOUT EVIDENCE FROM CODE`; Terminal Next-Skill: `workflow-investigate-review`.
- [x] 1-4. `skills/workflow-investigate-review/SKILL.md` — added enforcement blocks; Terminal Next-Skill on `pass`: `workflow-tasker` (or mode_transition on `/investigate`).
- [x] 1-5. `skills/workflow-tasker/SKILL.md` — Iron Law `NO IMPLEMENTATION WITHOUT plan.md + target_type + team_runtime`; Terminal Next-Skill: `workflow-tasker-review`.
- [x] 1-6. `skills/workflow-tasker-review/SKILL.md` — Iron Law `NO IMPLEMENTATION WITHOUT 95% CONSENSUS AND 3/3 REVIEW ROUNDS`; Terminal Next-Skill: `workflow-write-test` (or `workflow-coding` if `exempt.tdd`).
- [x] 1-7. `skills/workflow-write-test/SKILL.md` — Iron Law `NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST`; Terminal Next-Skill: `workflow-coding`.
- [x] 1-8. `skills/workflow-coding/SKILL.md` — Iron Law `TESTS GREEN ≠ DONE. NO COMPLETION CLAIM WHILE STAGE < workflow-human-check`; Red Flags explicitly ban "Tests pass so I'm done", "Shall I continue?"; Terminal Next-Skill: `workflow-agent-review`.
- [x] 1-9. `skills/workflow-agent-review/SKILL.md` — added Forbidden Responses ("You're absolutely right!", "Great point!", "Let me implement that now"); Terminal Next-Skill: `workflow-e2e`.
- [x] 1-10. `skills/workflow-e2e/SKILL.md` — Iron Law `NO E2E PASS WITHOUT ARTIFACTS ON DISK AND TARGET-EFFECT ASSERTION`; Common Failures table with ack-vs-effect rows; Terminal Next-Skill: `workflow-e2e-review`.
- [x] 1-11. `skills/workflow-e2e-review/SKILL.md` — added enforcement blocks; Terminal Next-Skill on `pass`: `workflow-team-code-review`.
- [x] 1-12. `skills/workflow-team-code-review/SKILL.md` — Iron Law `NO HUMAN-CHECK HANDOFF WITHOUT 95% CONSENSUS AND 3/3 ROUNDS`; Terminal Next-Skill: `workflow-human-check`.
- [x] 1-13. `skills/workflow-human-check/SKILL.md` — Iron Law `NO COMPLETION WITHOUT USER DECISION VIA AskUserQuestion`; explicit decision-routing table (`complete` / `rework` / `hold` / `upgrade`).
- [x] 1-14. `skills/workflow-verify/SKILL.md` — Iron Law `NO VERIFY REPORT WITHOUT ALL THREE PHASES EXECUTED`; terminal by mode design (no auto-chain into implementation).

**Fix #2 — Doc sync:**
- [x] 2-1. `document/workflow.md` — new §0-bis documenting the Superpowers-style enforcement layout (Overview / Iron Law / Red Flags / Rationalization Prevention / Common Failures / Terminal State). Lists the required sections in order and writing rules (spirit clause, announce-at-start, forbidden-responses).
- [x] 2-2. `document/implementation.md` — this Phase 23 entry.

**Fix #3 — Hook-level teeth via critic-watchdog R16/R17:**
- [x] 3-1. `scripts/critic-watchdog.mjs` — add `rule16_prematureDone` (CRITICAL): blocks `Edit`/`Write`/`Bash` that sets `"current_stage": "done"` in any form when the mode's `allowed_skills` contains `workflow-human-check` AND no `events[]` entry has `{ skill: 'workflow-human-check', result: 'pass' }` AND `user_decision !== 'complete'`. Catches the premature-termination state write that the Terminal State language tells the model not to do.
- [x] 3-2. `scripts/critic-watchdog.mjs` — add `rule17_prematureCompletionProse` (HIGH): blocks `Edit`/`Write` that introduces phrases `task complete`, `implementation complete`, `bug fixed`, `issue resolved`, `ready to ship`, or `all tests passing, (we're) done` into `.smt/features/**/task/*.md` (excluding `plan.md`), `.smt/features/**/results.md`, or `.smt/session/YYYY-MM-DD.md` when `workflow-human-check` hasn't passed. Scoped to human-readable canonical artifacts; code files, test files, and `plan.md` are exempt (`plan.md` legitimately contains phrases like "task complete when X" as pre-impl descriptive text).
- [x] 3-3. `scripts/critic-watchdog.mjs` — register both in the `RULES` array (now 17 total).
- [x] 3-4. `scripts/critic-watchdog.test.mjs` — 7 new tests: R16 block on premature done, R16 allow with human-check pass, R16 allow with user_decision=complete, R16 skip in `/verify`-only mode, R17 block on "bug fixed / task complete" prose in `results.md`, R17 allow after human-check pass, R17 skip on `plan.md`, R17 skip on `src/` code edits. Total 24/24 pass.
- [x] 3-5. `document/workflow.md` §12-5 — extend rule table with R14/R15 (previously undocumented in table), R16, R17. Rationale block explaining R16 = state-level catch, R17 = prose-level catch, complementing §0-bis Terminal State language.
- [x] 3-6. `document/workflow.md` §17 + §18 — update `critic-watchdog.mjs` comment and table row 13 from "12 rules (R01–R11)" to "17 rules (R01–R17)".

Totals: 14/14 workflow-* skills ported (text), 2 new watchdog rules with 7 new tests (enforcement teeth), `critic-watchdog.test.mjs` 24/24 pass, `skill-stage-transition.test.mjs` 17/17 pass, `state-validator.test.mjs` 18/18 pass, `mode-classifier.test.mjs` 40/40 pass, `auto-confirm.test.mjs` 115/115 pass.

**Source attribution:** patterns imported from `obra/superpowers` skills:
- `brainstorming/SKILL.md` — HARD-GATE, "too simple to need design" anti-pattern, scope decomposition, spec self-review
- `using-superpowers/SKILL.md` — Red Flags rationalization table, Skill Priority, Instruction Priority ladder
- `verification-before-completion/SKILL.md` — Iron Law block, Gate Function, Common Failures table, Rationalization Prevention
- `test-driven-development/SKILL.md` — "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"
- `systematic-debugging/SKILL.md` — phase-gated investigation pattern
- `subagent-driven-development/SKILL.md` — terminal next-skill naming, never-blind-retry
- `receiving-code-review/SKILL.md` — Forbidden Responses list

Not imported (intentional): Visual companion (browser-based UI, conflicts with file-based memory principle), "1% chance must invoke skill" rule (mode-classifier already routes), TodoWrite forcing function (Smelter explicitly disables Claude Code task tools), worktree enforcement (Smelter's .smt/ state already provides session isolation).

Observation period: re-run prior failing scenario (sheet-limit auth leak fix that stopped at `workflow-coding`) and verify the chain continues autonomously to `workflow-human-check`. R16/R17 now reject the state-level and prose-level manifestations of premature completion, so regressions should surface as explicit CRITICAL/HIGH blocks rather than silent skips.

## Phase 24 — Keyword-detector silent-skip fixes (v2.4.11)

User report: "keyword detector too loose, no mode entered." Investigation traced the symptom to a cluster of classifier-path defects rather than a classifier-sensitivity problem. Layer 3 actually returned the correct mode — it just failed to reach state seeding.

- [x] P24-1. **Cache trigger normalization** — `scripts/lib/subagent-classifier.mjs::classifyMode` previously cached the Haiku-raw trigger (e.g. `"imperative:repair"`) verbatim. `isValidModeCacheEntry` required a `llm:`/`stub:` prefix, so every cache entry was rejected on read and each prompt round-tripped the Haiku subprocess. Write-side now normalizes: if the trigger already carries `llm:` or `stub:`, keep it; otherwise prepend `llm:`.
- [x] P24-2. **Avoid double Haiku round trip** — `scripts/keyword-detector.mjs::seedWorkflowState` called `classifyMode` a second time to extract surface fields (target_type/exempt/skip_brainstorm), even though `detectNaturalLanguageCommand` had just classified the same prompt. With the P24-1 cache defect, the second call was an uncached Haiku invocation that could time out at 20 s and silently fail under the outer `try/catch {}`. `detectNaturalLanguageCommand` now forwards the full `classification` object in its return shape, and `seedWorkflowState` accepts it via a new `preClassification` parameter (fallback path preserved for callers that do not have it).
- [x] P24-3. **`think` banner** — `MODE_LABELS` in `keyword-detector.mjs` gained a `think: 'THINK MODE'` entry. Previously a `think` classification entered mode state silently; operators observed "no mode entered" because the banner never printed.
- [x] P24-4. **Trigger double-prefix** — `scripts/mode-classifier.mjs::classify` unconditionally prepended `llm:` to the trigger on return, producing `llm:llm:…` after P24-1's write-side normalization. The wrapper now respects an existing `llm:`/`stub:` prefix and only normalizes raw triggers that slipped through.

Verification (live hook invocation via stdin, fresh `.smt/` dirs):
- `버그 고쳐줘` → FIX MODE banner, `state.json` seeded with `mode=fix target_type=bug_fix`, trigger `llm:imperative:repair` (single prefix).
- `새 기능 설계해` → THINK MODE banner, `state.json` seeded with `mode=think`.
- Repeat of the same prompt in the same session returns immediately (cache hit), no Haiku subprocess spawn.

Tests: `scripts/keyword-detector.test.mjs` + `scripts/mode-classifier.test.mjs` 32/32 green (no test changes needed — existing coverage exercises the corrected paths).

- [x] P24-5. **Hook timeout vs Haiku budget** — `hooks/hooks.json` UserPromptSubmit `keyword-detector.mjs` had `timeout: 5` (5 s). `lib/subagent-classifier.mjs::TIMEOUT_MS` for the Haiku subprocess is 20 s. Any ambiguous Korean prompt where Haiku took longer than 5 s (empirically common) got SIGKILL'd mid-classification → hook produced no output → Claude Code continued without state seeding. Short prompts (<5 s round trip) routed fine; longer ones silently dropped. Session cache evidence: only **one** Haiku classification (`passthrough: true`) landed in `mode-classifier-cache.json` across an entire multi-turn debugging session, and its hash matched none of the user's messages — the rest were killed before cache write. Raised `timeout` to `20` so the hook budget covers the classifier. Reflection: requires Claude Code session restart to take effect (hooks.json loaded once at session start per CLAUDE.md).
