# Smelter — Agent Instructions

This is **Smelter** — a TDD-first, file-based, multi-agent AI development system for Claude Code.

**Version:** 2.4.1

## Core Philosophy

**"Agents do not memorize. Agents read files."**

- All plans, tasks, decisions → written to `.smt/` files
- Session start → read `features/*/task/plan.md` + relevant `features/*/task/*.md` + `*.state.json`
- Progress tracked by updating `features/<slug>/task/{task-name}.md` and `.state.json`
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
| `/plan` | `plan` | `workflow-brainstorm` (deep) | New features / refactors; planning first. |
| `/implement` | `implement` | `workflow-brainstorm` (light) | Build on existing code; lightweight. |
| `/fix` | `fix` | `workflow-investigate` | Bug / logic repair. |
| `/simple-fix` | `simple_fix` | `workflow-coding` | Trivial text / CSS / constant substitution. |
| `/investigate` | `investigate` | `workflow-investigate` | Static investigation (맥락·근거 파악); mode-transition exit. |
| `/verify` | `verify` | `workflow-verify` | Non-modifying verification (테스트·점검): test run + static inspection + E2E interface in one pass. |

The mode classifier (`scripts/mode-classifier.mjs`) auto-routes natural-language input; explicit slash commands override the classifier.

### Magic Keywords (natural-language entry)

| Keyword (en / ko) | Routes to | Branch hint |
|-------------------|-----------|-------------|
| "design X", "plan Y", "refactor", "설계해줘", "계획부터" | `/plan` | — |
| "build X", "add X", "implement X", "extend", "덧붙여", "확장해줘" | `/implement` | `extend` skips brainstorm |
| "fix", "bug", "error", "버그", "고쳐" | `/fix` | `bug` forces E2E on interface surface |
| "text change", "CSS", "rename", "typo", "i18n", "텍스트", "색상" | `/simple-fix` | TDD exemption auto-applied |
| "analyze", "investigate", "how does X work", "파악해", "분석해", "검증해", "확인해", "체크해" | `/investigate` | static read only |
| "테스트 해봐", "점검해", "돌려봐", "run tests", "health check" | `/verify` | tests + static inspect + E2E |
| `cancel`, `stop` | `/cancel` | hard stop |

### Workflow examples

```
/plan "new onboarding flow"          → plan mode; brainstorm-deep → investigate → tasker
/implement "add dark mode toggle"    → implement mode; brainstorm-light → full pipeline
/implement "extend the auth flow"    → magic 'extend' skips brainstorm
/fix "login form error text"         → fix mode; investigate → tasker → write-test → coding
/simple-fix "rename button label"    → simple_fix mode; coding → e2e → human-check
/investigate "how does billing work" → investigate only; exits to /fix or /plan
```

### Auto-Confirm (global Stop hook)

`scripts/auto-confirm.mjs` runs on every Stop event. It drops the main agent's last response + pending tasks into `.smt/state/auto-confirm-queue.json`; `scripts/auto-confirm-consumer.mjs` injects the queued payload on the next UserPromptSubmit. The session never waits on the human for routine continuations.

- Gate: `~/.smt/config.json` → `{ "autoConfirm": true }` (default on)
- Respects context-limit and user-abort stops (never blocks those)

### Iron Laws (8)

Summary. Full detail in `document/workflow.md` §0.

1. Never stop after failure — only user stop ends the session.
2. No evasion — a fail must be resolved, not reclassified as "known limit".
3. No self-failure declaration — a skill cannot output "can't do it".
4. No retry — producer-chain routing, not blind re-runs.
5. File is truth — postcondition files determine completion, not agent claims.
6. Workflow whitelist is user decision — mode upgrades require explicit user consent.
7. Independent queue, shared session, specialist assignment.
8. Scoped testing — only changed-surface tests run before `workflow-human-check`.

### Transient-Error Auto-Retry

`scripts/tool-retry.mjs` (PostToolUse) automatically retries common transient tool errors: ripgrep timeout, file-modified-since-read, rg flag-parse misread. Grep exit-code-1-no-match is reclassified as success. Retry cap: 3 per tool+args hash.

## Available Agents

### v2 specialist agents (workflow support)

