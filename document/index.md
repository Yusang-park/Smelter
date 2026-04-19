---
title: Smelter — Claude Code Workflow Engine
type: index
tags: [smelter, harness, workflow, v2.3.0]
updated: 2026-04-20
---

# Smelter

> **Claude Code workflow engine.** Located at `/Users/yusang/Smelter/`.

> **Principle: the wiki is the single source of truth.**
> This document set is the authoritative specification for Smelter's skills, agents, modes, and file layout.
> Any entry removed or modified here must also be changed in the codebase. Items that exist only in code but not in the wiki are considered incomplete.

## Canonical documents

- [[workflow]] — v2.3.0 specification: modes, skills, routing, verification, teams, hooks.
- [[implementation]] — implementation status tracker (what is built, what ships next).
- [[Introduce]] — philosophy, direction, and the eight Iron Laws.

## 🎯 What Smelter is

> "Automate the actual human developer workflow."

Smelter is a workflow engine that orchestrates Claude Code through the real team software development process: PM intake → investigation → planning → TDD → implementation → verification → team review → human approval → deploy.

## Current architecture (v2.3.0)

| Item | Current state |
|------|---------------|
| Form | Claude Code plugin layer (hooks + scripts + commands + skills) |
| Configuration | File-based task tracking at `.smt/features/<slug>/task/` |
| Model routing | Per-agent explicit model selection (haiku / sonnet / opus) |
| Verification | TDD + scoped-surface E2E + Multi-Pass Verification (3 rounds) |
| Task state | `.smt/` (plan, tasks, state.json, sessions, wiki) |
| Entry points | Magic keyword auto-routing OR explicit slash command |
| Commands (5) | `/plan`, `/implement`, `/fix`, `/simple-fix`, `/investigate` |
| Workflow skills (13) | `workflow-*` prefix, composable per mode |
| Execution guarantee | Iron Law #1 — never stops until user says stop |

## Directory layout

```
Smelter/
├── agents/               ← specialized subagent definitions
├── skills/               ← workflow-* + utility skills
├── modes/                ← mode definitions (5 JSON files)
├── commands/             ← slash command entry points (5 md files)
├── hooks/                ← hooks.json trigger registration
├── scripts/              ← Node.js hook scripts (state, routing, verification, etc.)
├── templates/            ← verification prompt templates + scaffolds
├── rules-lib/            ← language-specific coding rules (auto-injected)
├── document/             ← canonical workflow / implementation / philosophy docs
├── src/                  ← Core TypeScript engine
└── bin/                  ← smelter CLI entry
```

## Where to start

- Writing a new workflow skill? Read [[workflow]] §3 (Registry) then [[workflow]] §12 (Team Agent Patterns).
- Adding a utility skill? Utility skills (no `workflow-` prefix) are mode-unrestricted. Put them under `skills/<name>/SKILL.md`.
- Modifying routing? See [[workflow]] §5 + `scripts/route-on-fail.mjs`.
- Adding a new review? Multi-Pass Verification (§9-3) is mandatory. Register in `scripts/verification-rounds.mjs`.
