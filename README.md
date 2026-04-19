<p align="center">
  <img src="assets/smelter-logo.svg" alt="Smelter" width="600" />
</p>

<p align="center">
  <strong>Skill-composition workflow engine for Claude Code — TDD-first, file-based, multi-agent.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> &middot;
  <a href="#commands">Commands</a> &middot;
  <a href="#how-it-works">How It Works</a> &middot;
  <a href="#iron-laws">Iron Laws</a> &middot;
  <a href="#philosophy">Philosophy</a>
</p>

<p align="center">
  <code>v2.3.0</code>
</p>

---

## Install

```bash
claude plugin marketplace add Yusang-park/Smelter
claude plugin install smelter@smelter-marketplace
```

Auto-updates on every session start.

---

## TL;DR

- **5 commands**: `/plan`, `/implement`, `/fix`, `/simple-fix`, `/investigate`. Natural-language input is auto-routed — explicit slash commands override.
- **13 workflow skills** compose into modes (no fixed 10-step pipeline). Each skill declares a `consumes → produces` contract; failures route via **producer chain** — no retries, no evasion, no self-failure.
- **8 Iron Laws** are runtime-enforced via hooks (`auto-confirm`, `critic-watchdog`), not just prompts.
- **Multi-Pass Verification**: all 6 review skills run 3 mandatory rounds (omission / contradiction / edge_case) before declaring `pass`.
- **File-based state**: every task has a single-source `*.state.json` at schema v2.3.0. Agents read files, not memory.

---

## Features

| # | Feature                       | What it gives you                                                                                  |
|---|-------------------------------|----------------------------------------------------------------------------------------------------|
| 1 | Auto-routing mode classifier  | `scripts/mode-classifier.mjs` maps `"버그 고쳐줘"` → `/fix`, `"검증하고 수정해"` → `investigate → fix chain` |
| 2 | Producer-chain routing        | On fail, the engine routes to the upstream skill that produced the artifact — *never* retries blindly |
| 3 | Auto-confirm (never-halt)     | Stop hook drops a continuation payload into `.smt/state/auto-confirm-queue.json`; `UserPromptSubmit` consumer injects it on the next turn. Session keeps moving |
| 4 | Risk auto-tasking             | Risk keywords ("리스크", "TODO", "나중에") in the agent's reply auto-spawn a `sub-tasker` task so concerns never get lost |
| 5 | Stall Cascade (4 levels)      | `scripts/stall-detector.mjs` emits 6 signals; Level 1 spawns a ReadOnly `debugger`, Level 2 reroutes via producer chain, Level 3 sub-tasks the blocker, Level 4 requests mode upgrade |
| 6 | Team Agent Patterns           | A (Specialist) • B (95% Consensus: advocate + critic + arbitrator) • C (Parallel Delegation + Aggregator + Conflict-Resolver) • D (Hierarchical Lead + sub-agents) • E (Critic Watchdog) |
| 7 | Critic Watchdog (2 layers)    | Layer 1: `PostToolUse` hook, 10 formal rules, CRITICAL = exit 2 (block). Layer 2: semantic ReadOnly agent every 5–10 tool calls during `workflow-coding` |
| 8 | Multi-Pass Verification       | Review skills run `omission → contradiction → edge_case` rounds; `pass` requires all 3; no prior-round leakage |
| 9 | Surface-based exemption       | CSS / i18n / typo / dialogue surfaces auto-skip TDD; keyword table encoded in each mode           |
| 10 | File-based single source       | `.smt/features/<slug>/task/<task>.state.json` (schema v2.3.0) is the single source of truth — no in-memory state, no hidden retries |

---

## Commands

