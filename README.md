<p align="center">
  <img src="assets/smelter-logo.svg" alt="Smelter" width="600" />
</p>

<p align="center">
  <strong>TDD-first, file-based, multi-agent AI development harness for Claude Code</strong>
</p>

<p align="center">
  <a href="#features-at-a-glance">Features</a> &middot;
  <a href="#workflow-engine">Workflow</a> &middot;
  <a href="#how-it-works">How It Works</a> &middot;
  <a href="#why-smelter">Philosophy</a> &middot;
  <a href="#quick-start">Quick Start</a>
</p>

---

## Features at a Glance

| | Feature | What it does |
|---|---------|-------------|
| 1 | **10-Step Workflow Engine** | Enforces TDD, E2E testing, and multi-agent review at every stage. No skipping steps. |
| 2 | **Auto-Confirm (Intelligent)** | Agent reads its own last message + pending tasks, then decides the next action. Not a blind "continue." |
| 3 | **File-Based Context Survival** | Plans, tasks, and decisions persist on disk. Context compaction and session restarts don't lose state. |
| 4 | **Project-Scoped Memory** | Every feature gets its own directory with plans, tasks, and decisions. Agents stay focused; nothing falls through the cracks. |
| 5 | **Triple Verification** | Local agent review + team consensus review (95%) + human sign-off. Three layers before anything ships. |
| 6 | **Cross-Agent Testing** | Dedicated `tdd-guide`, `code-reviewer`, and `security-reviewer` agents verify independently. Each has a single job. |
| 7 | **3 Commands + Auto-Routing** | `/feat`, `/qa`, `/tasker` -- or just talk naturally. A Haiku classifier routes your intent. No commands to memorize. |
| 8 | **Independent Sub-Agents** | Each task runs in its own agent with fresh context. No cross-contamination between tasks. |
| 9 | **Never Stops** | Auto-confirm keeps the agent working while tasks remain. Auto-retry handles transient errors (up to 3x). Zero babysitting. |
| 10 | **Codex Bridge** | Hit your Claude token limit? Switch to OpenAI Codex via OAuth proxy with one flag. `--codex` |

### The 10-Step Workflow

| Step | Name | Gate |
|------|------|------|
| 1 | Problem Recognition | Task file created |
| 2 | Pre Review (Learning) | 95% consensus on approach |
| 3 | Planning | Executable checkbox tree |
| -- | **User Interview** | **You approve before implementation begins** |
| 4 | TDD (Test Design) | Tests exist AND fail (RED) |
| 5 | Implementation | Tests pass (GREEN) |
| 6 | Local Agent Review | No CRITICAL/HIGH findings |
| 7 | Scoped Test | Suite pass + typecheck clean |
| 8 | E2E Validation | Artifacts saved, assertions pass |
| 9 | Team Code Review | 3-agent consensus (95%) |
| 10 | Human Review | You decide: ship, rework, or hold |

### Three Commands

| Command | What it does | Steps |
|---------|-------------|-------|
| `/feat` | Full feature development with TDD | 1-10 |
| `/qa` | Bug fix / small edit (TDD exemptions available) | 4-8, 10 |
| `/tasker` | Turn ideas into executable task files | 1-3 |

Or just talk: *"add dark mode"* -> `/feat` *"fix the login bug"* -> `/qa` *"plan the onboarding"* -> `/tasker`. A Haiku sub-agent classifies your intent and routes automatically.

---

## Why Smelter?

Real developers don't just write code. They receive tasks, study the problem, design a plan, write tests, implement, get reviews, verify, and present to a human. **Smelter automates this entire human workflow** -- not just the coding part.

### 1. The Human Workflow, Automated

```
PM assigns task -> Study -> Design -> TDD -> Implement -> Verify -> Human Review -> Iterate
```

Smelter encodes this as a 10-step engine. Every feature goes through the same disciplined process a senior engineering team would follow -- planning, test-first development, multi-agent review, and human sign-off.

### 2. Agents Don't Memorize. Agents Read Files.

