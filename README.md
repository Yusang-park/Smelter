<p align="center">
  <img src="assets/smelter-logo.svg" alt="Smelter" width="600" />
</p>

<p align="center">
  <strong>TDD-first, file-based, multi-agent AI development harness for Claude Code</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#commands">Commands</a> &middot;
  <a href="#workflow-engine">Workflow Engine</a> &middot;
  <a href="#hooks">Hooks</a> &middot;
  <a href="#file-based-memory">File-Based Memory</a> &middot;
  <a href="#codex-bridge">Codex Bridge</a>
</p>

---

## Why Smelter?

Claude Code is powerful. But without guardrails, agents skip tests, forget plans, lose context across sessions, and ship untested code.

**Smelter fixes this.** It wraps Claude Code in a 10-step workflow engine that enforces TDD, manages state in files (not memory), and routes work through specialized review agents before anything ships.

| Problem | Smelter's Answer |
|---------|------------------|
| Agent skips tests | Fail-closed TDD gate at Step 4 -- won't advance without RED tests |
| Plans evaporate between sessions | `.smt/features/<slug>/` persists plans, tasks, decisions on disk |
| No review before shipping | 3-agent consensus review (advocate/critic/arbitrator) at Step 9 |
| Agent scope-creeps | Step engine injects ONE step at a time; extras become new `/tasker` tasks |
| No E2E validation | Step 8 forces real-interface E2E (Playwright, subprocess, real server) |
| Context lost on compact | `pre-compact.mjs` preserves critical state before context window shrinks |

## Quick Start

```bash
git clone https://github.com/your-org/smelter.git
cd smelter
npm install && npm run build
```

Initialize a project:

```bash
npx tsx bin/cli.ts init
```

This creates `.smt/` with `features/`, `wiki/`, and `session/` directories.

## Commands

Three commands. That's it.

| Command | What it does | Steps |
|---------|-------------|-------|
| `/tasker` | Plan. Turn ideas into executable `.smt/` task files. | 1-3 |
| `/feat` | Build. Full 10-step TDD workflow on a feature. | 1-10 |
| `/qa` | Fix. Bug fixes and small edits with TDD exemptions. | 4-8, 10 |

### Natural Language Works Too

You don't need to memorize slash commands. Just talk naturally -- Smelter uses a **Haiku sub-agent classifier** to understand your intent and route it to the right command:

```
"새 기능 추가해줘"          --> /feat
"fix the login bug"       --> /qa
"plan the onboarding"     --> /tasker
"extend the auth flow"    --> /feat (skips Step 2)
"스타일 수정"               --> /qa (TDD exempt)
```

This isn't regex pattern matching. A Claude Haiku instance reads your prompt, classifies its intent (`command` vs `question`), and maps it to the correct workflow -- including branch hints like `extend` (skip learning phase) or `style` (TDD exemption). Any language Haiku understands works.

### Mode Indicators

Every command switch prints a yellow mode tag so you always know what's active:

```
[FEAT MODE]     [Command: /feat]
[QA MODE]       [Command: /qa]
[TASKER MODE]   [Command: /tasker]
```

## Workflow Engine

The heart of Smelter. A YAML-defined step DAG that guides every feature from recognition to human review.

```
Step 1: Problem Recognition     -- What are we solving?
Step 2: Pre Review (Learning)   -- 2-4 approaches, 95% consensus
Step 3: Planning                -- Executable checkbox tree
   |
   v  [USER INTERVIEW GATE -- pauses for approval]
   |
Step 4: TDD (Test Design)      -- Write tests FIRST. Must fail (RED).
Step 5: Implementation          -- Minimal code to pass (GREEN).
Step 6: Local Agent Review      -- code-reviewer + security-reviewer
Step 7: Utility Test            -- Scoped unit/integration tests
Step 8: E2E Validation          -- Real interface, real artifacts
Step 9: Team Code Review        -- 3-agent consensus (95% threshold)
Step 10: Human Review           -- You decide: ship, rework, or hold
```

### Fail-Closed Gates

Steps 4-9 have **gates** that require explicit signals to advance:

```
tests_exist_and_red        -- Step 4: tests exist AND fail
tests_green                -- Step 5: tests pass after implementation
review_clean               -- Step 6: no CRITICAL/HIGH findings
tests_pass_and_build_clean -- Step 7: scoped suite + tsc clean
e2e_pass                   -- Step 8: E2E artifacts saved
team_review_clean          -- Step 9: 95% consensus reached
```

**No signal = no advance.** The engine waits. This is how Smelter prevents agents from skipping steps.

### Rollback on Failure

Gates don't just block -- they route you back to the right step:

| Failure | Routes to |
|---------|-----------|
| Tests won't pass after 3 retries | Step 2 (approach is wrong) |
| Code review finds plan mismatch | Step 3 (replan) |
| Code review finds bug | Step 5 (fix implementation) |
| Team review: CRITICAL/HIGH | Step 3 (significant rework) |
| Team review: MEDIUM | Step 5 (implementation fix) |
| Team review: LOW | Continue (log as known limitation) |

### YAML Workflow Definitions

Workflows are data, not code:

