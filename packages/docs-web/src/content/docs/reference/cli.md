---
title: CLI Reference
description: Complete reference for the Smelter command-line interface and all available commands.
category: reference
area: cli
audience: [user]
status: current
sidebar:
  order: 3
---

Run AI-powered workflows from your terminal.

## Prerequisites

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/coleam00/Smelter
   cd Smelter
   bun install
   ```

2. Make CLI globally available (recommended):
   ```bash
   cd packages/cli
   bun link
   ```
   This creates an `smelter` command available from anywhere.

3. Authenticate with Claude:
   ```bash
   claude /login
   ```

**Note:** Examples below use `smelter` (after `bun link`). If you skip step 2, use `bun run cli` from the repo directory instead.

## Quick Start

```bash
# List available workflows (requires git repository)
smelter workflow list --cwd /path/to/repo

# Run a workflow (auto-creates isolated worktree by default)
smelter workflow run assist --cwd /path/to/repo "Explain the authentication flow"

# Explicit branch name for the worktree
smelter workflow run plan --cwd /path/to/repo --branch feature-auth "Add OAuth support"

# Opt out of isolation (run in live checkout)
smelter workflow run assist --cwd /path/to/repo --no-worktree "Quick question"
```

**Note:** Workflow and isolation commands require running from within a git repository. Running from subdirectories automatically resolves to the repo root. The `version`, `help`, `chat`, `setup`, `serve`, and `doctor` commands work anywhere.

## Commands

### `chat <message>`

Send a message to the orchestrator for a one-off AI interaction.

```bash
smelter chat "What does the orchestrator do?"
```

### `setup`

Interactive setup wizard for credentials and configuration.

```bash
smelter setup                      # writes ~/.smelter/.env (home scope, default)
smelter setup --scope project      # writes <cwd>/.smelter/.env instead
smelter setup --force              # overwrite instead of merging (backup still written)
smelter setup --spawn              # open in a new terminal window
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--scope home` | Write to `~/.smelter/.env` (default). Applies to every project. |
| `--scope project` | Write to `<cwd>/.smelter/.env`. Overrides user scope for this repo only. |
| `--force` | Overwrite the target file wholesale instead of merging. A timestamped backup is still written. |
| `--spawn` | Open setup wizard in a new terminal window. |

**Write safety**: `smelter setup` never writes to `<cwd>/.env` — that file belongs to you. The wizard always targets one smelter-owned file chosen by `--scope`, merges into existing content (so user-added keys survive), and writes a timestamped backup before every rewrite (e.g. `~/.smelter/.env.smelter-backup-2026-04-20T09-28-11-000Z`).

### `doctor`

Verify your Smelter setup. Runs a checklist of common failure points: Claude binary spawn, gh CLI auth, database reachability, workspace writability, bundled defaults, and adapter token pings (Slack/Telegram, best-effort).

```bash
smelter doctor
```

Exit code 0 if all checks pass or are skipped; 1 if any critical check fails. Adapter pings degrade to `skip` on network errors — a flaky connection does not flip the result red.

Also runs automatically at the end of `smelter setup` (optional).

### `workflow list`

List workflows available in target directory.

```bash
smelter workflow list --cwd /path/to/repo

# Machine-readable output for scripting
smelter workflow list --cwd /path/to/repo --json
```

Discovers workflows from `.smelter/workflows/` (recursive), `~/.smelter/workflows/` (global, home-scoped), and bundled defaults. See [Global Workflows](/guides/global-workflows/).

**Flags:**

| Flag | Effect |
|------|--------|
| `--cwd <path>` | Target directory (required for most use cases) |
| `--json` | Output machine-readable JSON instead of formatted text |

With `--json`, outputs `{ "workflows": [...], "errors": [...] }`. Optional fields (`provider`, `model`, `modelReasoningEffort`, `webSearchMode`) are omitted when not set on a workflow.

### `workflow run <name> [message]`

Run a workflow with an optional user message.

```bash
# Basic usage
smelter workflow run assist --cwd /path/to/repo "What does this function do?"