| Command        | Mode          | Entry skill                      | Use when                                                |
|----------------|---------------|----------------------------------|---------------------------------------------------------|
| `/plan`        | `plan`        | `workflow-brainstorm` (deep)     | New feature or refactor; planning comes first           |
| `/implement`   | `implement`   | `workflow-brainstorm` (light)    | Build on existing code; lightweight interview           |
| `/fix`         | `fix`         | `workflow-investigate`           | Bug / logic repair requiring investigation              |
| `/simple-fix`  | `simple_fix`  | `workflow-coding`                | Trivial text, CSS, or constant substitution             |
| `/investigate` | `investigate` | `workflow-investigate`           | Read-only investigation; exit to another mode after     |

Natural-language auto-routing covers Korean + English verbs (`검증`, `분석`, `파악`, `만들어줘`, `리팩토링`, `verify`, `validate`, `implement`, …) and compound intents (`검증하고 수정해` → `investigate → fix`).

---

## How It Works

### 1. Skill composition over fixed steps

Each mode is a **subset of the 13 workflow skills** plus an entry point.

```
fix mode:
  investigate → investigate-review → tasker → tasker-review →
  write-test → coding → agent-review →
  e2e → e2e-review → team-code-review → human-check
```

Every skill declares a contract in `skills/workflow-*/SKILL.md`:

```yaml
name: workflow-coding
consumes: *.test.* (RED) OR active_feedback
produces: src files changed
default_pattern: A
default_agent: executor
supports_patterns: [A, C]
gate:
  pre:
    - tdd_cycle: "test_cycles has action=added_case|modified_case + run_result=fail"
  post:
    - src_changed: true
    - typecheck_clean: true
    - scoped_tests_pass: true
```

### 2. Producer-chain routing (no retries)

When a skill fails, `scripts/route-on-fail.mjs` looks up the producer:

```
workflow-coding (tdd_cycle fail) → workflow-write-test
workflow-coding (scope_mismatch fail) → workflow-tasker
workflow-team-code-review (CRITICAL) → workflow-tasker
workflow-team-code-review (MEDIUM)   → workflow-coding
workflow-e2e-review (file_absent)    → workflow-e2e
workflow-e2e-review (insufficient_scenario) → workflow-coding
workflow-human-check (rework) → active_feedback[].target_skill
```

If the routed target is outside the mode's `allowed_skills`, the engine emits a **mode upgrade** request — user-gated.

### 3. Queue-drop auto-confirm

Stop hooks have a 15-second cap. Smelter splits the "never halt" logic:

- `scripts/auto-confirm.mjs` (Stop) — reads `*.state.json`, runs the decide tree, drops the injection payload into `.smt/state/auto-confirm-queue.json`, emits a `block` decision.
- `scripts/auto-confirm-consumer.mjs` (UserPromptSubmit) — reads the queue (ignores entries older than 5 min), injects via `additionalContext`, deletes the queue.

The only halt conditions: explicit user stop, `workflow-human-check` awaiting input, mode-upgrade decision, or no active state.

### 4. Team patterns (A–E)

Selected by `workflow-tasker` at plan-time, stored in `state.team_runtime[skill]`:

- **A. Specialist** — 1 skill, 1 agent. Default for most skills.
- **B. Team Consensus (95%)** — `advocate` + `critic` + `arbitrator` run rounds until agreement ≥ 95%. Default for `workflow-tasker-review` and `workflow-team-code-review`; `workflow-agent-review` uses a Pattern B dual (code-reviewer + security-reviewer → arbitrator).
- **C. Parallel Delegation** — N agents split by area / file / module, `aggregator` merges at `sync_point`, `conflict-resolver` adjudicates merge failures. Default for `workflow-investigate` (area), `workflow-write-test` (file), `workflow-coding` (module, when split).
- **D. Hierarchical** — lead agent orchestrates sub-agents. Default for `workflow-tasker` (architect + researcher + executor) and `workflow-brainstorm` deep (planner + product/engineer/design personas).
- **E. Adversarial Watchdog** — `scripts/critic-watchdog.mjs` (Layer 1, hook) + `agents/critic-watchdog.md` (Layer 2, periodic agent). Always active during `workflow-coding`.

