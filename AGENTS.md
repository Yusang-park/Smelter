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

Exemption for `/qa` Step 4: CSS/style, i18n/copy-only, typo, and pure-dialogue changes skip TDD (see `document/workflow.md` Step 4).

## Execution Model

### Commands (3)

| Command | Use | Step Range | E2E |
|---------|-----|------------|-----|
| `/tasker` | Create or refine planning state. All state lives in `.smt/features/<slug>/` — no native plan mode. | 1–3 | — |
| `/feat` | Full development workflow on a prompt. "extend" magic keyword skips Step 2. | 1–10 | surface-based (required for interface changes) |
| `/qa` | Bug fixes and simple UI/text/dialogue edits. TDD exemption per surface. | 4–10 | surface-based |

The planning state is the source of truth. It discovers `features/` directories, then reads each `features/<slug>/task/*.md` to select pending tasks, and keeps working until the selected task set is complete or blocked.

### Magic Keywords (natural-language entry)

`scripts/keyword-detector.mjs` maps natural-language phrases to the same commands when no explicit slash is present. Priority: explicit slash > magic keyword.

| Keyword (en/ko) | Command | Branch hint |
|-----------------|---------|-------------|
| `tasker`, `plan`, `설계해줘`, `계획부터` | `/tasker` | — |
| `new feature`, `새 기능`, `design first` | `/feat` | `new-feature` |
| `extend`, `add to`, `덧붙여`, `확장해줘` | `/feat` | `extend` (skip Step 2) |
| `fix`, `bug`, `버그`, `고쳐` | `/qa` | `bug` (E2E forced on) |
| `style`, `typo`, `텍스트`, `색상`, `i18n`, `문구` | `/qa` | `style` (TDD exemption candidate) |
| `cancel`, `stop` | `/cancel` | — |

### Workflow examples

```
/tasker "new onboarding flow"          → planning state + .smt/ state
/feat "add dark mode toggle"           → full 10-step workflow
/feat "extend the existing auth flow"  → Step 2 skipped via magic keyword
/qa "fix login form error text"        → Step 4-10 with TDD exemption
```

### Auto-Confirm (global Stop hook)

`scripts/auto-confirm.mjs` runs on every Stop event. If pending tasks remain in `.smt/`, it forwards the main agent's last response to a sub-agent which returns the next action — the main session then continues without waiting for the human.

- Gate: `~/.smt/config.json` → `{ "autoConfirm": true }` (default on)
- Respects context-limit and user-abort stops (never blocks those)

### Transient-Error Auto-Retry

`scripts/tool-retry.mjs` (PostToolUse) automatically retries common transient tool errors: ripgrep timeout, file-modified-since-read, rg flag-parse misread. Grep exit-code-1-no-match is reclassified as success. Retry cap: 3 per tool+args hash.

## Available Agents

| Agent | Purpose | When to Use |
|-------|---------|-------------|
| `executor` | Code implementation | Standard features, refactoring |
| `executor-low` | Simple fix / lookup | Small edits, single-file changes |
| `executor-high` | Complex refactoring | Large multi-file tasks |
| `architect` | Architecture & debug advice | Architectural decisions |
| `architect-low` | Quick analysis | Fast code questions |
| `explore` | File/code search | Finding files, patterns |
| `explore-high` | Deep codebase search | Complex architectural search |
| `tdd-guide` | TDD enforcement | New features, bug fixes |
| `qa-tester` | E2E testing | Critical user flows |
| `designer` | UI/frontend | Component and page work |
| `code-reviewer` | Code quality | After writing/modifying code |
| `security-reviewer` | Vulnerability detection | Before commits, sensitive code |
| `build-fixer` | Fix build/type errors | When build fails |
| `git-master` | Git operations | Commits, rebasing, history |
| `planner` | Strategic planning | Complex features |
| `critic` | Plan review | Before executing plans |
| `analyst` | Requirements analysis | Early-stage feature scoping |
| `researcher` | External documentation | Library/API research |
| `scientist` | Data analysis | Data and ML tasks |
| `deep-executor` | Complex goal-oriented tasks | Autonomous long-running work |
| `writer` | Technical documentation | README, API docs |
| `vision` | Image/PDF analysis | Visual file interpretation |

Use agents proactively: complex feature → **planner** then **executor**; just wrote code → **code-reviewer**; bug fix or new feature → **tdd-guide**; architectural decision → **architect**; security-sensitive code → **security-reviewer**; build failed → **build-fixer**. Parallelize independent operations.

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

**Protocol:**
1. Session start → Read `features/*/task/plan.md` + relevant `features/*/task/*.md`
2. Before coding → verify task file exists at `features/<slug>/task/<task-name>.md`
3. Task complete → update `features/<slug>/task/<task-name>.md`
4. New decision → append to `features/<slug>/decisions.md`
5. Session end → append to `session/YYYY-MM-DD.md`

## Completion Rules

