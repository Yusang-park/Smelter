# Smelter

TDD-first, file-based, multi-agent development system for Claude Code.

## Quick Start

```bash
# Claude
claude

# Linear alias
linear
```

## HUD / Statusline

Custom statusline displaying model info, 5h rate-limit usage, and session stats.

**Claude mode:**
```
Opus 4.6 (1M context)  1.4M / 2.0M 75% (reset 2h0m) | 292.5k out | ctx 31%
```


**Fields:**
| Field | Source | Description |
|-------|--------|-------------|
| Model label | stdin `model.display_name` / cache | Active model name |
| Used tokens | JSONL transcript scan (5h window) | Output tokens by model family |
| `/ total` | Derived from stdin `used_percentage` | Claude only (Codex omits — unreliable) |
| `pct%` | stdin `rate_limits.five_hour.used_percentage` | Anthropic's authoritative 5h usage |
| `reset XhYm` | stdin `resets_at` / cache | Countdown to 5h window reset |
| `Xk out` | stdin `context_window.total_output_tokens` | Current session output tokens |
| `ctx X%` | stdin `context_window.used_percentage` | Context window utilization |

**Caching:**
- Per-cwd cache for recent model label, 5h denominator, and `resets_at`

## Project Structure

```
src/              TypeScript engine (types, engine, adapters, rules)
bin/              CLI entry point
agents/           Subagent definitions
skills/           Workflow skill prompts
commands/         Slash commands (/tasker, /feat, /qa)
scripts/          Hook scripts and utilities
  statusline-hud.mjs   HUD statusline renderer
presets/          Execution preset configs (tasker, feat, qa)
rules/            Language-specific coding rules
```

## Commands

| Command | Description |
|---------|-------------|
| `/tasker` | Create or refine planning state (Steps 1-3). Integrates with native plan mode. |
| `/feat` | Full 10-step workflow. Magic keyword "extend" skips Step 2 (Learning). |
| `/qa` | Narrow execution for bug fixes and simple UI/text/dialogue edits (Steps 4-10). E2E surface-based. TDD exemption for style/i18n/typo/dialogue. |

Natural-language **magic keywords** map to the same commands without the slash (see `scripts/keyword-detector.mjs` and `CLAUDE.md`).

## Global Hooks

- **Auto-Confirm** (`scripts/auto-confirm.mjs`, Stop): forwards the main agent's last response to a sub-agent when pending tasks remain. Gate: `~/.smt/config.json` → `autoConfirm: true` (default on).
- **Tool-Retry** (`scripts/tool-retry.mjs`, PostToolUse): auto-retries rg timeout / file-modified / rg flag-parse; reclassifies grep exit-1-no-match as success. 3-retry cap.
- **Doc Sync Check** (`scripts/session-end.mjs`, SessionEnd): validates command/preset/step/magic-keyword consistency across tracked files on session end.

## License

Private