| Agent | Purpose |
|-------|---------|
| `aggregator` | Merge Pattern C parallel outputs into a single artifact |
| `conflict-resolver` | Adjudicate aggregator merge failures (§12-7) |
| `critic-watchdog` | Real-time Iron Law enforcement during coding (§12-8) |
| `debugger` | Stall diagnostician at Cascade Level 1 (§11-7) |
| `advocate` / `critic` / `arbitrator` | Pattern B 95% consensus roles |

### General-purpose agents

| Agent | Purpose | When to Use |
|-------|---------|-------------|
| `executor` | Code implementation | Standard features, refactoring |
| `executor-low` | Simple fix / lookup | Small edits, single-file changes |
| `executor-high` | Complex refactoring | Large multi-file tasks |
| `architect` | Architecture & debug advice | Architectural decisions, Pattern D lead |
| `architect-low` | Quick analysis | Fast code questions |
| `explore` | File/code search | Finding files, patterns |
| `explore-medium` / `explore-high` | Deeper search | Complex architectural search |
| `tdd-guide` | TDD enforcement | New features, bug fixes |
| `qa-tester` | E2E testing | Critical user flows |
| `designer` | UI/frontend | Component and page work |
| `code-reviewer` | Code quality | After writing/modifying code |
| `security-reviewer` | Vulnerability detection | Before commits, sensitive code |
| `build-fixer` | Fix build/type errors | When build fails |
| `git-master` | Git operations | Commits, rebasing, history |
| `planner` | Strategic planning | Complex features |
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
    │       │   ├── plan.md                  ← feature goal, scope, acceptance criteria
    │       │   ├── <task-name>.md           ← human-readable task record
    │       │   └── <task-name>.state.json   ← v2.4.1 machine state
    │       ├── decisions.md                  ← architecture decisions
    │       └── artifacts/                    ← e2e video, screenshots, logs
    ├── archive/                              ← archived legacy features
    ├── state/                                ← global session state (auto-confirm queue, active_task)
    ├── wiki/                                 ← project knowledge base
    └── session/                              ← session logs (YYYY-MM-DD.md)
