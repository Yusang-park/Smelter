---
title: Smelter v2.4.1 — Implementation Reference
type: implementation-reference
tags: [smelter, implementation, v2.4.1, architecture, scripts, agents, hooks]
version: 2.4.0
created: 2026-04-20
updated: 2026-04-20
status: canonical
---

# Smelter v2.4.1 — Implementation Reference

> Companion to `document/workflow.md` (the behavioral spec).
> This file documents **what's shipped**, **where it lives**, and **how the pieces wire together**.
> Every symbol here is a file that exists on disk — cross-verified by the audit pass of 2026-04-20.

---

## 0. Repository map

```
/Users/yusang/Smelter/
├── agents/                          ← specialized sub-agent definitions (39 files)
├── commands/                        ← 6 slash-command entry points
├── document/                        ← canonical spec + indices (this dir)
├── hooks/                           ← hooks.json (Claude Code hook registration)
├── modes/                           ← 6 mode definitions (JSON)
├── scripts/                         ← runtime scripts (hooks, engines, validators)
├── skills/                          ← 14 workflow-* + utility skills
├── src/                             ← core TypeScript engine
├── bin/                             ← smelter CLI entry
├── rules-lib/                       ← language-specific coding rules
├── templates/                       ← verification round prompts + task/plan/report templates
├── plugin.json                      ← Claude Code plugin manifest (v2.4.1)
├── .claude-plugin/plugin.json       ← plugin metadata (v2.4.1)
├── package.json                     ← npm manifest (v2.4.1)
└── settings.json                    ← Smelter settings
```

---

## 1. Execution surface (6 commands × 6 modes × 14 skills)

### 1-1. Commands (`commands/*.md`)

| Command        | Mode          | Entry skill                      | Purpose                                                 |
|----------------|---------------|----------------------------------|---------------------------------------------------------|
| `/plan`        | `plan`        | `workflow-brainstorm` (deep)     | New features / refactor. Planning-first, deep interview |
| `/implement`   | `implement`   | `workflow-brainstorm` (light)    | Build on existing code. Lightweight interview           |
| `/fix`         | `fix`         | `workflow-investigate`           | Bug or logic repair                                     |
| `/simple-fix`  | `simple_fix`  | `workflow-coding`                | Trivial text / CSS / constant substitution              |
| `/investigate` | `investigate` | `workflow-investigate`           | Static investigation (맥락·근거 파악); mode-transition exit |
| `/verify`      | `verify`      | `workflow-verify`                | Non-modifying verification: test run + static inspection + E2E interface in one pass |

Commands are thin prompts that seed state and defer to the skill pipeline. `scripts/mode-classifier.mjs` auto-routes natural-language input to these modes; explicit slash commands override.

### 1-2. Modes (`modes/*.json`)

Each mode declares:
- `entry_skill` + optional `entry_params` (e.g., `{depth: deep|light}` for brainstorm)
- `allowed_skills[]` — the mode's whitelist; skills outside this list must go through a user-gated `mode_transition`
- `default_team_overrides{}` — per-skill Pattern + agent defaults
- `default_exempt{tdd, e2e}` — baseline exemption flags
- `magic_keywords{}` — natural-language triggers that set flags (e.g., `css` → `exempt.tdd:true`)
- `transitions{upgrade_to, downgrade_to}` — allowed mode transitions

### 1-3. Workflow skills (`skills/workflow-*/SKILL.md`, 14 files)