LLMs lose everything when the session ends. Smelter solves this with **file-based state** -- plans, tasks, decisions, and progress all live on disk. Goals are pinned to files, task state is tracked explicitly, and contradictions discovered mid-work are reflected back into the documents.

### 3. Fixed-Role Agents, Not One Agent Doing Everything

| Agent | Owns | Does NOT do |
|-------|------|-------------|
| `planner` | Planning state, scope, task breakdown | Implementation, final verification |
| `executor` | Code changes for assigned tasks | Replanning, architecture decisions |
| `architect` | Architecture review, debug analysis | Implementation, plan creation |
| `tdd-guide` | Test-first discipline, test strategy | Feature ownership, final approval |
| `code-reviewer` | Quality/security/maintainability review | Implementation, scope expansion |

### 4. Triple Verification -- Smelter Refines, Not Just Executes

The name "Smelter" is intentional. Raw ore goes in, refined metal comes out:

- **Step 6**: Local agent review -- quality, gaps, edge cases caught immediately
- **Step 9**: Team code review -- multi-perspective final review (95% consensus required)
- **Step 10**: Human review -- you decide with evidence (test output, build logs, E2E artifacts)

---

## How It Works

### Workflow Engine: YAML-Defined Step DAG

Workflows are defined as YAML files, not hardcoded logic. Each step declares its prompt, gate condition, retry budget, and failure routing:

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
    on_max_retry: step-2       # 3 failures = approach is wrong
    next: step-6
```

Two hooks drive the engine:
- **`step-injector`** (UserPromptSubmit) -- reads `workflow.json`, loads the current step's prompt, injects it as context
- **`step-tracker`** (PostToolUse) -- evaluates gate signals, advances or rolls back the workflow

Adding a new workflow = adding a YAML file. No code changes.

### Fail-Closed Gates

Steps 4-9 have gates that **require explicit signals** to advance. No signal = no advance. The engine waits.

When a gate fails, it doesn't just block -- it routes back to the right step:

| Failure | Routes to |
|---------|-----------|
| Tests won't pass after 3 retries | Step 2 (approach is wrong) |
| Code review finds plan mismatch | Step 3 (replan) |
| Code review finds bug | Step 5 (fix implementation) |
| Team review: CRITICAL/HIGH | Step 3 (significant rework) |
| Team review: LOW | Continue (log as known limitation) |

### Auto-Confirm: Context-Aware, Not Blind

When the agent ends a turn while tasks remain:

1. **Stop hook** captures the agent's last message + pending task list
2. Payload is queued to disk (session-scoped, atomic write)
3. On next prompt, **consumer hook** injects the full forwarded context
4. The main agent (Sonnet/Opus) **reads what it was doing** and decides the next concrete action

This is not "continue working." The agent sees its own prior reasoning and the exact task state. It resumes intelligently.

### File-Based Memory

```
.smt/
├── features/
│   └── <feature-slug>/
│       ├── task/
│       │   ├── plan.md            -- goal, scope, acceptance criteria
│       │   └── <task-name>.md     -- individual task (atomic)
│       ├── decisions.md           -- architecture decisions
│       ├── state/
│       │   └── workflow.json      -- engine state (step, signals, version)
│       └── artifacts/             -- E2E videos, screenshots, logs
├── wiki/                          -- project knowledge base
└── session/                       -- daily session logs
```

Every session reads from disk. Every decision writes to disk. Nothing lives in context alone.

### Codex Bridge

Hit your Claude Code token limit? Switch to OpenAI Codex without changing your workflow:

```bash
node scripts/claude-wrapper.mjs --codex "your prompt here"
```

OAuth-based proxy on `127.0.0.1:3099`. Requires `~/.codex/auth.json`. Pass `--claude` to switch back.

---

## Quick Start

```bash
git clone https://github.com/your-org/smelter.git
cd smelter
npm install && npm run build
npx tsx bin/cli.ts init
```

This creates `.smt/` with `features/`, `wiki/`, and `session/` directories. Start working:

```
/feat "add dark mode toggle"
/qa "fix login error message"
/tasker "plan the new onboarding flow"
```

## Requirements

- Node.js >= 20.0.0
- Claude Code installed and authenticated

## License

Private
