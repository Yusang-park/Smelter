# Release Notes (English)

> This file is the canonical release log. Korean translation: [`RELEASE_NOTES.ko.md`](RELEASE_NOTES.ko.md).
> The English version is always the source of truth.

---

## v2.4.7 — Workflow Chain Enforcement (B plan)
**Released**: 2026-04-21

Closes the stuck-loop defect where the main agent would idle after Stop block while `current_stage` stayed seeded at the entry skill. Implements a six-phase end-to-end enforcement of workflow stage transitions so the agent genuinely progresses — or the hook layer tells it exactly how to.

### Phases (single release)

| Phase | Commit | Summary |
|-------|--------|---------|
| 0 | `9d677f3` | `stop-stage-enforcer.mjs` reauthored (file corruption repaired), `WORKFLOW_MODES_FOR_STAGE_GUARD` extended to all 6 modes, `keyword-detector` seeds `current_stage = mode.entry_skill`. |
| 1 | `50cb17c` | `skill-stage-transition` accepts entry-command skills (`fix/investigate/plan/implement/verify/simple-fix`); Watchdog R15 blocks stage-skipping code edits; `auto-confirm.buildPromptInjection` emits `[MANDATORY WORKFLOW STEP]` with direction tag (`enter/advance/back`) + last-message echo. |
| 2 | `7ef971a` | `classifyStageCompletionViaSubAgent` — lightweight sub-agent judges whether the main's last message completes the current stage. On `complete`, auto-confirm auto-writes the canonical artifact so `skill-stage-transition` can mark the stage passed legitimately (Iron Law #5 preserved — no forged `completed_stages`). |
| 3 | `714abe1` | `stop-stage-enforcer` now embeds the MANDATORY directive inside its block `reason` so the agent's resumption input is directly actionable. |
| 4 | `2a6f120` | `scripts/lib/transcript-reader.mjs` (new) parses Claude Code `transcript_path` JSONL to supply `lastAssistantText` in production (the test-only `last_assistant_text` field was never populated by the real hook stdin). R13 gains `unwrapShellCExec` + `isPureReadCmd` so `bash -c 'ls …'` read wrappers no longer false-positive. |
| 5 | `9603c05` | SCENARIO 16 — 7 new workflow-scenarios tests covering implement/verify/fail/replan/re-implement/re-verify cycles with explicit `direction` assertions. No deadlock patterns. |
| 6 | `1c9cbff` | Classifier subprocess now sets `SMELTER_CLASSIFIER_SUBPROCESS=1` alongside `SMT_CLASSIFIER=1`; `SMT_CLASSIFIER_CMD` is an env fallback for stage classifier. Closes the "ghost feature slug" regression where the classifier's own system prompt was seeded as a new feature. |

### Slug preamble pruning (defense-in-depth)

`keyword-detector.deriveSlug` strips classifier/system preambles (`You are a …`, Korean 당신은, `Skill:/Role:/Context:` labels, echoed loader banners, `[MAGIC KEYWORD: …]` tags) and drops leading filler tokens before slugifying. Combined with the re-entrancy guard, this makes classifier-prompt leakage produce a domain-reflective slug even if the env var is somehow dropped.

### User conditions satisfied

| # | Condition | Implementation |
|---|-----------|----------------|
| 1 | Sub-agent delivers last message + workflow directive | `classifyProceedPromptViaSubAgent` + `classifyStageCompletionViaSubAgent` spawn sonnet/haiku; `formatMandatoryInjection` embeds 400-char excerpt. |
| 2 | Main forced to follow workflow | `[MANDATORY WORKFLOW STEP]` with explicit `Skill(skill: '<next>')` demand + R15 block-with-guidance. |
| 3 | Stop hook does NOT elevate unfinished stage | `stop-stage-enforcer` is read-only; wording differentiates `entry_not_started` (invoke current) vs `advance to <next>`. |
| 4 | Back-edge routing | `decide()` tags `direction='back'` on producer-chain routes; injection emits `go BACK to <skill>`. |
| 5 | Watchdog enforces transitions | R15 blocks `Edit/Write` of source files outside `workflow-coding`; guides the agent to the right Skill. |

### Scoped tests (all green)

