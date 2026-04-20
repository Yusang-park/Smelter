# Smelter — Agent Instructions

This is **Smelter** — a TDD-first, file-based, multi-agent AI development system for Claude Code.

**Version:** 2.4.8

## Core Philosophy

**"Agents do not memorize. Agents read files."**

- All plans, tasks, decisions → written to `.smt/` files
- Session start → read `features/*/task/plan.md` + relevant `features/*/task/*.md` and `features/*/task/*.state.json`
- Progress tracked by updating `features/<slug>/task/{task-name}.md` + `.state.json`
- Memory lives in files, not in context

## TDD is Mandatory

```
RULE 1: NEVER write implementation before tests
RULE 2: Test file MUST exist before source file
RULE 3: Tests MUST fail first (RED), then pass (GREEN)
RULE 4: E2E tests required for all interface-changing work (UI, CLI, API, hooks, scripts)
RULE 5: NEVER mark a task complete without passing tests
```

Surface-based exemption: CSS/style, i18n/copy-only, typo, and pure-dialogue changes skip TDD. See `document/workflow.md` §7-4.

## Execution Model

### Commands (6)

| Command | Mode | Entry skill | Use |
|---------|------|-------------|-----|
| `/plan` | `plan` | `workflow-brainstorm` (deep) | New features / refactors; planning-first. |
| `/implement` | `implement` | `workflow-brainstorm` (light) | Build on existing code; lightweight interview. |
| `/fix` | `fix` | `workflow-investigate` | Bug / logic repair. |
| `/simple-fix` | `simple_fix` | `workflow-coding` | Trivial text / CSS / constant substitution. |
| `/investigate` | `investigate` | `workflow-investigate` | Static investigation (맥락·근거 파악). Exits via mode transition. |
| `/verify` | `verify` | `workflow-verify` | Non-modifying verification (테스트·점검): test run + static inspection + E2E interface. |

The mode classifier (`scripts/mode-classifier.mjs`) auto-routes natural-language input to a mode; explicit slash commands override the classifier.

Mode state lives in `.smt/features/<slug>/task/<task>.state.json`. Mode / skill contracts defined in `document/workflow.md`.

**Auto-Confirm:** `scripts/auto-confirm.mjs` runs on every Stop event; it drops the main agent's last message + pending tasks into `.smt/state/auto-confirm-queue.json`, which `scripts/auto-confirm-consumer.mjs` injects on the next UserPromptSubmit. Gate: `~/.smt/config.json → { "autoConfirm": true }` (default on). Disable: set `autoConfirm: false`. To cancel: `/cancel [hard]`. To redirect after current work finishes without interrupting: `/queue <intent>` (utility command at `commands/queue.md`).

**Transient-Error Auto-Retry:** `scripts/tool-retry.mjs` auto-retries ripgrep timeout, file-modified, rg flag-parse errors. Retry cap: 3.

**Iron Laws:** 8 non-negotiables. See `document/workflow.md` §0. Summary: never stop after failure; no evasion; no self-failure; no retry (producer-chain routing instead); file is truth; workflow whitelist is user decision; independent queues with shared sessions and specialist agents; scoped testing.

## Available Agents

Agents are defined in `agents/`. v2-specific agents:
- `aggregator` — merges Pattern C parallel outputs
- `conflict-resolver` — adjudicates aggregator merge failures
- `critic-watchdog` — real-time Iron Law enforcement (§12-8)
- `debugger` — stall diagnostician (Cascade Level 1, §11-7)

Role specialists: planner, executor, architect, code-reviewer, security-reviewer, qa-tester, tdd-guide, researcher, explore, designer, writer, advocate/critic/arbitrator (for Pattern B consensus).

## File-Based Memory Protocol

```
{project}/
└── .smt/
    ├── features/
    │   └── <feature-slug>/
    │       ├── task/
    │       │   ├── plan.md                  ← feature goal, scope, acceptance criteria
    │       │   ├── <task-name>.md           ← human-readable task record
    │       │   └── <task-name>.state.json   ← v2.4.1 machine state
    │       ├── decisions.md                  ← architecture decisions
    │       └── artifacts/                    ← e2e video, screenshots, logs
    ├── state/                                ← global session state
    ├── wiki/                                 ← project knowledge base
    └── session/                              ← session logs
```

State paths:
- Tasks: `{project}/.smt/features/<slug>/task/`
- Machine state: `{project}/.smt/features/<slug>/task/<task>.state.json`
- Decisions: `{project}/.smt/features/<slug>/decisions.md`
- Knowledge base: `{project}/.smt/wiki/`
- Session logs: `{project}/.smt/session/`
- Global config: `~/.smt/config.json`