# With isolation
smelter workflow run plan --cwd /path/to/repo --branch feature-x "Add caching"
```

Progress events (node start/complete/fail/skip, approval gates) are written to stderr during execution.

**Flags:**

| Flag | Effect |
|------|--------|
| `--cwd <path>` | Target directory (required for most use cases) |
| `--branch <name>` | Explicit branch name for the worktree |
| `--from <branch>`, `--from-branch <branch>` | Override base branch (start-point for worktree) |
| `--no-worktree` | Opt out of isolation -- run directly in live checkout |
| `--resume` | Resume from last failed run at the working path (skips completed nodes) |
| `--quiet`, `-q` | Suppress all progress output to stderr |
| `--verbose`, `-v` | Also show tool-level events (tool name and duration) |

**Default (no flags):**
- Creates worktree with auto-generated branch (`smelter/task-<workflow>-<timestamp>`)
- Auto-registers codebase if in a git repo

**With `--branch`:**
- Creates/reuses worktree at `~/.smelter/workspaces/<owner>/<repo>/worktrees/<branch>/`
- Reuses existing worktree if healthy

**With `--no-worktree`:**
- Runs in target directory directly (no isolation)
- Mutually exclusive with `--branch` and `--from`

**Name Matching:**

Workflow names are resolved using a 4-tier fallback hierarchy. This applies consistently across the CLI and all chat platforms (Slack, Telegram, Web, GitHub, Discord):
1. **Exact match** - `smelter-assist` matches `smelter-assist`
2. **Case-insensitive** - `Smelter-Assist` matches `smelter-assist`
3. **Suffix match** - `assist` matches `smelter-assist` (looks for `-assist` suffix)
4. **Substring match** - `smart` matches `smelter-smart-pr-review`

If multiple workflows match at the same tier, an error lists the candidates:
```
Ambiguous workflow 'review'. Did you mean:
  - smelter-review
  - custom-review
```

### `workflow status`

Show all running workflow runs across all worktrees.

```bash
smelter workflow status
smelter workflow status --json
```

### `workflow resume`

Resume a failed workflow run. Re-executes the workflow, automatically skipping nodes that completed in the prior run.

```bash
smelter workflow resume <run-id>
```

### `workflow abandon`

Discard a workflow run (marks it as `cancelled`). Use this to unblock a worktree when you don't want to resume — the path lock is released immediately so a new workflow can start.

```bash
smelter workflow abandon <run-id>
```

### `workflow approve`

Approve a paused workflow run at an interactive approval gate. Optionally provide a comment that is available to the workflow via `$LOOP_USER_INPUT`.

```bash
smelter workflow approve <run-id>
smelter workflow approve <run-id> "Looks good, proceed"
smelter workflow approve <run-id> --comment "Looks good, proceed"
```

### `workflow reject`

Reject a paused workflow run at an approval gate. Optionally provide a reason that is available to the workflow via `$REJECTION_REASON`.

```bash
smelter workflow reject <run-id>
smelter workflow reject <run-id> --reason "Needs more tests"
```

### `workflow cleanup`

Delete old terminal workflow run records from the database.

```bash
smelter workflow cleanup        # Default: 7 days
smelter workflow cleanup 30     # Custom threshold
```

### `workflow event emit`

Emit a workflow event directly to the database. Primarily used inside workflow loop prompts to record story-level lifecycle events.

```bash
smelter workflow event emit --run-id <uuid> --type <event-type> [--data <json>]
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--run-id` | Yes | UUID of the workflow run |
| `--type` | Yes | Event type (e.g., `ralph_story_started`, `node_completed`) |
| `--data` | No | JSON string attached to the event. Invalid JSON prints a warning and is ignored. |

Exit code: 0 on success, 1 when `--run-id`, `--type` is missing, or `--type` is not a valid event type. Event persistence is best-effort (non-throwing) -- check server logs if events appear missing.

### `isolation list`

Show all active worktree environments.

```bash
smelter isolation list
```

Groups by codebase, shows branch, workflow type, platform, and days since activity.

### `isolation cleanup [days]`

Remove stale environments.

```bash
# Default: 7 days
smelter isolation cleanup

# Custom threshold
smelter isolation cleanup 14

# Remove environments with branches merged into main (also deletes remote branches)
smelter isolation cleanup --merged

# Also remove environments whose PRs were closed without merging
smelter isolation cleanup --merged --include-closed
```

Merge detection uses three signals in order: git branch ancestry (fast-forward / merge commit),
patch equivalence (squash-merge via `git cherry`), and GitHub PR state via the `gh` CLI.
The `gh` CLI is optional — if absent, only git signals are used.

By default, branches with a **CLOSED** PR are skipped. Pass `--include-closed` to clean
those up as well. Branches with an **OPEN** PR are always skipped.

### `validate workflows [name]`

Validate workflow YAML definitions and their referenced resources (command files, MCP configs, skill directories).

```bash
smelter validate workflows                 # Validate all workflows
smelter validate workflows my-workflow     # Validate a single workflow
smelter validate workflows my-workflow --json  # Machine-readable JSON output
```

Checks: YAML syntax, DAG structure (cycles, dependency refs), command file existence, MCP config files, skill directories, provider compatibility. Returns actionable error messages with "did you mean?" suggestions for typos.

Exit code: 0 = all valid, 1 = errors found.

### `validate commands [name]`

Validate command files (.md) in `.smelter/commands/`.

```bash
smelter validate commands                  # Validate all commands
smelter validate commands my-command       # Validate a single command
```

Checks: file exists, non-empty, valid name.

Exit code: 0 = all valid, 1 = errors found.

### `complete <branch> [branch2 ...]`

Remove a branch's worktree, local branch, and remote branch, and mark its isolation environment as destroyed.

```bash
smelter complete feature-auth
smelter complete feature-auth --force  # bypass uncommitted-changes check
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--force` | Skip uncommitted-changes guard |

Use this after a PR is merged and you no longer need the worktree or branches. Accepts multiple branch names in one call.

### `serve`

Start the web UI server. On first run, downloads a pre-built web UI tarball from the matching GitHub release, verifies the SHA-256 checksum, and extracts it. Subsequent runs use the cached copy.

**Binary installs only** — in development, use `bun run dev` instead.

```bash
# Start web UI server (downloads on first run)
smelter serve