```

`task/*.md` are human-readable. `task/*.state.json` (v2.4.1 schema in `scripts/state-schema.mjs`) are machine-owned; prefer reading state.json over scanning markdown when a structured field is sufficient.

**Protocol:**
1. Session start → read `features/*/task/plan.md` + relevant `features/*/task/*.md` and `*.state.json`.
2. Before coding → verify task file and state.json exist at `features/<slug>/task/<task-name>.{md,state.json}`.
3. Task complete → update `features/<slug>/task/<task-name>.md` + `.state.json`.
4. New decision → append to `features/<slug>/decisions.md`.
5. Session end → append to `session/YYYY-MM-DD.md`.

## Completion Rules

Before marking ANY task complete:
- [ ] Unit tests written AND passing
- [ ] Integration tests passing (if applicable)
- [ ] E2E tests passing (if the selected tasks changed any interface: UI, CLI, API, hook, or script)
- [ ] Multi-Pass Verification: all 3 rounds passed for each review skill (§9-3)
- [ ] `features/<slug>/task/<task-name>.md` + `.state.json` updated
- [ ] No TypeScript errors (`tsc --noEmit`) scoped to changed surface
- [ ] `workflow-human-check` approved

**If ANY unchecked → CONTINUE WORKING.** (Iron Law #1)

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

**English-only source:** All code, comments, log messages, and documentation in English. Korean is permitted ONLY as data for input-pattern recognition (mode-classifier regex, keyword-detector patterns, RISK_KEYWORDS, magic_keyword keys).

## Testing Requirements

Minimum coverage: 80%

1. **Unit tests** — Individual functions, utilities, components
2. **Integration tests** — API endpoints, database operations
3. **E2E tests** — Test through the real interface (UI→Playwright, CLI→subprocess, API→real server, hook→stdin/stdout pipe)
4. **Multi-Pass Verification** — All 6 review skills run 3 rounds (omission / contradiction / edge case) before declaring pass (§9-3)

TDD workflow: write test first (RED) → minimal implementation (GREEN) → refactor → verify 80%+ coverage.

## Code Navigation (Serena MCP)

Smelter wires a Serena MCP server via `.mcp.json` (project scope) for LSP-based symbol navigation. **Prefer symbol-level tools over full-file `Read` when the target is a specific symbol.**

| Task | Use |
|------|-----|
| Locate function / class / method | `mcp__serena__find_symbol` |
| Pre-edit file outline | `mcp__serena__get_symbols_overview` |
| Cross-file callers / references | `mcp__serena__find_referencing_symbols` |
| Replace symbol body / insert around symbol | `mcp__serena__replace_symbol_body`, `mcp__serena__insert_after_symbol` |
| Broad full-file inspection | fall back to `Read` |

Token budget: symbol-level reads typically cut 70-95 % vs. whole-file `Read`. LSP cross-file resolution is semantically accurate (unlike Grep-based approximation).

Runtime: `uv` + `serena-agent` (Python 3.13). Setup: `brew install uv && uv tool install -p 3.13 serena-agent@latest --prerelease=allow && serena init`. MCP registered via `claude mcp add serena -s project -- serena start-mcp-server --context claude-code --project "$(pwd)"`.

## Documentation Sync

On every code update, also update `document/workflow.md` and `document/implementation.md` to reflect the change. Code and these two documents must stay in sync — no code-only commits.

## Git Workflow

Commit format: `<type>: <description>`. Types: feat, fix, refactor, docs, test, chore, perf, ci.

## Project Structure

```
src/             — Core TypeScript engine (types, engine, adapters, runners, rules)
bin/             — CLI entry point (smelter command)
agents/          — Specialized subagent definitions (incl. aggregator, conflict-resolver, critic-watchdog, debugger)
skills/          — workflow-* skills (13) + utility skills
modes/           — Mode definitions (5 JSON files)
commands/        — Slash command entry points (plan, simple-fix, fix, investigate, implement)
hooks/           — hooks.json trigger registration
scripts/         — Node.js hook scripts (state-schema, mode-classifier, route-on-fail, auto-confirm, critic-watchdog, stall-detector, verification-rounds, ...)
templates/       — Verification prompt templates + scaffolds
.mcp.json        — Project-scope MCP servers (Serena for symbol navigation)
.claudeignore    — Context auto-load suppression (sessions, backups, vendored dirs)
rules-lib/       — Language-specific coding rules
document/        — Workflow spec, implementation status, philosophy
```

## Visibility — Yellow Tags

Every hook prints a short ANSI-yellow bracketed tag to stderr so you can see what the harness is doing. Common tags:

| Tag | Source |
|-----|--------|
| `[Command: /<name>]` / `[Magic Keyword: <kw> → /<cmd>]` | keyword-detector / mode-classifier |
| `[Inject: <skill>]` | skill-injector |
| `[TDD Gate]` / `[Security Gate]` | pre-tool-enforcer |
| `[Post Verify]` | post-tool-verifier |
| `[Auto-Retry: <reason>]` | tool-retry |
| `[Auto-Confirm]` | auto-confirm |
| `[Run E2E]` | stop-e2e |
| `[Doc Sync Check]` | session-end |
| `[Session Start]` | session-start-smt |
| `[Permission]` | permission-handler |
| `[Pre-Compact]` | pre-compact |
| `[Agent Check]` | sub-agent review injection |
| `[Inject: rules-lib/<lang>]` | rule-injector |
| `[Stall Cascade: L<n>]` | stall-detector |
| `[Critic-Watchdog: rule <n>]` | critic-watchdog |
| `[Verify: round <n> <focus>]` | verification-rounds |

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
| `{project}/.smt/` | File-based memory (features/, wiki/, session/, state/) |
| `{project}/.smt/features/<slug>/task/` | Individual task files per feature (md + state.json) |
| `{project}/.smt/features/<slug>/decisions.md` | Architecture decisions per feature |
| `{project}/.smt/features/<slug>/artifacts/` | e2e video, screenshots, logs |
| `{project}/.smt/state/` | auto-confirm-queue, active_task pointer |
| `{project}/.smt/archive/` | Archived legacy features |
| `~/.smt/config.json` | Global `autoConfirm`, `subTaskerOnRisk` toggles |
| `~/.claude/homunculus/` | ECC instinct data |

## Cancel

- `/cancel [hard]` — hard stop
- `/queue <intent>` — finish current work then redirect
- Disable auto-confirm: set `autoConfirm: false` in `~/.smt/config.json`
