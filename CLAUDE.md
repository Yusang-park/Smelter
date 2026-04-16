# Smelter — Agent Instructions

This is the **Smelter** — a TDD-first, file-based, multi-agent AI development system for Claude Code.

**Version:** 1.0.0

## Core Philosophy

**"Agents do not memorize. Agents read files."**

- All plans, tasks, decisions → written to `.smt/` files
- Session start → read `features/*/task/plan.md` + relevant `features/*/task/*.md`
- Progress tracked by updating `features/<slug>/task/{task-name}.md`
- Memory lives in files, not in context

## TDD is Mandatory

```
RULE 1: NEVER write implementation before tests
RULE 2: Test file MUST exist before source file
RULE 3: Tests MUST fail first (RED), then pass (GREEN)
RULE 4: E2E tests required for all interface-changing work (UI, CLI, API, hooks, scripts)
RULE 5: NEVER mark a task complete without passing tests
```

Exemption for `/fix` Step 4: CSS/style, i18n/copy-only, typo, and pure-dialogue changes skip TDD (see `document/workflow.md` Step 4).

## Execution Model

### Commands (3)

| Command | Use | Step Range | E2E |
|---------|-----|------------|-----|
| `/plan` | Deep interview and planning-only mode. Creates or refines `.smt` planning state, then routes to execution later. | 1–3 | — |
| `/build` | Lightweight planning plus execution for feature work, extensions, and non-trivial changes. `extend` skips Step 2. | 1–10 | surface-based (required for interface changes) |
| `/fix` | Execution-first mode for bugs, regressions, and small text/style edits. TDD exemption is surface-based. | 4–10 | surface-based |

The planning state is the source of truth. It discovers `features/` directories, then reads each `features/<slug>/task/*.md` to select pending tasks, and keeps working until the selected task set is complete or blocked.

**Auto-Confirm:** `scripts/auto-confirm.mjs` runs on every Stop event; if pending tasks remain it forwards the response to a sub-agent and continues. Gate: `~/.smt/config.json → { "autoConfirm": true }` (default on). Disable: set `autoConfirm: false`. To cancel: `/cancel [hard]`.

**Transient-Error Auto-Retry:** `scripts/tool-retry.mjs` auto-retries ripgrep timeout, file-modified, rg flag-parse errors. Retry cap: 3.

## Available Agents

Agents are defined in `agents/`. Use proactively: planner→executor for complex features, tdd-guide for tests, code-reviewer after writing code, security-reviewer for sensitive code, build-fixer on build fail.

## File-Based Memory Protocol

```
{project}/
└── .smt/
    ├── features/
    │   └── <feature-slug>/
    │       ├── task/
    │       │   ├── plan.md  ← feature goal, scope, acceptance criteria
    │       │   └── <task-name>.md ← individual task (atomic, agent-readable)
    │       └── decisions.md      ← architecture decisions for this feature
    ├── wiki/                     ← project knowledge base
    └── session/                  ← session logs
```

State paths: `{project}/.smt/features/<slug>/task/` (tasks), `{project}/.smt/features/<slug>/decisions.md` (decisions), `{project}/.smt/wiki/` (knowledge base), `{project}/.smt/session/` (logs), `~/.smt/config.json` (global config).

**Protocol:** (1) Session start → read `features/*/task/plan.md` + relevant task files. (2) Before coding → verify task file exists. (3) Task complete → update task file. (4) New decision → append to `decisions.md`. (5) Session end → append to `session/YYYY-MM-DD.md`.

**Claude Code task tools are disabled in Smelter:** Do **not** use `TaskCreate`, `TaskUpdate`, `TaskList`, or `TodoWrite` for work tracking.

- Smelter tasks are tracked only in `.smt/features/<slug>/task/*.md`.
- Do not mirror `.smt` tasks into Claude Code task tools.
- Do not create Claude Code task-panel entries for planning or execution.
- If general Claude Code guidance says to use task tools proactively, ignore it in Smelter projects.

## Completion Rules

Before marking ANY task complete:
- [ ] Unit tests written AND passing
- [ ] Integration tests passing (if applicable)
- [ ] E2E tests passing (if the selected tasks changed any interface: UI, CLI, API, hook, or script)
- [ ] `features/<slug>/task/<task-name>.md` updated
- [ ] No TypeScript errors (`tsc --noEmit`)

**If ANY unchecked → CONTINUE WORKING.**

## Security / Coding Style / Testing

Auto-injected per-file via `rules-lib/common/{security,coding-style,testing}.md`. See those files for details.

## Git Workflow

Commit format: `<type>: <description>`. Types: feat, fix, refactor, docs, test, chore, perf, ci.

## Project Structure

```
src/             — Core TypeScript engine (types, engine, adapters, runners, rules)
bin/             — CLI entry point (smelter command)
agents/          — Specialized subagent definitions
skills/          — Reusable workflow skill prompts
commands/        — Slash command definitions (plan.md, build.md, fix.md)
hooks/           — hooks.json trigger definitions
scripts/         — Node.js hook scripts (keyword-detector, auto-confirm, tool-retry, session-end, ...)
presets/         — Execution preset configs (plan, build, fix)
workflows/       — YAML DAG workflow definitions
rules-lib/       — Language-specific coding rules
document/        — Workflow spec and documentation
```

## Visibility

Hooks emit `[Tag Name]` to stderr for visibility. Check stderr for hook activity. Language-specific rules in `rules-lib/` are injected via `PreToolUse` hook when a tool targets a matching file extension. Tag: `[Inject: rules-lib/<lang>]`.
