---
title: Guides
description: How-to guides for authoring workflows, commands, and configuring node features in Smelter.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 0
---

How-to guides for building and running AI coding workflows with Smelter.

## Workflow Authoring

- [Authoring Workflows](/guides/authoring-workflows/) — Create multi-step YAML workflows with DAG nodes, conditional branching, and parallel execution
- [Authoring Commands](/guides/authoring-commands/) — Write prompt templates that serve as building blocks for workflow nodes

## Node Types

- [Loop Nodes](/guides/loop-nodes/) — Iterative AI execution with completion conditions and deterministic exit checks
- [Approval Nodes](/guides/approval-nodes/) — Human review gates with optional AI rework on rejection
- [Script Nodes](/guides/script-nodes/) — TypeScript/JavaScript (bun) or Python (uv) as a deterministic DAG node, without AI

## Node Features (Claude only)

- [Per-Node Hooks](/guides/hooks/) — Attach Claude SDK hooks for tool control, context injection, and input modification
- [Per-Node MCP Servers](/guides/mcp-servers/) — Connect external tools (GitHub, Postgres, etc.) to individual nodes
- [Per-Node Skills](/guides/skills/) — Preload specialized knowledge into node agents

## Bundled Workflows

Smelter ships with ready-to-use workflows that cover common coding tasks. You do not need to write any YAML to use these -- just describe what you want and the router picks the right one.

| Workflow | What It Does |
|----------|-------------|
| `smelter-assist` | General Q&A, debugging, exploration -- the catch-all |
| `smelter-fix-github-issue` | Investigate, root cause, implement fix, validate, PR |
| `smelter-smart-pr-review` | Complexity-adaptive PR review |
| `smelter-comprehensive-pr-review` | Multi-agent PR review (5 parallel reviewers) |
| `smelter-feature-development` | Implement feature from plan, validate, create PR |
| `smelter-create-issue` | Investigate a problem and create a GitHub issue |
| `smelter-validate-pr` | Thorough PR validation testing |
| `smelter-resolve-conflicts` | Detect and resolve merge conflicts in PRs |
| `smelter-remotion-generate` | Generate or modify Remotion video compositions with AI |
| `smelter-interactive-prd` | Create a PRD through guided conversation |
| `smelter-piv-loop` | Guided Plan-Implement-Validate with human-in-the-loop |
| `smelter-adversarial-dev` | Build a complete application from scratch using adversarial development |

For the full list with descriptions, see the [Available Workflows table](/getting-started/overview/#available-workflows) in the Overview.

To customize any bundled workflow, copy it from `.smelter/workflows/defaults/` into your project's `.smelter/workflows/` and modify it -- same-named files override the defaults.

## Advanced

- [Global Workflows](/guides/global-workflows/) — User-level workflows that apply to every project
- [Remotion Video Generation](/guides/remotion-workflow/) — End-to-end video creation with skills and bash render nodes