```yaml
# workflows/feat.yaml
steps:
  step-4:
    name: Test Design (TDD)
    prompt: steps/step-4-tdd.md
    gate: tests_exist_and_red
    exempt_if: [css, i18n, typo, dialogue]
    next: step-5

  step-5:
    name: Implementation
    gate: tests_green
    max_retry: 3
    on_max_retry: step-2
    next: step-6
```

Add a workflow by adding a YAML file. No code changes needed.

## Hooks

Every hook fires at the right moment, prints a yellow tag, and stays out of your way.

| Event | Hooks | Tags |
|-------|-------|------|
| **SessionStart** | session-start-smt | `[Session Start]` |
| **UserPromptSubmit** | keyword-detector, auto-confirm-consumer, skill-injector, step-injector | `[Keyword Detector]` `[Step: step-N]` |
| **PreToolUse** | pre-tool-enforcer, rule-injector | `[Pre Tool Enforcer]` `[Rule Injector]` |
| **PostToolUse** | post-tool-verifier, tool-retry, step-tracker | `[Step Tracker]` `[Step: N -> N+1]` |
| **Stop** | auto-confirm, stop-e2e | `[Auto-Confirm]` `[Run E2E]` |
| **PreCompact** | pre-compact | `[Pre-Compact]` |
| **SessionEnd** | session-end | `[Doc Sync Check]` |

### Auto-Confirm (Context-Aware Continuation)

When the agent ends a turn while tasks remain, Smelter doesn't just inject a blind "continue." Instead:

1. The **Stop hook** captures the agent's last assistant message and the pending task list
2. It drops this payload into `.smt/state/queue-<session>.json`
3. On the next prompt, the **consumer hook** injects the full context (last message + task list) as `additionalContext`
4. The main agent (Sonnet/Opus) **reads the forwarded context** and decides the next concrete action based on where it left off

This means the agent resumes with full awareness of what it was doing -- not a generic "keep going" instruction.

```
[Auto-Confirm] 3 pending task(s) in .smt/. Continue working.
```

Disable with `~/.smt/config.json`:

```json
{ "autoConfirm": false }
```

### Auto-Retry

Transient tool errors (ripgrep timeout, file-modified-since-read) are retried automatically up to 3 times:

```
[Auto-Retry: rg timeout -> retry 1/3]
```

## File-Based Memory

**Agents do not memorize. Agents read files.**

```
.smt/
├── features/
│   └── <feature-slug>/
│       ├── task/
│       │   ├── plan.md            <-- goal, scope, acceptance criteria
│       │   └── <task-name>.md     <-- individual task (atomic)
│       ├── decisions.md           <-- architecture decisions
│       ├── state/
│       │   └── workflow.json      <-- engine state (step, signals, version)
│       └── artifacts/             <-- E2E videos, screenshots, logs
├── wiki/                          <-- project knowledge base
└── session/                       <-- daily session logs
```

Every session reads from disk. Every decision writes to disk. Nothing lives in context alone.

## Codex Bridge

Smelter includes an **OAuth-based Codex bridge** that lets Claude Code route model calls through OpenAI's Codex CLI:

- **Wrapper**: `scripts/claude-wrapper.mjs` -- drop-in replacement for `claude` that proxies through Codex
- **Proxy**: `scripts/codex-proxy.mjs` -- local OAuth proxy on `127.0.0.1:3099`

```bash
# Use Codex as the backend for a single run
node scripts/claude-wrapper.mjs --codex "your prompt here"

# Or alias it permanently
alias claude="node /path/to/smelter/scripts/claude-wrapper.mjs --codex"
```

Requires `~/.codex/auth.json` with a valid OAuth token. Pass `--claude` to bypass Codex and use the default Claude backend.

## Agents

Smelter ships 22 specialized agents:

| Agent | Model | Use |
|-------|-------|-----|
| `executor` | sonnet | Standard implementation |
| `executor-high` | opus | Complex multi-file refactors |
| `architect` | opus | Architecture and debug advice |
| `tdd-guide` | sonnet | TDD enforcement |
| `code-reviewer` | sonnet | Code quality review |
| `security-reviewer` | sonnet | Vulnerability detection |
| `build-fixer` | sonnet | Fix build/type errors |
| `qa-tester` | sonnet | E2E testing |
| `designer` | sonnet | UI/frontend work |
| `planner` | opus | Strategic planning |
| `critic` | opus | Plan review |
| `deep-executor` | opus | Complex autonomous tasks |

Use them proactively: complex feature -> **planner** then **executor**; just wrote code -> **code-reviewer**; bug fix -> **tdd-guide**; build failed -> **build-fixer**.

## Project Structure

```
src/             -- TypeScript engine (types, store, workflow-engine, adapters)
bin/             -- CLI entry point
commands/        -- Slash command definitions (feat.md, qa.md, tasker.md)
workflows/       -- YAML step DAG definitions
steps/           -- Per-step prompt files (20-40 lines each)
scripts/         -- Hook scripts (keyword-detector, auto-confirm, step-injector, ...)
agents/          -- Specialized subagent definitions
skills/          -- Reusable workflow skills
presets/         -- Execution preset configs
hooks/           -- Plugin hook wiring (hooks.json)
rules-lib/       -- Language-specific coding rules
```

## Requirements

- Node.js >= 20.0.0
- Claude Code installed and authenticated

## License

Private
