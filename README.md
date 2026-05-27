# Smelter

<p align="center">
  <img src="assets/smelter-3d.png" alt="3D smelter furnace" width="520" />
</p>

<p align="center">
  A custom flow engine for running Claude- and Codex-based AI coding workflows as plugins.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/Yusang-park/Smelter/actions/workflows/test.yml"><img src="https://github.com/Yusang-park/Smelter/actions/workflows/test.yml/badge.svg" alt="CI" /></a>
  <a href="https://yusang-park.github.io/Smelter"><img src="https://img.shields.io/badge/docs-Smelter-blue" alt="Docs" /></a>
</p>

---

Smelter turns AI coding work into explicit custom flows. Planning,
implementation, validation, review, and PR preparation can be defined as YAML
workflows and reusable command plugins, then executed through Claude or Codex
providers.

The project is intentionally centered on executable developer workflows rather
than external connector sprawl. Smelter combines workflows, commands,
providers, isolated worktrees, and execution state so the same development
process can run the same way across projects.

## Core Direction

- **Custom flow first**: define development procedures in `.smelter/workflows/`.
- **Plugin-shaped extension**: add or override workflows and commands per repo.
- **Claude/Codex providers**: run agent work through Claude and Codex provider
  implementations.
- **Deterministic execution**: separate AI steps from deterministic shell,
  validation, and git steps.
- **Isolated worktrees**: run each workflow in its own git worktree.
- **Human gates**: model approvals, reviews, and feedback loops as workflow
  steps.

## Custom Flow Example

```yaml
# .smelter/workflows/build-feature.yaml
name: build-feature
description: Plan, implement, validate, review, and prepare a PR

nodes:
  - id: plan
    prompt: "Explore the codebase and create an implementation plan"

  - id: implement
    depends_on: [plan]
    loop:
      prompt: "Read the plan. Implement the next task. Run validation."
      until: ALL_TASKS_COMPLETE
      fresh_context: true

  - id: run-tests
    depends_on: [implement]
    bash: "bun run validate"

  - id: review
    depends_on: [run-tests]
    prompt: "Review all changes against the plan. Fix any issues."

  - id: approve
    depends_on: [review]
    loop:
      prompt: "Present the changes for review. Address any feedback."
      until: APPROVED
      interactive: true

  - id: create-pr
    depends_on: [approve]
    prompt: "Push changes and create a pull request"
```

This workflow behaves like a repo-local plugin. A project can add a workflow or
command with the same name as a bundled default to override the default behavior
without changing Smelter itself.

## Plugin Model

Smelter treats two file types as plugin-like extension points:

| Type | Path | Role |
| --- | --- | --- |
| Workflow | `.smelter/workflows/*.yaml` | Defines execution order, loops, gates, and validation. |
| Command | `.smelter/commands/*.md` | Defines reusable prompt/action units for the agent. |

Bundled workflows and commands provide defaults. Repo-local files take
precedence, which lets teams maintain custom implementation, review, migration,
debugging, and validation flows as versioned project assets.

## Claude And Codex Execution

Smelter runs coding assistants through a provider layer:

- `packages/providers/src/claude`: Claude-based execution
- `packages/providers/src/codex`: Codex-based execution
- `packages/workflows`: workflow schema, parser, and bundled defaults
- `packages/core`: orchestrator, command handling, and workflow execution state
- `packages/git`: worktree isolation and branch operations
- `packages/cli`: local command interface
- `packages/web`: workflow browsing and execution UI

The normal way to customize behavior is to add workflow and command plugins, not
to modify provider code.

## Running Smelter

Install from source:

```bash
git clone https://github.com/Yusang-park/Smelter
cd Smelter
bun install
```

Run the CLI during development:

```bash
bun run smelter workflow list
bun run smelter workflow run smelter-implement "Add dark mode to settings"
```

Use Smelter from a target project:

```bash
cd /path/to/your/project
smelter workflow list
smelter workflow run smelter-fix "Fix issue #42"
```

Start the web UI in development:

```bash
bun run dev
```

## Default Workflows

Smelter ships default workflows for common development tasks:

| Workflow | Purpose |
| --- | --- |
| `smelter-explore` | Explore repository structure and implementation without changing code. |
| `smelter-brainstorm` | Brainstorm product or design options without source changes. |
| `smelter-implement` | Run feature work through planning, implementation, validation, and review. |
| `smelter-fix` | Reproduce a bug, add regression coverage, fix it, and validate the result. |
| `smelter-verify` | Collect static check, test, and E2E evidence without mutating code. |
| `smelter-infra` | Handle infrastructure changes through inventory, planning, approval, execution, and verification. |
| `smelter-queue` | Queue a follow-up intent for the active Smelter runtime. |

## Architecture

```text
┌─────────────────────────────────────────────────────────┐
│                 Custom Flow Entry Points                │
│                    CLI • Web UI • API                   │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                     Orchestrator                        │
│          Context Management • Execution State           │
└─────────────┬───────────────────────────┬───────────────┘
              │                           │
              ▼                           ▼
┌──────────────────────────┐   ┌──────────────────────────┐
│   Workflow / Command     │   │      Provider Layer      │
│   Plugins                │   │      Claude • Codex      │
│   YAML • Markdown        │   │                          │
└─────────────┬────────────┘   └─────────────┬────────────┘
              │                              │
              └──────────────┬───────────────┘
                             ▼
┌─────────────────────────────────────────────────────────┐
│              Isolation • Git • Persistence              │
│      Worktrees • Branches • Messages • Workflow Runs    │
└─────────────────────────────────────────────────────────┘
```

## Development

Common commands:

```bash
bun install
bun run typecheck
bun run lint
bun test
```

The documentation site lives in `packages/docs-web/`. Workflow and command
authoring code lives in `packages/workflows/`, orchestration lives in
`packages/core/`, and assistant integration lives in `packages/providers/`.

## Telemetry

Smelter may record anonymous workflow start events to understand which workflows
are used. It does not collect code, prompts, messages, git remotes, file paths,
usernames, tokens, or AI output.

Disable telemetry with:

```bash
ARCHON_TELEMETRY_DISABLED=1
DO_NOT_TRACK=1
```

## License

[MIT](LICENSE)