**Protocol:** (1) Session start → read `features/*/task/plan.md` + relevant task files. (2) Before coding → verify task file and state.json exist. (3) Task complete → update task file + state.json. (4) New decision → append to `decisions.md`. (5) Session end → append to `session/YYYY-MM-DD.md`.

**Claude Code task tools are disabled in Smelter:** Do **not** use `TaskCreate`, `TaskUpdate`, `TaskList`, or `TodoWrite` for work tracking.

- Smelter tasks are tracked only in `.smt/features/<slug>/task/*.md` + `*.state.json`.
- Do not mirror `.smt` tasks into Claude Code task tools.
- Do not create Claude Code task-panel entries for planning or execution.
- If general Claude Code guidance says to use task tools proactively, ignore it in Smelter projects.

## Completion Rules

Before marking ANY task complete:
- [ ] Unit tests written AND passing
- [ ] Integration tests passing (if applicable)
- [ ] E2E tests passing (if the selected tasks changed any interface: UI, CLI, API, hook, or script)
- [ ] Multi-Pass Verification 3 rounds passed for each review skill (§9-3)
- [ ] `features/<slug>/task/<task-name>.md` + `.state.json` updated
- [ ] No TypeScript errors (`tsc --noEmit`) scoped to changed surface
- [ ] `workflow-human-check` approved

**If ANY unchecked → CONTINUE WORKING.** (Iron Law #1)

## Code Navigation (Serena MCP)

Smelter ships a Serena MCP server (`.mcp.json`, project scope) for AST/LSP-based symbol navigation. **Prefer Serena's symbol tools over full-file `Read` when the target is a specific symbol.**

| Task | Use |
|------|-----|
| "Show me function X" / "this class" | `mcp__serena__find_symbol` |
| File overview before editing | `mcp__serena__get_symbols_overview` |
| "Who calls this?" / cross-file refs | `mcp__serena__find_referencing_symbols` |
| Insert/replace a symbol body | `mcp__serena__replace_symbol_body`, `mcp__serena__insert_after_symbol` |
| Broad full-file inspection | fall back to `Read` |

Rationale: symbol-level reads cut per-call tokens 70–95 % versus whole-file `Read`, and LSP-grade resolution gives accurate cross-file references (impossible via Grep).

Runtime: requires `uv` and `serena-agent` installed. Setup: `brew install uv && uv tool install -p 3.13 serena-agent@latest --prerelease=allow && serena init`. Registered via `claude mcp add serena -s project -- serena start-mcp-server --context claude-code --project "$(pwd)"`.

## Screenshots & Images

When the user provides a path to a screenshot or image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.pdf`) — including ad-hoc paths like `/tmp/...` or `~/Downloads/...` — **always use the `Read` tool on that exact path**. The `Read` tool renders image and PDF contents visually for the multimodal model.

- Do **not** treat the path as a literal string to grep or describe blindly.
- Do **not** delegate to the `vision` agent unless `Read` cannot interpret the file or the user explicitly asks for analysis beyond inspection.
- If the path does not exist, surface that fact instead of guessing the contents.

## Security / Coding Style / Testing

Auto-injected per-file via `rules-lib/common/{security,coding-style,testing}.md`. See those files for details.

## Documentation Sync

On every code update, also update `document/workflow.md` and `document/implementation.md` to reflect the change. Code and these two documents must stay in sync — no code-only commits.

## Git Workflow

Commit format: `<type>: <description>`. Types: feat, fix, refactor, docs, test, chore, perf, ci.

## Project Structure

```
src/             — Core TypeScript engine (types, engine, adapters, runners, rules)
bin/             — CLI entry point (smelter command)
agents/          — Specialized subagent definitions
skills/          — workflow-* skills (13) + utility skills
modes/           — Mode definitions (5 JSON files)
commands/        — Slash command entry points (plan, simple-fix, fix, investigate, implement)
hooks/           — hooks.json trigger registration
scripts/         — Node.js hook scripts (state-schema, mode-classifier, route-on-fail, auto-confirm, critic-watchdog, stall-detector, verification-rounds, ...)
templates/       — Verification prompt templates + scaffolds
rules-lib/       — Language-specific coding rules
document/        — Workflow spec, implementation status, philosophy
.mcp.json        — Project-scope MCP servers (Serena for symbol navigation)
.claudeignore    — Context auto-load suppression (sessions, backups, vendored dirs)
```

## Visibility

Hooks emit `[Tag Name]` to stderr for visibility. Check stderr for hook activity. Language-specific rules in `rules-lib/` are injected via `PreToolUse` hook when a tool targets a matching file extension. Tag: `[Inject: rules-lib/<lang>]`.