# Override the default port
smelter serve --port 4000

# Download the web UI without starting the server
smelter serve --download-only
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--port <port>` | Override server port (default: 3090, range: 1–65535) |
| `--download-only` | Download and cache the web UI, then exit without starting the server |

The cached web UI is stored at `~/.smelter/web-dist/<version>/`. Each version is cached independently, so upgrading the binary automatically downloads the matching web UI.

### `skill install [path]`

Install the bundled Smelter skill files into a project's `.claude/skills/smelter/` directory. Always overwrites existing files to ensure the latest version shipped with the current Smelter binary is installed.

```bash
# Install into the current directory
smelter skill install

# Install into a specific project
smelter skill install /path/to/project
```

The Smelter skill teaches Claude Code how to work with Smelter workflows, commands, and project conventions. It is also installed automatically during `smelter setup`.

### `version`

Show version, build type, and database info.

```bash
smelter version
```

## Global Options

| Option | Effect |
|--------|--------|
| `--cwd <path>` | Override working directory (default: current directory) |
| `--quiet`, `-q` | Reduce log verbosity to warnings and errors only |
| `--verbose`, `-v` | Show debug-level output |
| `--json` | Output machine-readable JSON (for workflow list, workflow status) |
| `--help`, `-h` | Show help message |

## Working Directory

The CLI determines where to run based on:

1. `--cwd` flag (if provided)
2. Current directory (default)

Running from a subdirectory (e.g., `/repo/packages/cli`) automatically resolves to the git repository root (e.g., `/repo`).

When using `--branch`, workflows run inside the worktree directory.

> **Commands and workflows are loaded from the working directory at runtime.** The CLI reads directly from disk, so it picks up uncommitted changes immediately. This is different from the server (Telegram/Slack/GitHub), which reads from the workspace clone at `~/.smelter/workspaces/` -- that clone only syncs from the remote before worktree creation, so changes must be pushed to take effect there.

## Environment

At startup, the CLI strips all Bun-auto-loaded CWD `.env` keys and nested Claude Code session markers from `process.env`, then loads two smelter-owned env files with `override: true`. Keys in smelter-owned files pass through to AI subprocesses — no allowlist filtering.

On startup, the CLI:
1. Strips `<cwd>/.env*` keys + `CLAUDECODE` markers from `process.env` (via `stripCwdEnv`). Emits `[smelter] stripped N keys from <cwd> (...)` when N > 0.
2. Loads `~/.smelter/.env` (user scope). Emits `[smelter] loaded N keys from ~/.smelter/.env` when N > 0.
3. Loads `<cwd>/.smelter/.env` (project scope, overrides user scope). Emits `[smelter] loaded N keys from <path> (repo scope, overrides user scope)` when N > 0.
4. Auto-enables global Claude auth if no explicit tokens are set.

`<cwd>/.env` is never loaded — it belongs to the target project. See [Configuration Reference: `.env` File Locations](/reference/configuration/#env-file-locations) for the full three-path model.

## Database

- **Without `DATABASE_URL` (default):** Uses SQLite at `~/.smelter/smelter.db` -- zero setup, auto-initialized on first run
- **With `DATABASE_URL`:** Uses PostgreSQL (optional, for cloud/advanced deployments)

Both work transparently. Most users never need to configure a database.

## Examples

```bash
# One-off AI chat
smelter chat "How does error handling work in this codebase?"

# Interactive setup wizard
smelter setup

# Quick question (auto-isolated in smelter/task-assist-<timestamp>)
smelter workflow run assist --cwd ~/projects/my-app "How does error handling work here?"

# Quick question without isolation
smelter workflow run assist --cwd ~/projects/my-app --no-worktree "How does error handling work here?"

# Plan a feature (auto-isolated)
smelter workflow run plan --cwd ~/projects/my-app "Add rate limiting to the API"

# Implement with explicit branch name
smelter workflow run implement --cwd ~/projects/my-app --branch feature-rate-limit "Add rate limiting"

# Branch from a specific source branch instead of auto-detected default
smelter workflow run implement --cwd ~/projects/my-app --branch test-adapters --from feature/extract-adapters "Test adapter changes"

# Approve or reject a paused workflow
smelter workflow approve <run-id> "Ship it"
smelter workflow reject <run-id> --reason "Missing test coverage"

# Check worktrees after work session
smelter isolation list

# Clean up old worktrees
smelter isolation cleanup
```