| # | Skill                          | Default Pattern | Consumes → Produces                                     |
|---|--------------------------------|-----------------|---------------------------------------------------------|
| 1 | `workflow-brainstorm`          | A (light) / D (deep) | trigger → `brainstorm.md`                          |
| 2 | `workflow-brainstorm-review`   | B               | `brainstorm.md` → `brainstorm_review.md`                |
| 3 | `workflow-investigate`         | C (area split)  | brainstorm.md / trigger → `investigation.md`            |
| 4 | `workflow-investigate-review`  | A               | `investigation.md` → `investigate_review.md`            |
| 5 | `workflow-tasker`              | D (architect lead) | `investigation.md` → `plan.md` + `target_type` + `team_runtime` |
| 6 | `workflow-tasker-review`       | B (95% consensus) | `plan.md` → `tasker_review.md`                        |
| 7 | `workflow-write-test`          | C (file split)  | `plan.md` → `*.test.*` (RED) + `test_cycles[]`          |
| 8 | `workflow-coding`              | A / C (module split) + E (watchdog) | test_files (RED) / feedback → `src/**` changes |
| 9 | `workflow-agent-review`        | B (dual: code+security) | `src/**` diff → `agent_review.md` + `## Risks` |
| 10 | `workflow-e2e`                | A (qa-tester)   | built `src/**` → `artifacts/` (video/log/screenshots)   |
| 11 | `workflow-e2e-review`         | A               | `artifacts/` → `e2e_review.md`                          |
| 12 | `workflow-team-code-review`   | B (advocate+critic+arbitrator) | whole change → `team_review.md` + severity |
| 13 | `workflow-verify`             | A (qa-tester)   | current codebase → `verify_report.md` (3 phases: tests + static + E2E) |
| 14 | `workflow-human-check`        | User            | all artifacts → user decision (rework / complete / hold / upgrade) |

All 6 review skills (rows 2, 4, 6, 9, 11, 12) enforce **Multi-Pass Verification** (§9-3 of `workflow.md`): 3 mandatory rounds with focus ∈ {omission, contradiction, edge_case}. Skill-level `pass` is only declared when `completed_rounds === 3` and every round passed. Anti-evasion rule 4 is hook-enforced.

### 1-4. Utility skills (`skills/<name>/SKILL.md`, no `workflow-` prefix)

