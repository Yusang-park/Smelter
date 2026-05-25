<p align="center">
  <img src="assets/logo.png" alt="Smelter" width="160" />
</p>

<h1 align="center">Smelter</h1>

<p align="center">
  The first open-source harness builder for AI coding. Make AI coding deterministic and repeatable.
</p>

<p align="center">
  Forked by Archon.
</p>

<p align="center">
  <a href="https://github.com/Yusang-park/Smelter" target="_blank"><img src="https://img.shields.io/github/stars/Yusang-park/Smelter?style=social" alt="Yusang-park/Smelter" /></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/Yusang-park/Smelter/actions/workflows/test.yml"><img src="https://github.com/Yusang-park/Smelter/actions/workflows/test.yml/badge.svg" alt="CI" /></a>
  <a href="https://yusang-park.github.io/Smelter"><img src="https://img.shields.io/badge/docs-Smelter-blue" alt="Docs" /></a>
</p>

---

Smelter is a workflow engine for AI coding agents. Define your development processes as YAML workflows - planning, implementation, validation, code review, PR creation - and run them reliably across all your projects.

Like what Dockerfiles did for infrastructure and GitHub Actions did for CI/CD - Smelter does for AI coding workflows. Think n8n, but for software development.

## Why Smelter?

When you ask an AI agent to "fix this bug", what happens depends on the model's mood. It might skip planning. It might forget to run tests. It might write a PR description that ignores your template. Every run is different.

Smelter fixes this. Encode your development process as a workflow. The workflow defines the phases, validation gates, and artifacts. The AI fills in the intelligence at each step, but the structure is deterministic and owned by you.

- **Repeatable** - Same workflow, same sequence, every time. Plan, implement, validate, review, PR.
- **Isolated** - Every workflow run gets its own git worktree. Run 5 fixes in parallel with no conflicts.
- **Fire and forget** - Kick off a workflow, go do other work. Come back to a finished PR with review comments.
- **Composable** - Mix deterministic nodes (bash scripts, tests, git ops) with AI nodes (planning, code generation, review). The AI only runs where it adds value.
- **Portable** - Define workflows once in `.archon/workflows/`, commit them to your repo. They work the same from CLI, Web UI, Slack, Telegram, or GitHub.

## What It Looks Like

Here's an example of a Smelter workflow that plans, implements in a loop until tests pass, gets your approval, then creates the PR:

```yaml
# .archon/workflows/build-feature.yaml
nodes:
  - id: plan
    prompt: "Explore the codebase and create an implementation plan"

  - id: implement
    depends_on: [plan]
    loop:                                      # AI loop - iterate until done
      prompt: "Read the plan. Implement the next task. Run validation."
      until: ALL_TASKS_COMPLETE
      fresh_context: true                      # Fresh session each iteration

  - id: run-tests
    depends_on: [implement]
    bash: "bun run validate"                   # Deterministic - no AI

  - id: review
    depends_on: [run-tests]
    prompt: "Review all changes against the plan. Fix any issues."

  - id: approve
    depends_on: [review]
    loop:                                      # Human approval gate
      prompt: "Present the changes for review. Address any feedback."
      until: APPROVED
      interactive: true                        # Pauses and waits for human input

  - id: create-pr
    depends_on: [approve]
    prompt: "Push changes and create a pull request"
```

Tell your coding agent what you want, and Smelter handles the rest:

```
You: Use smelter to add dark mode to the settings page

Agent: I'll run the smelter-implement workflow for this.
       → Creating isolated worktree on branch smelter/task-dark-mode...
       → Planning...
       → Implementing (task 1/4)...
       → Implementing (task 2/4)...
       → Tests failing - iterating...
       → Tests passing after 2 iterations
       → Code review complete - 0 issues
       → PR ready: https://github.com/you/project/pull/47
```

## Getting Started