### 5. Multi-Pass Verification (review skills only)

Every review skill runs 3 mandatory rounds:

| Round | Focus          | Asks                                                             |
|-------|----------------|------------------------------------------------------------------|
| 1     | omission       | What's missing from the artifact?                                |
| 2     | contradiction  | What conflicts internally or with upstream?                      |
| 3     | edge_case      | What corner cases are unaddressed?                               |

Rounds are recorded in `state.team_runtime[skill].rounds[]`. `pass` requires `completed_rounds === 3` and every round `result === 'pass'`. Hook-blocked against premature `pass`.

### 6. Stall Cascade (§11-7)

6 signals: parallel-agent tool-inactive, repeated fail, sync-point wait, tdd-no-green, feedback backlog, state stale.

```
Level 1 debugger (ReadOnly)   — diagnose + propose unblock
Level 2 producer reroute      — jump upstream
Level 3 sub-tasker extract    — blocker becomes a new task
Level 4 mode upgrade          — only user-facing level
```

---

## Iron Laws

Non-negotiable. Runtime-enforced.

1. **Never halt after failure** — the session keeps moving via producer chain + queue-drop.
2. **No evasion** — risk keywords in replies auto-spawn sub-tasks; critic-watchdog R08 flags `??`-chain / TODO evasion.
3. **No skill self-failure** — `events[].declarer` ∈ `{hook, user}`; skill-declared fails are rejected by state schema.
4. **No retry** — producer-chain routing replaces `max_retry`. Same skill may self-rerun after upstream state changes; not a retry.
5. **File is truth** — agents read `.state.json`, not in-memory claims.
6. **Workflow whitelist is user decision** — any `workflow-*` outside the mode's allowed set requires user-gated mode upgrade.
7. **Independent queues, shared session** — per-task queues; specialist agents assignable.
8. **Scoped testing** — full regression only at `workflow-human-check`.

See `document/workflow.md` §0 for details.

---

## Project layout

```
agents/                          ← 39 sub-agent definitions (10 core v2.3.0 + 29 specialists)
commands/                        ← 5 slash-command entry points
document/                        ← workflow.md (spec), implementation-v2.md (this arch), Introduce.md, index.md
hooks/hooks.json                 ← Claude Code hook registrations
modes/                           ← 5 mode JSON files
scripts/                         ← runtime scripts (auto-confirm, mode-classifier, route-on-fail, stall-detector, critic-watchdog, …)
skills/                          ← 13 workflow-* skills + utility skills (deep-interview, queue)
src/                             ← core TypeScript engine
.smt/                            ← project-local state (features, state, session, wiki)
```

---

## Philosophy

> **Agents do not memorize. Agents read files.**

Every plan, task, decision, and event is persisted to `.smt/`. Session start = re-read files. Progress = update files. Memory lives in files, not in the context window.

> **Automate the actual human developer workflow.**

Receive work → investigate → plan → TDD → implement → review (self + team) → verify (E2E) → human-check → deploy. Smelter models this as a skill graph; Claude Code executes it.

> **User-driven, not autonomous.**

Mode upgrade, human-check verdict, and mode transitions are gated by the user. Everything else keeps moving.

---

## Status

- Version: `2.3.0`
- Canonical spec: [`document/workflow.md`](document/workflow.md)
- Implementation reference: [`document/implementation-v2.md`](document/implementation-v2.md)
- Agent instructions: [`CLAUDE.md`](CLAUDE.md), [`AGENTS.md`](AGENTS.md)
- Test suites: `scripts/auto-confirm.test.mjs` (51 cases), `scripts/mode-classifier.test.mjs` (15 cases)

Tested on macOS 14+ with Node 20+. Plugin-scope installs via `claude plugin install`.

---

## License

Private. See `plugin.json` for metadata.