Mode-unrestricted (Iron Law #6). Two shipped:
- `skills/deep-interview/SKILL.md` — planning-first requirement discovery
- `commands/queue.md` — `/queue <intent>` soft redirect

---

## 2. Runtime scripts (`scripts/`)

### 2-1. Hooked scripts (wired in `hooks/hooks.json`)

| Hook event           | Script                               | Purpose                                                             |
|----------------------|--------------------------------------|---------------------------------------------------------------------|
| `SessionStart`       | `session-start-smt.mjs`              | Smelter session init                                                |
| `SessionStart: init` | `setup-init.mjs`                     | Plugin setup                                                        |
| `SessionStart: maintenance` | `setup-maintenance.mjs`       | Plugin maintenance                                                  |
| `UserPromptSubmit`   | `keyword-detector.mjs`               | Magic keyword classifier + command routing                          |
| `UserPromptSubmit`   | `auto-confirm-consumer.mjs`          | Consumes `.smt/state/auto-confirm-queue-<sessionId>.json` (session-scoped), injects as context |
| `UserPromptSubmit`   | `skill-injector.mjs`                 | Injects skill prompts per current workflow                          |
| `PreToolUse`         | `pre-tool-enforcer.mjs`              | Pre-tool policy enforcement                                         |
| `PreToolUse`         | `rule-injector.mjs`                  | Language-scoped rule injection (`rules-lib/<lang>`)                 |
| `PermissionRequest: Bash` | `permission-handler.mjs`        | Bash permission policy                                              |
| `PostToolUse`        | `post-tool-verifier.mjs`             | General post-tool verification                                      |
| `PostToolUse`        | `tool-retry.mjs`                     | Transient-error retry (ripgrep timeout, file-modified, flag-parse)  |
| `PostToolUse: Edit\|Write\|Bash` | `critic-watchdog.mjs`    | Pattern E Layer 1 — 10 Iron-Law rules, CRITICAL=exit 2 (block)      |
| `SubagentStart`      | `subagent-tracker.mjs start`         | Sub-agent lifecycle tracking                                        |
| `SubagentStop`       | `subagent-tracker.mjs stop`          | Sub-agent lifecycle tracking                                        |
| `PreCompact`         | `pre-compact.mjs`                    | Pre-compaction bookkeeping                                          |
| `Stop`               | `auto-confirm.mjs`                   | §11 decision tree → queue-drop + emit block                         |
| `Stop`               | `stop-stage-enforcer.mjs`            | Workflow stage-progression guard (terminal-stage requirement); E2E reminder is now a fallback |
| `SessionEnd`         | `session-end.mjs`                    | Doc-sync check + forbidden-reference scan                           |

### 2-2. Library scripts (imported, not hooked)

| Script                       | Role                                                                         |
|------------------------------|------------------------------------------------------------------------------|
| `state-schema.mjs`           | `.state.json` schema v2.4.1 — `createInitialState`, `validate`, `readState`, `writeState`, enums (modes, causes, evidence types, target types, patterns, verification focuses) |
| `mode-classifier.mjs`        | Natural-language → mode; `classifyChain` for compound intents (e.g., 검증하고 수정해 → `[investigate, fix]`) |
| `mode-classifier.test.mjs`   | 15-case test suite (single, chained, non-chain negatives, direct API)        |
| `auto-confirm.mjs`           | Stop-hook decide tree (§11-2), chain-advance (§4-3), risk sub-tasker (§11-3), queue-drop writer |
| `auto-confirm-consumer.mjs`  | UserPromptSubmit-hook queue reader; 5-min staleness cap; deletes queue after consume |
| `auto-confirm.test.mjs`      | 51-case test suite for decide tree + CLI smoke + queue-drop end-to-end       |
| `route-on-fail.mjs`          | Producer-chain routing (§5-1); `severity`-branch for team-code-review; `cause`-branch for coding and e2e-review; `active_feedback`-dynamic for human-check |
| `stall-detector.mjs`         | 6 stall signals + 4-level Cascade (§11-7)                                    |
| `parallel-dispatcher.mjs`    | Per-skill dispatch plan from `SKILL.md` + `state.team_runtime`; supports A/B/C/D |
| `critic-watchdog.mjs`        | Hook Layer 1: 10 formal rules (R01–R10), CRITICAL=block, HIGH=warn, MEDIUM=log |
| `feature-version-check.mjs`  | `.smt/features/*` integrity scan; surfaces orphan `state/workflow.json`       |
| `session-end.mjs`            | Doc-sync audit: tracked md sync, magic-keyword parity, retired-term scan     |

---

## 3. State model (`.smt/features/<slug>/task/<task>.state.json`)

Single source of truth per task. Schema version `2.3.0`. Produced by `scripts/state-schema.mjs`.

Top-level fields:
- `schema_version`: `"2.3.0"`
- `task_id`, `mode` (`MODES` enum), `allowed_skills[]` (workflow-* whitelist)
- `current_stage`, `completed_stages[]`
- `target_type`: `new_feature | refactor | extend_existing | migration | bug_fix`
- `surface[]`, `exempt{tdd, e2e}`
- `team_runtime{}` — per-skill `{pattern, assigned_agents[], aggregator, rounds[], ...}`
- `events[]` — append-only audit log; each entry `{t, skill, result, declarer, cause, evidence}`
- `test_cycles[]` — TDD RED→GREEN record; each `{t, file, action, case_name, run_result, error}`
- `active_feedback[]` — unresolved review feedback; each `{id, from, target_skill, text, resolved}`
- `sub_tasks[]` — child task ids spawned by sub-tasker
- `chained_modes[]` — (optional) residual auto-transition chain from `classifyChain`

Validated invariants:
- `allowed_skills` ⊂ the 13 workflow skills
- `events[].declarer` ∈ `{hook, user}` (`skill` is forbidden per Iron Law #3)
- `events[].cause` ∈ fixed enum (14 values incl. `verification_failed`, `stall_cascade`, `conflict_merge_failed`)
- `team_runtime[skill].rounds[i]` (when present) has `focus` ∈ `{omission, contradiction, edge_case}` and `result` ∈ `{null, pass, fail}`
- `active_feedback[i].target_skill` ∈ workflow skills; `resolved` boolean

---

## 4. Agents catalog (`agents/`)

### 4-1. Core v2.4.1 workflow-support agents

| Agent                    | Role                                                            | Tools           | Used by                                             |
|--------------------------|-----------------------------------------------------------------|-----------------|-----------------------------------------------------|
| `aggregator.md`          | Merge Pattern C parallel outputs into single file; detect conflicts | Read+Write+Edit+Grep+Glob+Bash | Pattern C skills (investigate, coding, write-test, brainstorm deep) |
| `conflict-resolver.md`   | Adjudicate aggregator-declared conflicts; write consolidated file | Read+Write+Edit+Grep+Glob+Bash | Aggregator failure escalation (§12-7)              |
| `critic-watchdog.md`     | Pattern E Layer 2 — semantic watchdog during workflow-coding    | Read+Grep+Glob (ReadOnly) | workflow-coding periodic (every 5–10 tool calls) |
| `debugger.md`            | Stall Cascade Level 1 diagnostic                                | Read+Grep+Glob+Bash (read-only) | §11-7 Cascade Level 1                       |
| `advocate.md`            | Pattern B positive role — defend merits                         | Read+Grep+Glob+Bash (via disallowedTools Write/Edit) | workflow-team-code-review, workflow-tasker-review |
| `critic.md`              | Pattern B negative role — find defects                          | same as advocate | same                                               |
| `arbitrator.md`          | Pattern B neutral synthesizer — compute consensus, render verdict | same as advocate | same; also aggregator for Pattern B dual-review  |
| `product-persona.md`     | Pattern D brainstorm-deep voice — user/business perspective     | Read+Grep+Glob   | workflow-brainstorm (depth: deep)                  |
| `engineer-persona.md`    | Pattern D brainstorm-deep voice — engineering feasibility       | Read+Grep+Glob+Bash | workflow-brainstorm (depth: deep)                |
| `design-persona.md`      | Pattern D brainstorm-deep voice — UX / a11y / copy             | Read+Grep+Glob   | workflow-brainstorm (depth: deep)                  |

### 4-2. Role specialists (examples; see `agents/` for full inventory)

- Execution: `executor.md`, `executor-high.md`, `executor-low.md`
- Planning / architecture: `planner.md`, `architect.md`, `architect-medium.md`, `architect-low.md`, `analyst.md`
- Review: `code-reviewer.md`, `code-reviewer-low.md`, `security-reviewer.md`, `security-reviewer-low.md`
- Exploration / research: `explore.md`, `explore-medium.md`, `explore-high.md`, `researcher.md`, `researcher-low.md`
- QA: `qa-tester.md`, `qa-tester-high.md`, `tdd-guide.md`, `tdd-guide-low.md`
- Design & writing: `designer.md`, `designer-high.md`, `designer-low.md`, `writer.md`
- Ops: `build-fixer.md`, `build-fixer-low.md`, `git-master.md`
- Deep work: `deep-executor.md`, `scientist.md`, `scientist-high.md`, `scientist-low.md`, `vision.md`

---

## 5. Iron Laws (runtime enforcement)

See `document/workflow.md §0` for the 8 laws. Enforcement surfaces:

| # | Law                              | Where enforced                                                                                          |
|---|----------------------------------|---------------------------------------------------------------------------------------------------------|
| 1 | Never halt after failure         | `scripts/auto-confirm.mjs` decide tree → queue-drop → `auto-confirm-consumer.mjs` injection             |
| 2 | No evasion                       | `scripts/critic-watchdog.mjs` R08 (evasion patterns), auto-confirm risk keyword → sub-tasker            |
| 3 | No skill self-failure            | `scripts/state-schema.mjs` validator: `events[].declarer ∈ {hook, user}` (skill forbidden)              |
| 4 | No retry                         | `scripts/route-on-fail.mjs` — producer-chain routing only; no `max_retry` field anywhere                |
| 5 | File is truth                    | State schema validation + Iron-Law-gate scripts reject postcondition claims without file evidence       |
| 6 | Workflow whitelist = user decision | `scripts/route-on-fail.mjs` → `whitelist_violation` return; `workflow-human-check` `upgrade` option    |
| 7 | Independent queues, shared session | Per-task `<task>.state.json` isolates queue; session may touch multiple tasks                         |
| 8 | Scoped testing                   | `workflow-e2e` + `workflow-write-test` SKILL.md gates; full regression only at `workflow-human-check`   |

---

## 6. Key flows

### 6-1. Stop-hook decision flow

```
Claude Code Stop event
    │
    ▼
scripts/auto-confirm.mjs
    ├── read .smt/features/<slug>/task/<task>.state.json
    ├── decide():
    │     ├── chained_modes.length > 1 + transition signal → chain_advance
    │     ├── current_stage === workflow-human-check → halt (user input)
    │     ├── _awaiting_mode_upgrade → halt
    │     ├── last event fail → route(event) via producer chain
    │     ├── risk keyword in lastAssistantText → spawn_sub_tasker
    │     ├── unresolved active_feedback → enter target_skill
    │     └── last event pass → advance
    └── drop to .smt/state/auto-confirm-queue-<sessionId>.json + emit block (exit 2)
        (session-scoped per stdin session_id; legacy shared filename fallback only when absent)

next UserPromptSubmit
    │
    ▼
scripts/auto-confirm-consumer.mjs
    ├── read queue; if absent or > 5min old → exit 0
    └── emit { decision: 'continue', additionalContext: <injection> } + delete queue
```

### 6-2. Producer-chain fail routing

```
skill fail event recorded in state.events
    │
    ▼
scripts/route-on-fail.mjs
    ├── severity branch (team-code-review: CRITICAL/HIGH → tasker, MEDIUM → coding, LOW → Risks/pass)
    ├── cause branch  (coding: tdd_cycle → write-test, scope_mismatch → tasker; e2e-review: file_absent → e2e, insufficient_scenario → coding)
    ├── dynamic       (human-check: active_feedback.target_skill)
    └── default       (per-skill onFail in PRODUCER_CHAIN)
    │
    ▼
whitelist check (workflow-* in state.allowed_skills)
    ├── hit  → { target, reason }
    └── miss → { whitelist_violation, suggested_upgrade_target } (→ human-check mode-upgrade path)
```

### 6-3. Parallel (Pattern C) execution

```
workflow-tasker populates state.team_runtime[skill] with { pattern: 'C', assigned_agents: [...], aggregator, sync_point }
    │
    ▼
scripts/parallel-dispatcher.mjs buildDispatchPlan(skill, state)
    ├── read SKILL.md team_template.C
    └── merge with runtime → { tasks[], sync_point, aggregator, conflict_resolver }
    │
    ▼
N agents run in parallel (per `tasks`)
    │
    ▼
isSyncPointReached(skill, state) → all assigned_agents done / failed
    │
    ▼
aggregator agent (e.g., architect) merges outputs
    ├── conflict detected → append to team_runtime.conflicts[]
    └── clean merge → write aggregation_result path
    │
    ▼ (on conflict)
conflict-resolver agent per-conflict adjudication
    ├── resolved: true → continue
    └── resolved: false → sub-tasker creates "resolve conflict" task → §11-7 Level 4 if sub-task also fails
```

### 6-4. Stall cascade (§11-7)

```
auto-confirm detects one of 6 stall signals
    (parallel_tool_inactive | repeated_fail | sync_point_wait |
     tdd_no_green | feedback_backlog | state_stale)
    │
    ▼
Level 1 — spawn `debugger` (ReadOnly) → diagnosis + resolvable_in_session
    ├── resolvable → unblock strategy applied → retry skill
    └── unresolvable → Level 2
    │
    ▼
Level 2 — producer-chain reroute to upstream skill
    │
    ▼ (failure)
Level 3 — sub-tasker extracts blocker as new task; current task status: blocked
    │
    ▼ (failure)
Level 4 — request mode upgrade (user decision); only user-facing cascade level
```

---

## 7. Multi-Pass Verification (§9-3)

All 6 review skills (`brainstorm-review`, `investigate-review`, `tasker-review`, `agent-review`, `e2e-review`, `team-code-review`) declare:

```yaml
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
```

Per `state.team_runtime[skill].rounds[]`, each round records `{n, focus, result, findings[]}`. `pass` requires `completed_rounds === 3` and every round result = `pass`. Anti-evasion guardrails:
1. No prior-round-conclusion injection into current round.
2. `critic-watchdog` blocks "already verified" skip statements.
3. Same agent 3× in a row emits warning (Pattern A should mix ≥ 2 types).
4. Declaring `pass` with `completed_rounds < 3` is hook-blocked.

---

## 8. Validation & test harness

- `scripts/auto-confirm.test.mjs` — 51 assertions (decide tree, chain advance, queue-drop end-to-end)
- `scripts/mode-classifier.test.mjs` — 15 assertions (single-mode, chained, non-chain, direct API)
- `scripts/state-schema.mjs` — CLI validator: `node scripts/state-schema.mjs <path>`
- `scripts/feature-version-check.mjs` — `integrityReport(cwd)`: `{current, orphan, mixed, none}` buckets
- `scripts/session-end.mjs` — doc-sync: `EXPECTED_COMMANDS` vs tracked md, `FORBIDDEN_COMMANDS` scan, retired step-engine directory check

Run everything: `node --test scripts/*.test.mjs` (per `package.json` `test` script).

---

## 9. Audit pass 2026-04-20 (5 parallel verifications)

| # | Domain                            | Result                                           |
|---|-----------------------------------|--------------------------------------------------|
| V1 | Script functional integrity     | 9/9 scripts syntax+functional PASS; 15/15 + 51/51 test suites green |
| V2 | Skills × Modes × Commands cross-ref | 10/10 structural checks PASS after remediation (persona agents added, e2e-review branching added) |
| V3 | Agents contracts                 | 10 core agents present (aggregator, conflict-resolver, critic-watchdog, debugger, advocate, critic, arbitrator, product/engineer/design-persona); v1 residue 0 in core |
| V4 | Docs coherence                   | v1 residue 0 in in-scope docs; all xrefs resolve; command set {plan, simple-fix, fix, investigate, implement} |
| V5 | Hooks + config                   | All 17 hook targets exist; `auto-confirm.mjs` + `auto-confirm-consumer.mjs` wired; plugin manifests aligned to 2.3.0 |

Remediation applied post-audit:
- Renamed `auto-confirm-v2.mjs` → `auto-confirm.mjs`; added `auto-confirm-consumer.mjs` (queue-drop pattern)
- Added 5 previously-referenced agents: `advocate`, `arbitrator`, `product-persona`, `engineer-persona`, `design-persona`
- `route-on-fail.mjs` e2e-review split into `file_absent → workflow-e2e` / `insufficient_scenario → workflow-coding`
- `session-end.mjs` FORBIDDEN_COMMANDS: removed `simple` (was false-positiving `/simple-fix`)
- `plugin.json`, `.claude-plugin/plugin.json`, `package.json` all bumped to `2.3.0`
- `document/index.md` tag normalized to `v2.4.1`
- `workflow.md` footer `End of workflow-v2.md` → `End of workflow.md`

---

## 10. Related documents

- `document/workflow.md` — canonical behavioral spec (§0–§18 + Appendix A/B/C)
- `document/Introduce.md` — principles intro (skill composition, file-based memory, role structure)
- `document/index.md` — documentation navigation
- `document/implementation.md` — phase-by-phase implementation checklist
- `CLAUDE.md` — root agent instructions (per-session system prompt)
- `AGENTS.md` — agent catalog and invocation patterns
- `README.md` — public-facing project overview
