# Release Notes

## v2.3.0 — Skill-Composition Workflow Engine
**Released**: 2026-04-20

Smelter v2.3.0 replaces the fixed Step 1..10 pipeline with a skill-composition model. Five commands compose thirteen `workflow-*` skills into five modes. Failures route through a producer chain, not retries. Auto-confirm uses a queue-drop pattern so the session never halts. Review skills run 3 mandatory verification rounds. Iron Laws are runtime-enforced via hooks.

---

### Headline changes

- **5 commands** — `/plan`, `/implement`, `/fix`, `/simple-fix`, `/investigate`. Natural-language auto-routing via `scripts/mode-classifier.mjs`; explicit slash commands override. Compound intents (e.g., `검증하고 수정해` → investigate → fix) are detected and auto-transitioned.
- **13 workflow skills** — each declares a `consumes → produces` contract and a gate in `skills/workflow-*/SKILL.md`. Modes are subsets of skills with an entry point.
- **Producer-chain routing** (`scripts/route-on-fail.mjs`) — no retries. On fail, the engine routes to the upstream skill that produced the artifact. `severity` / `cause` / `active_feedback` branches encoded; whitelist violations trigger user-gated mode upgrade.
- **Queue-drop auto-confirm** (`scripts/auto-confirm.mjs` + `scripts/auto-confirm-consumer.mjs`) — Stop hook writes to `.smt/state/auto-confirm-queue.json`, UserPromptSubmit consumer injects on the next turn. Session never halts except in the 4 allowed cases (user stop, human-check awaiting input, mode-upgrade decision, no active state).
- **Multi-Pass Verification** — every review skill runs 3 rounds (`omission → contradiction → edge_case`) before declaring pass. Anti-evasion guards hook-enforced.
- **Stall Cascade** (`scripts/stall-detector.mjs`) — 6 signals + 4-level cascade (Debugger → Producer reroute → Sub-tasker → Mode upgrade). Levels 1-3 resolve without user; only Level 4 surfaces.
- **Team Agent Patterns (A-E)** — Specialist / Team Consensus / Parallel Delegation / Hierarchical / Adversarial Watchdog. Pattern selection lives in `state.team_runtime[skill].pattern`, populated by `workflow-tasker`.
- **Critic Watchdog (Pattern E)** — 2 layers: PostToolUse hook (`scripts/critic-watchdog.mjs`, 10 formal rules, CRITICAL=exit 2) + periodic semantic agent (`agents/critic-watchdog.md`, ReadOnly tools).
- **File-based state** — every task has `.smt/features/<slug>/task/<task>.state.json` at schema v2.3.0. Validated by `scripts/state-schema.mjs`.

---

### Commands

| Command        | Mode          | Entry skill                      |
|----------------|---------------|----------------------------------|
| `/plan`        | `plan`        | `workflow-brainstorm` (deep)     |
| `/implement`   | `implement`   | `workflow-brainstorm` (light)    |
| `/fix`         | `fix`         | `workflow-investigate`           |
| `/simple-fix`  | `simple_fix`  | `workflow-coding`                |
| `/investigate` | `investigate` | `workflow-investigate`           |

---

### Workflow skills (13)

`workflow-brainstorm`, `workflow-brainstorm-review`, `workflow-investigate`, `workflow-investigate-review`, `workflow-tasker`, `workflow-tasker-review`, `workflow-write-test`, `workflow-coding`, `workflow-agent-review`, `workflow-e2e`, `workflow-e2e-review`, `workflow-team-code-review`, `workflow-human-check`.

---

### New agents

Core (workflow-support):
- `aggregator` — merges Pattern C parallel outputs; detects conflicts
- `conflict-resolver` — adjudicates aggregator-declared merge failures
- `critic-watchdog` — Pattern E Layer 2 semantic reviewer (ReadOnly)
- `debugger` — Stall Cascade Level 1 diagnostic (ReadOnly)

Pattern B consensus trio:
- `advocate` — defends artifact merits
- `critic` — finds defects (migrated from v1 plan-reviewer role)
- `arbitrator` — synthesizes, computes 95% consensus, renders verdict

Pattern D brainstorm personas:
- `product-persona` — user/business perspective
- `engineer-persona` — engineering feasibility
- `design-persona` — UX / accessibility / copy