| Suite | Count |
|-------|-------|
| auto-confirm | 99 |
| stop-stage-enforcer | 21 |
| critic-watchdog | 16 |
| skill-stage-transition | 16 |
| workflow-scenarios | 118 |
| test-keyword-detector | 6 |
| pre-tool-enforcer | 13 |
| transcript-reader | 13 |
| **Total** | **302** |

### Schema

- `SCHEMA_VERSION` stays at `2.4.1`. State shape unchanged; `direction` is a decision-time payload tag, not persisted.

### Docs

- `document/implementation.md` Phase 10–15 + Phase 2/3/4/5 records (inlined under Phase 14/15 per chronological style).
- `document/reference-topics/hooks-execution-workflow.md` §8-B updated with the broadened guard set and session-aware summary.
- `document/workflow.md` §2-3 documents the classifier-subprocess re-entrancy guard + slug preamble pruning.

---

## v2.4.1 — E2E Real-Interface Enforcement
**Released**: 2026-04-20

Strengthens the E2E stage contract: `workflow-e2e` and `workflow-verify` Phase 3 must drive the **actual user-facing interface** (real browser, real subprocess, real HTTP port, real DB engine, real hook stdin/stdout) and produce per-surface artifact files. Test-runner stdout alone (e.g., `pnpm test`, `vitest run`) is NOT a valid E2E pass.

### Enforcement

- **`skills/workflow-e2e/SKILL.md`** — rewritten with a prominent "NOT a test-runner stage" notice, a per-surface Real Interface Contract table, explicit "what does NOT count" / "what does count" sections, and mandatory artifacts layout.
- **Gate postconditions** added:
  - `real_interface_invoked: true`
  - `no_interface_mocks: true`
  - `per_surface_artifact_present: true`
- **`critic-watchdog.mjs` R11** (CRITICAL): blocks attempts to record an E2E pass while `.smt/features/<slug>/artifacts/` contains none of the allowed file types (`.webm`, `.mp4`, `.png`, `.jpg`, `.log`, `.transcript`, `.json`, `.sql`, `.exit`). Hook exits 2.
- **Fail causes** (new): `artifact_missing`, `mocked_interface`. Both route to `workflow-e2e` self-rerun (correct runner / mocks removed).
- **`skills/workflow-verify/SKILL.md`** — Phase 3 explicitly says "NOT a test-runner phase"; same per-surface artifact requirements.

### Real interface per surface

| Surface | Real interface | Required artifact |
|---------|----------------|-------------------|
| UI / Frontend | Real browser launched by Playwright | video (`.webm`) + screenshots (`.png`) + console.log |
| CLI / Script | Real subprocess (stdin, argv, exit code) | command transcript (`.transcript`) |
| HTTP API | Real server on a real port + real fetch/curl | request/response log |
| Database | Real DB engine (no driver stubs) | query log + before/after state |
| Hook script | Real `cat payload \| node hook.mjs` pipe | input JSON + output JSON + exit code |

### Disallowed

- Running `pnpm test` / `vitest run` / `jest` alone.
- In-process handler calls without the interface wrapper.
- Mocking the surface under test (MSW when HTTP is the subject, stubs when DB is the subject).
- Playwright dry-run / `--list`.
- Asserting on return values without observing the externally visible side effect.

### Schema

- `CAUSE_ENUM` adds `artifact_missing` and `mocked_interface` (additive, back-compat).
- `SCHEMA_VERSION` → `2.4.1`.

### Docs

- `document/workflow.md` §8 — full Real-Interface Contract section added; §3 Registry row 10 updated.
- `document/workflow.md` is now the English canonical; Korean translation lives at `document/workflow.ko.md`.
- `RELEASE_NOTES.md` is now the English canonical; Korean translation at `RELEASE_NOTES.ko.md`.
- Version bump to `2.4.1` across `plugin.json`, `.claude-plugin/plugin.json`, `package.json`, `CLAUDE.md`, `AGENTS.md`, `state-schema.mjs`.

### Tests

- `mode-classifier.test.mjs`: 15/15
- `auto-confirm.test.mjs`: 51/51
- `workflow-scenarios.test.mjs`: 111/111
- Manual R11 smoke: 3/3 (no artifact → block; artifact present → allow; non-e2e stage → R11 silent)

---

## v2.4.0 — `/verify` Mode (테스트·점검 Dedicated Entry)
**Released**: 2026-04-20