> **Most users should start with the [Full Setup](#full-setup-5-minutes)** - it walks you through credentials, installs the Smelter skill into your projects, and gives you the web dashboard.
>
> **Already have Claude Code and just want the CLI?** Jump to the [Quick Install](#quick-install-30-seconds).

### Full Setup (5 minutes)

Clone the repo and use the guided setup wizard. This configures credentials, platform integrations, and copies the Smelter skill into your target projects.

<details>
<summary><b>Prerequisites</b> - Bun, Claude Code, and the GitHub CLI</summary>

**Bun** - [bun.sh](https://bun.sh)

```bash
# macOS/Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
irm bun.sh/install.ps1 | iex
```

**GitHub CLI** - [cli.github.com](https://cli.github.com/)

```bash
# macOS
brew install gh

# Windows (via winget)
winget install GitHub.cli

# Linux (Debian/Ubuntu)
sudo apt install gh
```

**Claude Code** - [claude.ai/code](https://claude.ai/code)

```bash
# macOS/Linux/WSL
curl -fsSL https://claude.ai/install.sh | bash

# Windows (PowerShell)
irm https://claude.ai/install.ps1 | iex
```

</details>

```bash
git clone https://github.com/Yusang-park/Smelter
cd Smelter
bun install
claude
```

Then say: **"Set up Smelter"**

The setup wizard walks you through everything: CLI installation, authentication, platform selection, and copies the Smelter skill to your target repo.

### Quick Install (30 seconds)

Already have Claude Code set up? Install the standalone CLI binary and skip the wizard.

**macOS / Linux**
```bash
curl -fsSL https://raw.githubusercontent.com/Yusang-park/Smelter/main/scripts/install.sh | bash
```

**Windows (PowerShell)**
```powershell
irm https://raw.githubusercontent.com/Yusang-park/Smelter/main/scripts/install.ps1 | iex
```

**Homebrew**
```bash
brew install Yusang-park/smelter/smelter
```

> **Compiled binaries need a `CLAUDE_BIN_PATH`.** The quick-install binaries
> don't bundle Claude Code. Install it separately, then point Smelter at it:
>
> ```bash
> # macOS / Linux / WSL
> curl -fsSL https://claude.ai/install.sh | bash
> export CLAUDE_BIN_PATH="$HOME/.local/bin/claude"
>
> # Windows (PowerShell)
> irm https://claude.ai/install.ps1 | iex
> $env:CLAUDE_BIN_PATH = "$env:USERPROFILE\.local\bin\claude.exe"
> ```
>
> Or set `assistants.claude.claudeBinaryPath` in `~/.archon/config.yaml`.
> The Docker image ships Claude Code pre-installed. See the docs site for binary path configuration details.

### Start Using Smelter

Once you've completed either setup path, go to your project and start working:

```bash
cd /path/to/your/project
claude
```

```
Use smelter to fix issue #42
```

```
What smelter workflows do I have? When would I use each one?
```

The coding agent handles workflow selection, branch naming, and worktree isolation for you. Projects are registered automatically the first time they're used.

> **Important:** Always run Claude Code from your target repo, not from the Smelter repo. The setup wizard copies the Smelter skill into your project so it works from there.

## Web UI

Smelter includes a web dashboard for chatting with your coding agent, running workflows, and monitoring activity. Binary installs: run `smelter serve` to download and start the web UI in one step. From source: ask your coding agent to run the frontend from the Smelter repo, or run `bun run dev` from the repo root yourself.

Register a project by clicking **+** next to "Project" in the chat sidebar - enter a GitHub URL or local path. Then start a conversation, invoke workflows, and watch progress in real time.

**Key pages:**
- **Chat** - Conversation interface with real-time streaming and tool call visualization
- **Dashboard** - Mission Control for monitoring running workflows, with filterable history by project, status, and date
- **Workflow Builder** - Visual drag-and-drop editor for creating DAG workflows with loop nodes
- **Workflow Execution** - Step-by-step progress view for any running or completed workflow

**Monitoring hub:** The sidebar shows conversations from **all platforms** - not just the web. Workflows kicked off from the CLI, messages from Slack or Telegram, GitHub issue interactions - everything appears in one place.

See the docs site for full Web UI documentation.

## What Can You Automate?

Smelter ships with workflows for common development tasks:

| Workflow | What it does |
|----------|-------------|
| `smelter-explore` | Read-only repository exploration and architecture/question answering |
| `smelter-brainstorm` | Product/design brainstorming without source-code changes |
| `smelter-implement` | Feature implementation with investigation, plan, TDD, reviews, E2E, and human check |
| `smelter-fix` | Systematic debugging, root-cause evidence, RED regression test, fix, and validation |
| `smelter-verify` | Non-mutating verification with static checks, tests, E2E evidence, and human check |
| `smelter-infra` | Infrastructure inventory, reviewed plan, approved execution, verification, and human check |
| `smelter-queue` | Queue a follow-up intent for the active Smelter runtime |

Smelter ships default workflows - run `smelter workflow list` or describe what you want and the router picks the right one.

**Or define your own.** Default workflows are great starting points - copy one from `.archon/workflows/defaults/` and customize it. Workflows are YAML files in `.archon/workflows/`, commands are markdown files in `.archon/commands/`. Same-named files in your repo override the bundled defaults. Commit them - your whole team runs the same process.

See the docs site for authoring workflows and commands.

## Add a Platform

The Web UI and CLI work out of the box. Optionally connect a chat platform for remote access:

| Platform | Setup time | Guide |
|----------|-----------|-------|
| **Telegram** | 5 min | Docs site |
| **Slack** | 15 min | Docs site |
| **GitHub Webhooks** | 15 min | Docs site |
| **Discord** | 5 min | Docs site |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Platform Adapters (Web UI, CLI, Telegram, Slack,       │
│                    Discord, GitHub)                     │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                     Orchestrator                        │
│          (Message Routing & Context Management)         │
└─────────────┬───────────────────────────┬───────────────┘
              │                           │
      ┌───────┴────────┐          ┌───────┴────────┐
      │                │          │                │
      ▼                ▼          ▼                ▼
┌───────────┐  ┌────────────┐  ┌──────────────────────────┐
│  Command  │  │  Workflow  │  │    AI Assistant Clients  │
│  Handler  │  │  Executor  │  │   (Claude / Codex / Pi)  │
│  (Slash)  │  │  (YAML)    │  │                          │
└───────────┘  └────────────┘  └──────────────────────────┘
      │              │                      │
      └──────────────┴──────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│              SQLite / PostgreSQL (7 Tables)             │
│   Codebases • Conversations • Sessions • Workflow Runs  │
│    Isolation Environments • Messages • Workflow Events  │
└─────────────────────────────────────────────────────────┘
```

## Documentation

Full documentation is available in `packages/docs-web/` and the published Smelter docs site.

| Topic | Description |
|-------|-------------|
| Getting Started | Setup guide (Web UI or CLI) |
| The Book of Smelter | Narrative tutorial |
| CLI Reference | Full CLI reference |
| Authoring Workflows | Create custom YAML workflows |
| Authoring Commands | Create reusable AI commands |
| Configuration | All config options, env vars, YAML settings |
| AI Assistants | Claude, Codex, and Pi setup details |
| Deployment | Docker, VPS, production setup |
| Architecture | System design and internals |
| Troubleshooting | Common issues and fixes |

## Telemetry

Smelter sends a single anonymous event — `workflow_invoked` — each time a workflow starts, so maintainers can see which workflows get real usage and prioritize accordingly. **No PII, ever.**

**What's collected:** the workflow name, the workflow description (both authored by you in YAML), the platform that triggered it (`cli`, `web`, `slack`, etc.), the Smelter version, and a random install UUID stored at `~/.archon/telemetry-id`. Nothing else.

**What's *not* collected:** your code, prompts, messages, git remotes, file paths, usernames, tokens, AI output, workflow node details — none of it.

**Opt out:** set any of these in your environment:

```bash
ARCHON_TELEMETRY_DISABLED=1
DO_NOT_TRACK=1        # de facto standard honored by Astro, Bun, Prisma, Nuxt, etc.
```

Self-host PostHog or use a different project by setting `POSTHOG_API_KEY` and `POSTHOG_HOST`.

## Contributing

Contributions welcome! See the open [issues](https://github.com/Yusang-park/Smelter/issues) for things to work on.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=Yusang-park/Smelter&type=date&legend=top-left)](https://www.star-history.com/?repos=Yusang-park%2FSmelter&type=date&legend=top-left)

## License

[MIT](LICENSE)
