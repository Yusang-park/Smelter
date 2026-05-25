---
title: Quick Start
description: Run your first Smelter workflow in minutes.
category: getting-started
audience: [user]
sidebar:
  order: 2
---

## Prerequisites

1. [Install Smelter](/getting-started/installation/)
2. [Install Claude Code](/getting-started/ai-assistants/#claude-code) — Smelter orchestrates it but does not bundle it
3. Authenticate with Claude: run `claude /login` (uses your existing Claude Pro/Max subscription)
4. In compiled Smelter binaries, set `CLAUDE_BIN_PATH` (see [Binary path configuration](/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only))
5. Navigate to any git repository

## Run Your First Workflow

```bash
# List available workflows
smelter workflow list

# Ask Smelter to assist with your codebase
smelter workflow run assist "What does this codebase do?"

# Run a code review
smelter workflow run smart-pr-review
```

## What's Next?

For the full getting started guide -- installation, authentication, Web UI setup, CLI setup, and troubleshooting -- see the [Overview](/getting-started/overview/).

- [Overview](/getting-started/overview/) — Complete onboarding guide
- [Core Concepts](/getting-started/concepts/) — Understand workflows, nodes, commands, and isolation
- [Configuration](/getting-started/configuration/) — Customize Smelter for your project
- [Authoring Workflows](/guides/authoring-workflows/) — Create your own workflows
- [GitHub Repository](https://github.com/Yusang-park/Smelter) — Source code, issues, and discussions