---

### Iron Laws (8, runtime-enforced)

1. Never halt after failure (auto-confirm decide tree)
2. No evasion (critic-watchdog R08 + risk keyword sub-tasker)
3. No skill self-failure (state-schema validator rejects `declarer: skill`)
4. No retry (producer-chain routing only)
5. File is truth (schema-validated postconditions)
6. Workflow whitelist is user decision (mode upgrade gate)
7. Independent queues, shared session (per-task state.json)
8. Scoped testing (full regression only at `workflow-human-check`)

See `document/workflow.md` §0.

---

### Breaking changes

**Removed v1 step-engine infrastructure:**
- `workflows/*.yaml` (build / fix / plan step DAGs)
- `steps/step-*.md` (11 step prompts)
- `presets/*.json` (build / fix / plan presets)
- `scripts/step-injector.mjs`, `scripts/step-tracker.mjs`
- `scripts/integration-workflow.test.mjs`, `step-engine.test.mjs`, `workflow-seeder.test.mjs`
- `scripts/lib/yaml-parser.mjs`
- `scripts/test-max-attempts.ts`, `test-queue-session-isolation.mjs`
- `commands/build.md` (replaced by `/implement`)
- `document-backup/` (legacy snapshot)

**Command surface changes:**
- `/build` → retired. Use `/implement` (lightweight) or `/plan` (new feature / refactor).
- Natural-language input now auto-routes; the classifier is rule-based (Iron Law #2 — no LLM inference for routing).

**State schema:**
- All features must use `<task>.state.json` (schema 2.3.0). Any residual `state/workflow.json` is reported as `orphan` by `scripts/feature-version-check.mjs`.

**Terminology:**
- "Step" → "skill"
- "Workflow engine" now refers to the skill-composition engine, not the step-engine.

---

### Migrations

- Feature dirs with only a `state/workflow.json` are flagged as `orphan` by `feature-version-check.mjs`. To migrate: move to a v2 `<task>.state.json` via `scripts/state-schema.mjs` `createInitialState(...)`.
- `/build` invocations should be replaced with `/implement` (lightweight build on existing code) or `/plan` (greenfield / refactor that needs planning).
- Any `max_retry` behavior: replaced by producer-chain routing. Remove the field; upstream failure routes to the producer skill automatically.

---

### Tooling & audit

- New test suites: `scripts/auto-confirm.test.mjs` (51 cases) and `scripts/mode-classifier.test.mjs` (15 cases).
- `scripts/session-end.mjs` checks: doc-sync against `EXPECTED_COMMANDS`, retired command scan via `FORBIDDEN_COMMANDS`, retired step-engine directory scan, magic-keyword parity.
- 5-pass parallel audit completed 2026-04-20 (scripts / skills-modes-commands / agents / docs / hooks): 10 core agents present, zero v1 residue in Smelter core, 17/17 hook targets resolve, plugin manifests aligned to 2.3.0.

---

### Acknowledgements

Migration authored under auto mode with 4 parallel Lead-engineer verification agents in the final pass (scripts / structural / agents contracts / docs coherence / hooks config). Remediation applied in-line:

- Renamed `auto-confirm-v2.mjs` → `auto-confirm.mjs`, added `auto-confirm-consumer.mjs` (queue-drop pattern)
- Added 5 previously-referenced agents: advocate, arbitrator, product-persona, engineer-persona, design-persona
- `route-on-fail.mjs` e2e-review split by cause (`file_absent` → e2e, `insufficient_scenario` → coding)
- `session-end.mjs` FORBIDDEN_COMMANDS: removed `simple` false-positive on `/simple-fix`
- plugin.json, .claude-plugin/plugin.json, package.json: all aligned to `2.3.0`

---

### Related documents

- Canonical spec: [`document/workflow.md`](document/workflow.md)
- Implementation reference: [`document/implementation-v2.md`](document/implementation-v2.md)
- Phase-by-phase implementation status: [`document/implementation.md`](document/implementation.md)
- Project introduction: [`document/Introduce.md`](document/Introduce.md)
- Root agent instructions: [`CLAUDE.md`](CLAUDE.md), [`AGENTS.md`](AGENTS.md)