Before marking ANY task complete:
- [ ] Unit tests written AND passing
- [ ] Integration tests passing (if applicable)
- [ ] E2E tests passing (if the selected tasks changed any interface: UI, CLI, API, hook, or script)
- [ ] `features/<slug>/task/<task-name>.md` updated
- [ ] No TypeScript errors (`tsc --noEmit`)

**If ANY unchecked → CONTINUE WORKING.**

## Security Guidelines

Before ANY commit:
- No hardcoded secrets (API keys, passwords, tokens)
- All user inputs validated
- SQL injection prevention (parameterized queries)
- XSS prevention (sanitized HTML)
- Authentication/authorization verified
- Error messages do not leak sensitive data

If a security issue is found: STOP → `security-reviewer` → fix CRITICAL issues → rotate exposed secrets.

## Coding Style

**Immutability (CRITICAL):** Always create new objects, never mutate existing ones.

**File organization:** Many small files over few large ones. 200–400 lines typical, 800 max.

**Error handling:** Handle errors explicitly at every level. Never silently swallow errors.

**Input validation:** Validate all user input at system boundaries. Fail fast with clear messages.

## Testing Requirements

Minimum coverage: 80%

1. **Unit tests** — Individual functions, utilities, components
2. **Integration tests** — API endpoints, database operations
3. **E2E tests** — Test through the real interface (UI→Playwright, CLI→subprocess, API→real server, hook→stdin/stdout pipe)

TDD workflow: write test first (RED) → minimal implementation (GREEN) → refactor → verify 80%+ coverage.

## Git Workflow

Commit format: `<type>: <description>`. Types: feat, fix, refactor, docs, test, chore, perf, ci.

## Project Structure

```
src/             — Core TypeScript engine (types, engine, adapters, runners, rules)
bin/             — CLI entry point (smelter command)
agents/          — Specialized subagent definitions
skills/          — Reusable workflow skill prompts
commands/        — Slash command definitions (tasker.md, feat.md, qa.md)
hooks/           — hooks.json trigger definitions
scripts/         — Node.js hook scripts (keyword-detector, auto-confirm, tool-retry, session-end, ...)
presets/         — Execution preset configs (tasker, feat, qa)
workflows/       — YAML DAG workflow definitions
rules/           — Language-specific coding rules
document/        — Workflow spec and documentation
```

## Visibility — Yellow Tags

Every hook prints a short ANSI-yellow bracketed tag to stderr so you can see what the harness is doing. Common tags:

| Tag | Source |
|-----|--------|
| `[Command: /<name>]` / `[Magic Keyword: <kw> → /<cmd>]` | keyword-detector |
| `[Inject: <skill>]` | skill-injector |
| `[TDD Gate]` / `[Security Gate]` | pre-tool-enforcer |
| `[Post Verify]` | post-tool-verifier |
| `[Auto-Retry: <reason>]` | tool-retry |
| `[Auto-Confirm]` | auto-confirm |
| `[Run E2E]` | stop-e2e |
| `[TASKER MODE]` | keyword-detector → /tasker |
| `[Doc Sync Check]` | session-end |
| `[Session Start]` | session-start-smt |
| `[Permission]` | permission-handler |
| `[Pre-Compact]` | pre-compact |
| `[Agent Check]` | sub-agent review injection |
| `[FEAT MODE]` / `[QA MODE]` / `[TASKER MODE]` | keyword-detector |
| `[Inject: rules-lib/<lang>]` | rule-injector |

### Rules Injection

`rules-lib/` contains language-specific coding rules injected on a per-surface basis by `scripts/rule-injector.mjs`. Rules are **not** auto-loaded by the CLI at startup; they are injected via a `PreToolUse` hook when a tool targets a file whose extension maps to a known language. Tag: `[Inject: rules-lib/<lang>]`.

## ECC Instinct Learning

Sessions are observed automatically. Patterns become instincts:
- `/instinct-status` — view learned patterns
- `/evolve` — cluster instincts into skills
- Instincts auto-inject on future sessions

## State Paths

| Path | Purpose |
|------|---------|
| `{project}/.smt/` | File-based memory (features/, wiki/, session/) |
| `{project}/.smt/features/<slug>/task/` | Individual task files per feature |
| `{project}/.smt/features/<slug>/decisions.md` | Architecture decisions per feature |
| `~/.smt/config.json` | Global `autoConfirm` toggle |
| `~/.claude/homunculus/` | ECC instinct data |

## Cancel

- `/cancel [hard]` — hard stop
- `/queue <intent>` — finish current work then redirect
- Disable auto-confirm: set `autoConfirm: false` in `~/.smt/config.json`

---

## Appendix — Internal preset names

Users interact via commands only. Preset names exist for implementation reference:

| Preset | Steps | E2E | Tests | Notes |
|--------|-------|-----|-------|-------|
| `tasker` | 1–3 | — | 0 | Planning state only |
| `feat` | 1–10 | required | 10+ | Full workflow |
| `qa` | 4–10 | surface-based | 5+ | Narrow exec, TDD exemption applies |
