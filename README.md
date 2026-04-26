<p align="center">
  <img src="assets/smelter-logo.svg" alt="Smelter" width="600" />
</p>

<p align="center">
  <strong>TDD-first workflow engine for Claude Code: file-based state, deterministic gates, multi-agent execution.</strong>
</p>

<p align="center"><code>v0.4.1</code></p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a>
</p>

---

## Install

```bash
claude plugin marketplace add Yusang-park/Smelter
claude plugin install smelter@smelter-marketplace
```

Developing Smelter itself:

```bash
git clone https://github.com/Yusang-park/Smelter.git ~/Smelter
node ~/Smelter/scripts/dev-install.mjs
```

`dev-install.mjs` symlinks `commands/` only, then installs repo-managed hooks into `~/.claude/settings.json`. It removes old Smelter dev symlinks for `skills/` and `agents/` so workflow resources are not globally auto-discovered. Use `--dry-run`, `--uninstall`, or `--force` as needed. Start a new Claude Code session after hook registration changes.

---

## What Changed In v0.4

- Versioning is now `0.*`; the current release line is `v0.4.1`.
- User-facing read-only mode is `explore`, invoked with `/explore`.
- Infrastructure operations use `/infra` so cloud/IaC/resource mutation does not route through product-code TDD.
- The executor skill remains `workflow-investigate`; skill names describe implementation artifacts, while modes describe user intent.
- The retired investigate command is not an alias.
- `/brainstorm` remains the only design/planning command; retired think, plan, and simple-fix commands are not aliases.
- Runtime permissions are derived from `UserMode → TaskType → Step → Guard`, not from prompt wording.

---

## Commands

| Command | User mode | Task type | Entry skill | Pipeline | Use when |
|---|---|---|---|---|---|
| `/brainstorm` | `brainstorm` | `design` | `workflow-brainstorm` | `planning_only` | Product/architecture planning without code edits |
| `/explore` | `explore` | `read` | `workflow-investigate` | `explore_only` | Read-only codebase exploration and diagnosis |
| `/implement` | `implement` | `write` | `workflow-investigate` → `workflow-implementation-plan` | `full` | Build on existing code with implementation planning |
| `/infra` | `infra` | `infra` | `workflow-investigate` → `workflow-infra-plan` | `infra_ops` | Cloud/resource/IaC operations with inventory, safety plan, execution evidence |
| `/fix` | `fix` | `write` | `workflow-investigate` | runtime-selected | Bug repair, logic fixes, trivial text/design edits |
| `/verify` | `verify` | `verify` | `workflow-verify` | `verify_only` | Non-mutating tests, static checks, and real-interface E2E |
| `/dobby` | `dobby` | `freeform` | `workflow-human-check` | `dobby_only` | Explicit no-pipeline escape hatch with human approval |

Natural language routes to the same modes. Examples: "analyze this function" → `/explore`, "버그 고쳐줘" → `/fix`, "설계해줘" → `/brainstorm`, "run tests" → `/verify`.

---

## Contract Model

Smelter v0.4 separates four layers:

| Layer | Purpose |
|---|---|
| `UserMode` | User intent: `brainstorm`, `explore`, `implement`, `infra`, `fix`, `verify`, `dobby` |
| `TaskType` | Side-effect contract: `design`, `read`, `write`, `infra`, `verify`, `freeform` |
| `Step` | Deterministic FSM position: `INTENT`, `DISCOVERY`, `PLAN`, `TEST_DESIGN`, `EXECUTE`, `VERIFY`, `HUMAN_CHECK`, `DONE` |
| `Guard` | Tool/action validator for the current `(task_type, step, state)` |

This means read/design/verify modes cannot mutate source, write modes cannot edit product code before RED test evidence, and commits are blocked until `workflow-human-check` passes.

---

## How It Works

1. `scripts/mode-classifier.mjs` resolves slash commands and natural language into a user mode.
2. `scripts/keyword-detector.mjs` seeds `.smt/features/<slug>/task/<slug>.state.json` and an active-feature pointer.
3. `modes/workflow.yaml` maps the mode to entry skill and allowed pipeline.
4. Workflow skills produce file artifacts under `.smt/features/<slug>/task/`.
5. `scripts/skill-stage-transition.mjs`, `scripts/auto-confirm.mjs`, and `scripts/pre-tool-enforcer.mjs` enforce transitions, continuation, and tool permissions.
6. Review and verification skills must pass before `workflow-human-check` can complete the task.

The core rule is unchanged: **agents do not memorize; agents read files.**

---

## TDD And Verification

- Implementation work must write tests first, observe RED, implement, then reach GREEN.
- Interface-changing work requires real-interface E2E: browser, subprocess, HTTP port, DB engine, or hook stdin/stdout as applicable.
- CSS/style, i18n/copy-only, typo, and pure-dialogue changes are surface-exempt from TDD but still go through the selected workflow.
- Multi-Pass Verification runs exactly two global rounds, omission and contradiction, for every review skill.

---

## Project Layout

```
agents/        specialized subagent definitions
skills/        workflow-* skills and utility skills
commands/      slash command entry points
modes/         unified workflow config (`workflow.yaml`)
hooks/         Claude Code hook registration
scripts/       runtime hooks, routing, state, guards, verification
document/      workflow and implementation specification
src/           core TypeScript engine
bin/           CLI entry point
.smt/          project-local task memory and session state
```

---

## Status

- Version: `0.4.1`
- Canonical spec: [`document/workflow.md`](document/workflow.md)
- Implementation status: [`document/implementation.md`](document/implementation.md)
- Agent instructions: [`CLAUDE.md`](CLAUDE.md), [`AGENTS.md`](AGENTS.md)
- Main verification: `npm test`, `npm run typecheck`

Private project. See `plugin.json` for metadata.