A new mode for **non-modifying verification** — runs tests + static inspection + E2E interface in a single pass and produces one consolidated `verify_report.md`. Closes a UX gap where "테스트 해봐" / "점검해" wrongly defaulted to the `/fix` pipeline.

### New

- **Command**: `/verify` — non-modifying verification (6th command in the Smelter command set).
- **Mode**: `verify` — allowed skills: `workflow-verify`, `workflow-e2e`, `workflow-e2e-review`, `workflow-human-check`.
- **Skill**: `workflow-verify` — runs 3 phases in one invocation:
  1. Test code execution (vitest/jest/pytest, scoped to changed surface)
  2. Code logic inspection (tsc, eslint, state-schema integrity, doc-sync)
  3. E2E interface verification (Playwright / API / CLI per 5-Surface Mapping)
- **Output artifact**: `verify_report.md` with per-phase breakdown and summary verdict.

### Classifier changes

- `테스트 해봐 / 돌려봐 / 점검해 / 실행해 / run the tests / health check` → `/verify`
- `점검` **moved from `/investigate` to `/verify`** (rationale: 점검 implies dynamic execution; `/investigate` is strictly static read).
- `검증 / 확인 / 체크 / verify / validate / check` **remain on `/investigate`** (static read semantics).
- Chain detection:
  - `테스트하고 고쳐` → `[verify, fix]`
  - `점검하고 수정해` → `[verify, fix]`
  - `run tests then fix` → `[verify, fix]`

### Producer chain

`workflow-verify` fail causes (`test_run` / `typecheck` / `lint` / `build` / `assertion`) route to `workflow-coding`. In `/verify` mode (which does not whitelist coding), this surfaces a `whitelist_violation` → user-gated `/fix` mode upgrade. When the input was chained (`테스트하고 고쳐`), auto-confirm advances the chain automatically.

### State schema

- `SCHEMA_VERSION` → `2.4.0`
- `WORKFLOW_SKILLS` adds `workflow-verify` (14 total)
- `MODES` adds `verify` (6 total)

### Tests

- `workflow-scenarios.test.mjs`: 111 scenarios (updated skill/mode counts to 14/6; 점검해 expectation moved from `investigate` to `verify`; added 테스트 해봐 / run the tests → `verify`)
- `mode-classifier.test.mjs`: 15/15 (no regressions)
- `auto-confirm.test.mjs`: 51/51 (no regressions)
- New: `scripts/session-sim.mjs` — end-to-end session simulator (Stop/UserPromptSubmit/PostToolUse)

### Docs

- `document/workflow.md` §1-2 adds verify row + investigate-vs-verify guidance; §3 registry 13 → 14 rows.
- `document/implementation-v2.md`: "6 commands × 6 modes × 14 skills"
- `CLAUDE.md` / `AGENTS.md` / `README.md`: 6-command tables, version `2.4.0`
- `plugin.json` / `.claude-plugin/plugin.json` / `package.json` → `2.4.0`

### Semantics recap

| Mode | Reads | Executes | Modifies |
|------|-------|----------|----------|
| `/investigate` | yes | no  | no |
| `/verify`      | yes | yes | no |
| `/fix`, `/implement`, `/simple-fix`, `/plan` | yes | yes | yes |

`/verify` is the missing third member: dynamic runtime verification without any source edits.

---

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
- `document-backup/` (legacy snapshot)

**Command surface changes:**
- `build` command (historically invoked as the v1 slash-form) → retired. Use `/implement` (lightweight) or `/plan` (new feature / refactor).
- Natural-language input now auto-routes; the classifier is rule-based (Iron Law #2 — no LLM inference for routing).

**State schema:**
- All features must use `<task>.state.json` (schema 2.3.0). Any residual `state/workflow.json` is reported as `orphan` by `scripts/feature-version-check.mjs`.

**Terminology:**
- "Step" → "skill"
- "Workflow engine" now refers to the skill-composition engine, not the step-engine.

---

### Migrations

- Feature dirs with only a `state/workflow.json` are flagged as `orphan` by `feature-version-check.mjs`. To migrate: move to a v2 `<task>.state.json` via `scripts/state-schema.mjs` `createInitialState(...)`.
- Invocations of the retired `build` command should be replaced with `/implement` (lightweight build on existing code) or `/plan` (greenfield / refactor that needs planning).
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
