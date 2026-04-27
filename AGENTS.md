# Smelter — Agent Instructions v0.51

**"Agents do not memorize. Agents read files."** Plans/tasks/decisions -> `.smt/`. Progress in `features/<slug>/task/{name}.md` + `.state.json`.

## TDD (Mandatory)

```
RULE 1: No implementation before tests
RULE 2: Test file before source file
RULE 3: Tests MUST fail first (RED) then pass (GREEN)
RULE 4: E2E required for UI/CLI/API/hooks/scripts changes
RULE 5: Never mark task complete without passing tests
```
Exemption: CSS/style, i18n/copy, typo, pure-dialogue — skip TDD. See `document/workflow.md §7-4`.

## Commands

| Command | Mode | Task type | Entry skill | Use |
|---------|------|-----------|-------------|-----|
| `/brainstorm` | brainstorm | design | `workflow-investigate` -> `workflow-brainstorm` | New features/refactors |
| `/implement` | implement | write | `workflow-investigate` -> `workflow-implementation-plan` | Build on existing code |
| `/fix` | fix | write | `workflow-investigate` | Bug/logic repair, trivial text/CSS |
| `/infra` | infra | infra | `workflow-investigate` -> `workflow-infra-plan` | Infrastructure/cloud/IaC operations |
| `/explore` | explore | read | `workflow-investigate` | Static read-only exploration only |
| `/verify` | verify | verify | `workflow-verify` | Test run + static + E2E |

User-only no-pipeline escape hatches are handled by hooks when explicitly typed by the user; they are not agent-owned commands or recovery paths.

Mode classifier (`scripts/mode-classifier.mjs`) auto-routes; slash commands override. State in `.smt/features/<slug>/task/<task>.state.json`. Contracts in `document/workflow.md`.

**Workflow source of truth:** workflow topology belongs in `modes/workflow.yaml` (`skills`, `pipelines`, `modes`, `target_type_routing`, `transition_adoptions`, `verification_rounds`, `command_aliases`). Hooks/scripts should load and execute this config; do not scatter mode-specific workflow branches in individual hooks unless the hook is only enforcing a generic runtime safety rule.

**Auto-Confirm:** `auto-confirm.mjs` on Stop -> `.smt/state/auto-confirm-queue-<session_id>.json` -> injected by `auto-confirm-consumer.mjs`. Gate: default **ON** — set `~/.smt/config.json { "autoConfirm": false }` to disable. Cancel: `/cancel [hard]`. Redirect: `/queue <intent>`.

**Auto-Retry:** `tool-retry.mjs` retries ripgrep timeout/file-modified/file-not-read errors. Cap: 3.

**Iron Laws:** 8 rules — `document/workflow.md §0`. Key: never stop after failure; file is truth; no self-failure.

## Agents (`agents/`)

Specialists: planner, executor, architect, code-reviewer, security-reviewer, qa-tester, tdd-guide, researcher, explore, designer, writer, advocate/critic/arbitrator.
Workflow support: aggregator (Pattern C), conflict-resolver, critic-watchdog (§12-8), debugger (stall, §11-7).

## File Structure

```
.smt/features/<slug>/task/
  plan.md           — goal, scope, acceptance criteria
  <name>.md         — task record
  <name>.state.json — machine state
  ../decisions.md   — architecture decisions
  ../artifacts/     — e2e logs/screenshots
.smt/state/         — per-session + global state (auto-confirm-queue-<sid>.json, active-feature-<sid>.json, mode-emitted-<sid>.json, tool-retry.json, ...)
.smt/wiki/          — knowledge base
.smt/session/       — session logs
~/.smt/config.json  — global config
```

**Protocol:** (1) Session start auto-read 없음 — 필요할 때 agent가 직접 `Read` (`.smt/features/<slug>/task/plan.md` 등). (2) Before coding -> verify task + state.json exist. (3) Task done -> update both. (4) Decision -> append `decisions.md`. (5) Session end -> `session/YYYY-MM-DD.md`.

**No Claude Code task tools.** Use only `.smt/` files. Never `TaskCreate/TaskUpdate/TaskList/TodoWrite`.

## Completion Checklist

- [ ] Unit + integration tests passing
- [ ] E2E tests passing (if interface changed)
- [ ] Multi-Pass Verification 2 rounds (§9-3)
- [ ] `task/<name>.md` + `.state.json` updated
- [ ] `tsc --noEmit` clean (scoped to changed surface)
- [ ] `workflow-human-check` approved

**If ANY unchecked -> CONTINUE WORKING.** (Iron Law #1)

## No-Choice Policy

Pick highest-confidence path; state pick + reason in one line; act. Never A/B branch. Halt only for: credentials, irreversible destructive ops, genuine requirement gap. A judgement call is not a blocker.

## Serena MCP (`.mcp.json`)

Prefer symbol tools over full-file Read. Saves 70-95% tokens.

| Task | Tool |
|------|------|
| Specific symbol | `find_symbol` |
| File overview | `get_symbols_overview` |
| Cross-file refs | `find_referencing_symbols` |
| Edit symbol body | `replace_symbol_body`, `insert_after_symbol` |
| Full file needed | `Read` fallback |

## Images/Screenshots

Always `Read` image/PDF paths directly. Never grep path as string. Don't delegate to `vision` unless `Read` fails.

## Workflow-Gated Code Edits

All code-file Edit/Write requires active `/fix`, `/implement`, or `/infra` workflow. Enforced by `pre-tool-enforcer.mjs` -> `[SMELTER] Raw <tool> of code file is blocked`.

**Gated:** `.ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.go/.rs`, `.toml`, `.sh/.bash`, `.vue/.svelte/.astro`, `.css/.scss`, `.html/.xml`, `.tf/.tfvars`.
**Not gated:** `.md/.txt/.rst/.yaml/.yml/.json/.jsonc` — docs / YAML / declarative JSON configs run without workflow. State files under `.smt/` remain blocked by protected-path rule regardless of extension.
**Escape hatch:** hook scripts set `SMT_HOOK_WRITE=1`.
**Bypass blocked:** direct writes to `.smt/*.state.json` refused.

If blocked: invoke `Skill(fix)`, `Skill(implement)`, or `Skill(infra)` yourself to seed an active workflow; do not ask the user to type a slash command. User-only no-pipeline escape hatches are not agent-owned recovery.

## Smelter Hook Model

Project-local harness knowledge only: `PreToolUse` validates tool intent before execution, `PostToolUse` verifies results after execution, `Stop` handles continuation/final checks, and `SessionStart`/`SessionEnd` handle lifecycle setup/sync. Do not export this as user-project coding guidance.

## Other Rules

- **Doc sync:** every code update -> also update `document/workflow.md` + `document/implementation.md`.
- **Git:** `<type>: <description>` (feat/fix/refactor/docs/test/chore/perf/ci).
- **CEO rule:** treat user as CEO — full respect always.
- **Hook edits:** `hooks/hooks.json` changes require session restart. Script body `.mjs` edits are live immediately.
- **Visibility:** hooks emit `[Tag Name]` to stderr.

## Project Structure

```
src/ bin/ agents/ skills/ modes/ commands/ hooks/ scripts/ templates/ rules-lib/ document/
.mcp.json  .claudeignore
```
Full detail: `document/implementation.md`.
