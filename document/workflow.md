---
title: Smelter Workflow
type: canonical
lang: en
tags: [smelter, workflow, skill-composition, producer-routing, tdd, e2e, auto-confirm]
status: canonical
version: 0.55
created: 2026-04-19
updated: 2026-04-29
translations: document/workflow.ko.md
---

`codex-for-claude-code` is released as an independent companion package. Do not treat its `package.json` or `plugin.json` version as part of the Smelter release version line.

# Smelter Workflow — v0.55 Contract/FSM Model

> Smelter v0.55 separates **UserMode**, **TaskType**, **Step**, and **Guard**. The LLM proposes intent; the harness owns routing, permissions, transitions, recovery, and verification truth.
> Workflow topology lives in `modes/workflow.yaml`; hooks execute that config and enforce generic runtime safety rules.
> Only `workflow-*` skills are subject to mode whitelist; utility skills are freely callable.

---

## 0. Iron Laws

| # | Law | Meaning |
|---|-----|---------|
| 1 | **Never halt after failure** | Agents cannot declare "stop after fail". The only halt is an explicit user stop (see §11 auto-confirm hook). |
| 2 | **No evasion** | Fail cannot be papered over as "known limit" or self-declared complete. The agent keeps routing via producer chain until the problem is resolved. |
| 3 | **No self-failure** | Skills cannot emit "I can't do it". `result ∈ { pass, fail }` only. |
| 4 | **No retry** | The mechanical `max_retry` concept is removed. Instead, failures route to the producer to fix the upstream cause and advance — this is forward motion, not retry. |
| 5 | **File is truth** | Skill completion is recognized only via **file-verifiable postconditions**. Self-claims are rejected. Enforced by `scripts/state-validator.mjs::validateEvidenceIntegrity()` invoked from `writeState()`: every `completed_stages` entry must have a matching `events[].result === 'pass'` carrying `evidence.path` pointing at an existing file. Forged completions throw at write time. |
| 6 | **Workflow whitelist is user-decision** | Only `workflow-*` skills are constrained by the mode's `allowed_skills`. If a workflow skill outside the current mode is needed, the agent does not decide — it **requests a user-gated mode upgrade**. Utility skills (`ui-ux-pro-max`, `copywriting`, `claude-api`, ...) are **freely usable** with no constraint. |
| 7 | **Independent queues, shared sessions, specialist agents** | Each task's **Queue** is independent. Multiple tasks may share a session. Tasks may delegate to **specialist agents** (frontend, backend, security, ...). **Team Agents** (multi-agent collaboration) are supported. |
| 8 | **Scoped testing** | Only tests related to changed files run by default. Full regression only at `workflow-human-check` with explicit request. |

---

## 0-bis. Per-Skill Enforcement Language (Superpowers-style)

Every `workflow-*/SKILL.md` now carries the same enforcement layout — imported from `obra/superpowers` and adapted to Smelter's state machine. Authors editing a skill must preserve all six blocks.

### Required sections (in order)

| Section | Purpose | Example (workflow-coding) |
|---------|---------|---------------------------|
| **Overview** | 1–2 sentence core principle + spirit clause + announce | `**Core principle:** Tests passing is not done...` |
| **The Iron Law** | One-line capitalized rule in a fenced code block | `TESTS GREEN ≠ DONE. NO COMPLETION CLAIM WHILE STAGE < workflow-human-check` |
| **Red Flags - STOP** | Rationalization → Reality table | "Tests pass so I'm done" → "5 more skills must run" |
| **Rationalization Prevention** | Excuse → Reality table | "Should work now" → "Run the post-gate verifications" |
| **Common Failures** *(review & completion skills)* | Claim → Requires → Not Sufficient table | `"Bug fixed"` requires `workflow-e2e reproduces symptom and sees fix` |
| **Terminal State — Required Next Skill** | Explicit next-skill name + forbidden actions | `REQUIRED NEXT SKILL: workflow-agent-review` |

### Writing rules

- **Spirit clause:** every skill contains the sentence *"Violating the letter of this rule is violating the spirit of this rule."* — anti-loophole
- **Announce at start:** every skill prescribes a single-sentence verbal commitment so the model cannot silently skip
- **Terminal State:** every non-terminal skill names the exact next skill. No branching words ("may", "could", "depending on"). The only skill with `halts_session: true` is `workflow-human-check` — every other skill lists explicit forbidden actions including "offer A/B/continue choices", "stop the session", "ask 'shall I continue?'"
- **Forbidden Responses:** review skills and `workflow-human-check` list phrases that are banned ("You're absolutely right!", "Great point!"), aligning with the `feedback_precision` memory

### Why this exists

Prior to v2.4.1, skills described technical gates but not linguistic gates. The model could see "tests pass" and declare completion without triggering any hook — because the hook fires on explicit STOP or tool-call, not on self-narrative. The enforcement language makes the linguistic act of "claiming done" itself visible to the Critic Watchdog (§12-8) and gives the model explicit patterns to refuse.

The pattern is imported from `obra/superpowers` (brainstorming, using-superpowers, verification-before-completion, test-driven-development, systematic-debugging, subagent-driven-development). Smelter adapts it to the state machine + mode routing + Pattern B/C/D topologies.

---

## 1. Execution Model

### 1-1. Structure

```
┌─────────────┐     ┌──────────┐     ┌───────────────────┐
│   Command   │ ──▶ │   Mode   │ ──▶ │  workflow-* Skill │
│   (user)    │     │whitelist │    │   (atomic)        │
└─────────────┘     └──────────┘     └───────────────────┘
                                              ▲
                                              │ (whitelist-free)
                                     ┌─────────────────────┐
                                     │  Utility Skills     │
                                     │  (ui-ux-pro-max,    │
                                     │   copywriting, ...) │
                                     └─────────────────────┘
```

- **Command**: user entry point (hint; auto-routing takes precedence).
- **Mode**: allowed `workflow-*` skill set + initial skill.
- **Workflow Skill**: `workflow-*` prefix. Subject to mode whitelist. Mutates state.
- **Utility Skill**: no prefix. Free use. No state mutation.

### 1-2. Commands & Auto-Routing

Commands are **hints**; the default is **entry auto-routing** from natural-language input. Users can invoke explicit slash commands, but when an utterance arrives the classifier assigns a mode at entry.

#### Entry classifier (v0.4)

`scripts/mode-classifier.mjs::classify(input, { cwd, sessionId })` runs the layers in order; the first match wins.

| # | Layer | Implementation | Fires when |
|---|-------|----------------|------------|
| 1 | Explicit slash command | `EXPLICIT_COMMANDS` table + word-boundary check | prompt starts with `/brainstorm`, `/fix`, `/infra`, `/implement`, `/explore`, `/verify`, or `/dobby` followed by EOL, whitespace, `:`, or `-` |
| 2 | Passthrough | `PASSTHROUGH_PATTERNS` (anchored) | entire prompt matches pure git/shell verb-first (e.g. `git commit`, `커밋해`, `push 좀`) |
| 2b | Local high-confidence write intent | `classifyHighConfidenceEditIntent` | terse implementation orders such as `select만 적용`, concrete rich-text editor UI requests, and feature/UI-surface modification requests such as `AI panel 기능 수정해줘` or `특정 기능 수정` |
| 3 | LLM classifier | `scripts/lib/subagent-classifier.mjs::classifyMode` via OAuth Claude CLI | any remaining natural-language prompt |

The Layer 3 LLM returns `{ mode, chained_modes, passthrough, trigger }`. Cached per `{sessionId, prompt-hash}` under `.smt/state/mode-classifier-cache.json`. `classifyMode` normalizes the raw trigger with an `llm:` prefix **on write** so subsequent reads pass `isValidModeCacheEntry`'s `llm:`/`stub:` prefix whitelist; without this normalization every call re-invokes Haiku and doubles latency per prompt. The detector also forwards the full classification object into `seedWorkflowState` (via `detectNaturalLanguageCommand`'s return value) to avoid a redundant second Haiku call during surface extraction — the earlier double call could time out and silently skip state seeding, leaving the mode banner printed without an active workflow. If `passthrough === true` but the current session already has an active non-terminal workflow pointer (`.smt/state/active-feature-<sessionId>.json`), `keyword-detector.mjs` overrides the passthrough hint and keeps the turn inside workflow continuation. Transcript-paste passthrough remains exempt unless the pasted log also contains a narrow current-turn directive such as `이걸 고쳐줘` or `구현 진행해`; those directives seed `fix`/`implement` state instead of dropping the workflow.

`UserPromptSubmit` is a routing gate, not the final authority for ambiguous write-mode choice. It may seed a best-effort mode and inject a mandatory entry prompt, but the main agent may use read/search tools first and then choose the correct `Skill(fix|implement|infra)` before any source edit. Local high-confidence write intents deliberately run before the LLM classifier so obvious feature/UI-surface implementation orders seed `/implement` immediately instead of waiting for the first source-edit block; prompts with explicit bug/error signals continue to the normal classifier path so they can route to `/fix`. If that agent-selected write mode differs from an unstarted seeded write state, `workflow-state-seeder.mjs` creates a fresh state for the selected mode (`write-mode-correction`). `/dobby` is excluded from agent-selected correction and remains slash-only/user-initiated. Once the workflow has evidence (`events`, `completed_stages`, `test_cycles`, or `active_feedback`), cross-mode switching no longer discards progress and requires an explicit new workflow/user-gated path.

If the seeded workflow has not entered a skill yet and the assistant responds with a plan/option/confirmation question, the Stop hook treats that as pre-workflow drift. It blocks the stop and injects `Skill(skill: '<current_stage>')` as the next required tool call. This preserves the useful main-agent read/search phase while preventing the agent from ending at “Confirm install + approach?” before `workflow-investigate` has produced evidence.

If a non-human-check workflow turn asks the user how to proceed because a tool was “blocked by current phase” or “requires phase”, the Stop hook treats that as workflow drift, not a real user decision. It routes back to `workflow-coding` when available, otherwise re-enters the current workflow skill. External blockers such as credentials and destructive-operation confirmation remain legitimate user halts.

**Failure policy:** if Layer 3 throws (LLM outage, invalid response, or tampered cache dropped by the validator), the error **propagates**. There is no regex fallback. Callers treat a throw or `null` return as "no classification" and skip state seeding — the prompt flows through unseeded.

**Empty input** returns `null` (no classification, no exception).

**Principles**:
- The classifier runs **only at entry**. The main agent can correct an unstarted seeded write mode by invoking the correct command skill before editing; mid-workflow mode changes after evidence exists are user-gated (upgrade/new workflow).
- Layers 1, 2, and 2b are deterministic regex. Layer 3 is LLM-based (OAuth). No fallback — LLM failures surface as errors.
- An explicit slash command **overrides** the classifier.

**Source of truth**: `scripts/mode-classifier.mjs` — pure module exporting `classify(input, opts)`. `scripts/keyword-detector.mjs` (the UserPromptSubmit hook) imports it at step 2 of command resolution and passes `{ cwd, sessionId }` so per-session LLM-cache isolation holds. On classifier throw, the detector returns `null` and the prompt flows through without state seeding.

**Compound intents (chained modes)**: when the LLM detects a connective-joined chain (e.g., "분석하고 구현해줘" → `[explore, implement]`), it populates `chained_modes`. `keyword-detector` writes this into `.state.json` at entry; `auto-confirm.decide()` picks it up at the `mode_transition` signal and auto-advances via `consumeNextChainedMode` without a user prompt (`chain_advance`). Entry mode is always `chained_modes[0]`. Transition-time stage reuse is declared in `modes/workflow.yaml → transition_adoptions` and executed by `workflow-transition-adoption.mjs`; hooks do not hard-code mode-specific reuse topology.

**Testing**: set `SMELTER_MODE_CLASSIFIER_MODULE=<path>` to replace Layer 3 with a deterministic stub (see `scripts/lib/__fixtures__/mode-classifier-stub.mjs`). Used by `mode-classifier.test.mjs`, `keyword-detector.test.mjs`, and `workflow-scenarios.test.mjs` SCENARIO 13 so test assertions do not depend on live LLM availability.

#### Mode summary

| Mode | Entry skill | Pipeline | Purpose |
|------|-------------|----------|---------|
| `brainstorm` | `workflow-investigate` (deep) → `workflow-brainstorm` | `planning_only` | Ideation & planning. No code changes. Produces `brainstorm.md` + `tasks.md`. |
| `fix` | `workflow-investigate` | `fix` / `fix_simple` | Bug / logic repair. `target_type ∈ {text, design}` routes to `fix_simple`; everything else (`bug_fix`) stays on the 10-skill `fix` pipeline. |
| `implement` | `workflow-investigate` | `full` | Feature development on existing code with implementation-plan trade-off decisions. |
| `infra` | `workflow-investigate` | `infra_ops` | Infrastructure / IaC operations with inventory, risk planning, approval, execution evidence, and verification. |
| `explore` | `workflow-investigate` | `explore_only` | Static read only (맥락·근거 파악). Exits via mode transition. |
| `verify` | `workflow-verify` | `verify_only` | Non-modifying verification (test run + static inspection + real-interface E2E). |
| `dobby` | `workflow-human-check` | `dobby_only` | Explicit no-pipeline escape hatch. Slash-only. |

v0.4 (2026-04-26): the read-only user mode is `explore` and the slash command is `/explore`; the retired investigate command is not an alias. The planning mode is `brainstorm`; retired think, plan, and simple-fix commands are not aliases.

#### v0.4 Contract Bridge

Runtime state files keep the established skill-executor fields (`mode`, `allowed_skills`, `current_stage`, `completed_stages`) while also seeding v0.4 contract fields as the permission and step source for live hooks:

| UserMode | TaskType | Step flow |
|---|---|---|
| `brainstorm` | `design` | INTENT → DISCOVERY → PLAN → DONE |
| `explore` | `read` | INTENT → DISCOVERY → DONE |
| `verify` | `verify` | INTENT → DISCOVERY → VERIFY → HUMAN_CHECK → DONE |
| `infra` | `infra` | INTENT → DISCOVERY → PLAN → EXECUTE → VERIFY → HUMAN_CHECK → DONE |
| `implement` | `write` | INTENT → DISCOVERY → PLAN → TEST_DESIGN → EXECUTE → VERIFY → HUMAN_CHECK → DONE |
| `fix` | `write` | INTENT → DISCOVERY → PLAN → TEST_DESIGN → EXECUTE → VERIFY → HUMAN_CHECK → DONE |
| `dobby` | `freeform` | INTENT → EXECUTE → HUMAN_CHECK → DONE |

`state-schema.createInitialState()` writes `user_mode`, `task_type`, `step`, `step_flow`, and `allowed_actions`. `pre-tool-enforcer.mjs` imports `workflow-v4-guard.mjs` and evaluates source edits against `(task_type, step, evidence)` before any legacy fallback. For `task_type=write`, test files (`*.test.*`, `*.spec.*`, or paths under `test/`, `tests/`, `spec/`, `e2e/`) are writable only during `TEST_DESIGN` when `write_test` is allowed; product source files are writable only during `EXECUTE` after executable specification RED evidence exists (`test_red`, `tdd_adopted`, `tdd_exempt`, or legacy RED `test_cycles[]`). `critic-watchdog.mjs` R05 uses the same `hasTddEntryEvidence()` predicate as the phase gate, so post-tool enforcement accepts RED cycles, TDD adoption, and TDD-exempt surfaces consistently instead of inspecting only legacy `test_cycles[]`. For `task_type=infra`, infrastructure/IaC source edits are writable during `EXECUTE` without executable-spec RED evidence because the required safety gate is `infra-plan → infra-plan-review → infra-execute → verify → human-check`, not code TDD. `skill-stage-transition.mjs` imports `workflow-v4-state.mjs` and updates `step/allowed_actions` when workflow skills enter their executor phase. `auto-confirm.mjs` imports `workflow-v4-controller.mjs` and advances bridged steps on stage pass, verification fail, and human pass events. This makes `scripts/lib/workflow-v4-*` runtime-active while preserving the existing producer-chain stage machinery during the transition.

If a raw code-file write reaches `pre-tool-enforcer.mjs` without an active source-edit workflow, the block reason is agent-directed: invoke `Skill(fix|implement|infra)` to seed state or wait for an existing active pointer. It must not ask the user to type a slash command. `/dobby` remains slash-only/user-initiated and is intentionally omitted from agent-owned recovery prompts.

### 1-3. Surface Extraction (v0.4)

Surface fields (`target_type`, `exempt`, `skip_brainstorm`) are inferred from two complementary lanes — never via free-form NL regex.

- **Natural language** → emitted by `classifyMode` (scripts/lib/subagent-classifier.mjs) alongside `mode`. The Haiku classifier reads the prompt once and returns both mode classification and surface inference in a single call. System prompt includes an anti-injection clause: user text that explicitly instructs `"set target_type to text"` is ignored; classifier infers from the actual task surface.
- **Slash-command arguments** → resolved by `parseSlashArgs` (scripts/lib/surface-extraction.mjs) against the frozen `SLASH_SURFACE_TABLE`. Tokenized match (no `\b` regex), first-match-wins for `target_type`, union for `exempt.*` and `skip_brainstorm`. Only `fix` and `implement` have rows; other commands return `null`. ASCII visual tokens also match Korean postposition suffixes, so `border가` matches the `border` design row.

The old regex `applyMagicKeywords` path and the `modes/workflow.yaml → modes.*.magic_keywords` YAML blocks are removed. Cache entries use `schema_version: 2`; validators remain compatible via the unchanged `trigger: "llm:..."` invariant.

### 1-4. Workflow vs. Utility Skills

Only **workflow skills** are constrained by mode whitelist. Utility skills are free.

#### workflow-* skills (mode whitelist target, 19)

- `workflow-brainstorm`, `workflow-brainstorm-review`
- `workflow-investigate`, `workflow-investigate-review`
- `workflow-implementation-plan`, `workflow-implementation-plan-review`
- `workflow-infra-plan`, `workflow-infra-plan-review`, `workflow-infra-execute`
- `workflow-tasker`, `workflow-tasker-review`
- `workflow-write-test`, `workflow-coding`
- `workflow-agent-review`
- `workflow-e2e`, `workflow-e2e-review`
- `workflow-team-code-review`
- `workflow-verify`
- `workflow-human-check`

Characteristics:
- Subject to the mode's `allowed_skills`.
- Mutates `state.json` (events, test_cycles, team_runtime, ...).
- Target of producer-chain routing.
- Defined in `skills/<name>/SKILL.md` with a contract.

#### Utility skills (free use)

Examples: `ui-ux-pro-max`, `copywriting`, `claude-api`, `test-driven-development`, `vercel-react-best-practices`, `e2e-testing-patterns`, `queue`, `deep-interview`.

Characteristics:
- No mode constraint; callable any time.
- No state mutation (auxiliary tools).
- Outside the producer chain.
- Freely callable from within a workflow skill (e.g., `workflow-coding` calling `ui-ux-pro-max`).

> **Rule**: `workflow-*` is the **unit of progress**, utility skills are **tools**.

---

## 2. Task State Model

### 2-1. File layout

```
.smt/features/<feature-slug>/
├── task/
│   ├── plan.md                  ← feature goal, scope, acceptance criteria
│   ├── <task-name>.md           ← human-readable task record
│   └── <task-name>.state.json   ← machine state (single source)
├── decisions.md
└── artifacts/                   ← e2e video, screenshots, logs, transcripts, IO samples
```

### 2-2. State JSON schema

```json
{
  "schema_version": "0.4.0",
  "task_id": "fix-empty-input-bug",
  "mode": "fix",
  "user_mode": "fix",
  "task_type": "write",
  "step": "EXECUTE",
  "step_flow": ["INTENT", "DISCOVERY", "TEST_DESIGN", "EXECUTE", "VERIFY", "HUMAN_CHECK", "DONE"],
  "allowed_actions": ["read", "write_source", "run_test"],
  "allowed_skills": [
    "workflow-investigate", "workflow-investigate-review",
    "workflow-write-test", "workflow-coding",
    "workflow-agent-review",
    "workflow-e2e", "workflow-e2e-review",
    "workflow-human-check"
  ],
  "current_stage": "workflow-coding",
  "completed_stages": ["workflow-investigate", "workflow-investigate-review", "workflow-write-test"],
  "chained_modes": [],
  "created_at": "2026-04-19T10:00:00Z",
  "updated_at": "2026-04-19T10:45:00Z",
  "target_type": "bug_fix",
  "surface": ["ui"],
  "exempt": { "tdd": false, "e2e": false },
  "team_runtime": { /* per-skill runtime state */ },
  "events": [ /* append-only audit log */ ],
  "test_cycles": [ /* TDD RED→GREEN record */ ],
  "active_feedback": [ /* unresolved review feedback */ ],
  "sub_tasks": []
}
```

Validated invariants:
- `allowed_skills` ⊆ the 19 workflow skills.
- `events[].declarer` ∈ `{hook, user}` (skill-declarer forbidden per Iron Law #3).
- `events[].cause` ∈ the fixed enum (see §6-3).
- `team_runtime[skill].rounds[i]` (when present) has `focus` ∈ `{omission, contradiction}` and `result` ∈ `{null, pass, fail}`.
- `active_feedback[i].target_skill` ∈ workflow skills; `resolved` boolean.

### 2-3. State initialization

On every workflow command (`/brainstorm`, `/fix`, `/infra`, `/explore`, `/implement`, `/verify`, `/dobby`), `scripts/keyword-detector.mjs` writes `.smt/features/<slug>/task/<slug>.state.json` using `state-schema.createInitialState()` plus `allowed_skills` loaded from `modes/workflow.yaml`, and also writes a session-scoped active-feature pointer. Most modes start at `step: INTENT`; `/dobby` is the explicit freeform exception and is seeded at `step: EXECUTE` so direct source edits are allowed before its terminal human-check gate. The PreTool stage-skill gate treats active `dobby` state as pass-through, so manual recovery commands such as `git checkout -- <path>` are not blocked by a missing `Skill(workflow-human-check)` load. **`current_stage` is intentionally seeded as `null` or the mode entry skill depending on the seeding path** — the agent must invoke the mode's entry workflow skill to advance the executor bridge where a workflow pipeline exists. `Skill(/implement)` and other slash-prefixed command-skill invocations are normalized to the same command id as `Skill(implement)`, and entry-command transition advances the v0.4 step to the entry workflow skill's phase. Combined with R12 (critic-watchdog), this enforces the canonical skill-entry workflow. The legacy `workflow.json` in `.smt/features/<slug>/state/` is retained for transition diagnostics but `.state.json` is now the enforcement source of truth.

**Gate enforcement stack** (v0.4 contract bridge):
1. `scripts/pre-tool-enforcer.mjs` — PreToolUse Write/Edit guard on `.state.json` path. Agents cannot directly mutate state. Escape hatch `SMT_HOOK_WRITE=1` is reserved for hook scripts. For source-file edits, the hook imports `workflow-v4-guard.mjs` and enforces `task_type` + `step`: `read/design/verify` cannot edit source, `write` can edit source only at `EXECUTE` with executable specification RED evidence (`events[].type === 'test_red'`, `events[].type === 'tdd_adopted'`, `events[].type === 'tdd_exempt'`, or legacy `test_cycles[]` fail evidence), `infra` can edit source only at `EXECUTE` after infra plan/review entry, and `freeform` can edit source only at `EXECUTE`. The hook resolves the nearest ancestor `.smt` root before reading active workflow pointers, so running tools from a nested repo/subdirectory reuses the parent workflow state instead of false-blocking and triggering diagnostic loops. It still enforces the **commit gate** for write/infra/freeform work: a Bash `git commit` is blocked unless the active state shows a `workflow-human-check` pass event or `completed_stages` includes `workflow-human-check`. A `current_stage === 'done'` value is NOT a pass shape.
2. `scripts/skill-stage-transition.mjs` — PostToolUse `Skill` matcher. Invoking an allowed workflow skill auto-writes the pass event + updates `current_stage` + (for non-deferred skills) appends `completed_stages`. It also updates bridged v0.4 `step/allowed_actions`: investigate → `DISCOVERY`, brainstorm/tasker/infra-plan → `PLAN`, write-test → `TEST_DESIGN`, coding/infra-execute → `EXECUTE`, verify/e2e/review → `VERIFY`, human-check → `HUMAN_CHECK`. Deferred skills (`workflow-e2e`, `workflow-human-check`, `workflow-agent-review`, `workflow-team-code-review`, `workflow-verify`, `workflow-e2e-review`) set `current_stage` and v0.4 step only. If `workflow-write-test` is entered with an already dirty worktree containing both source and test changes, the hook records `events[].type === 'tdd_adopted'` instead of forcing a retroactive RED loop. For design/text targets or explicit `exempt.tdd`, it records `events[].type === 'tdd_exempt'` so CSS/copy-style work can proceed without fake RED evidence.
3. `scripts/auto-confirm.mjs` — Stop hook decision controller. It imports `workflow-v4-controller.mjs` and applies deterministic v0.4 transitions: pass advances along `step_flow`, verification fail moves to `RECOVER`, and human pass moves `HUMAN_CHECK` to `DONE`. Producer-chain routing remains the skill-level executor path.
4. `scripts/state-validator.mjs` — `validateEvidenceIntegrity()` wired into `state-schema.writeState()`. Every `completed_stages` entry must have a pass event with existing `evidence.path`. Forged stages throw.
5. `critic-watchdog.mjs` R13 — Bash-based bypass defense-in-depth. It blocks real protected-state write targets (`node -e`/`python -c` writes, redirects, mutating shell primitives) but allows read-only inspection/formatting such as `cat .smt/...state.json | python -m json.tool`. Skipped when `SMT_HOOK_WRITE=1`.
6. `keyword-detector.mjs::shouldCreateNewFeature` — natural-language follow-ups reuse the session's active feature instead of creating a new slug per prompt. New feature is only created for slash commands, explicit `새 feature` / `new feature` phrases, or when no in-progress pointer exists. Per-session pointer `.smt/state/active-feature-<session_id>.json` keeps concurrent sessions isolated.
7. `scripts/lib/workflow-transition-adoption.mjs` — deterministic execution engine for `modes/workflow.yaml → transition_adoptions`. It validates declared completed stages via canonical artifact evidence, copies artifacts into a new task when the policy asks for it, and advances `current_stage` to the next uncompleted skill when configured. Agent prose such as "already investigated" is never sufficient.

`scripts/auto-confirm.mjs::decide` is the Stop-hook first-stage enforcement point. If an active workflow has `current_stage: null` and an `allowed_skills` chain, it returns `enter_skill` for `pickNextStage(state)` before the proceed/halt classifier can accept user-facing confirmation questions. This is especially important for `/dobby`, whose only workflow skill is `workflow-human-check`: the main agent must enter terminal human review before git commit/push/merge side effects can be attempted and blocked later by `pre-tool-enforcer.mjs`. At `workflow-human-check`, the skill asks one native `AskUserQuestion` with `rework`, `complete-commit-current`, `complete-new-branch-pr`, `hold`, and `upgrade`; either `complete-*` action writes `results.md`, lets `finalize-human-check.mjs` record the pass shape for `fix` / `implement` / `infra` / `dobby`, then runs only the selected git action without a second git-options prompt.

`scripts/mode-classifier.mjs` keeps a narrow local pre-route for short edit intents before invoking the LLM classifier: prompts shaped like `<target>만 적용/반영` are treated as `/implement` with `target_type=extend_existing` and `skip_brainstorm=true`. This avoids the wasteful path where terse work orders such as `select만 적용` pass through unseeded and only discover the missing workflow at the first source edit.

For `/dobby`, the user-typed slash command seeds freeform execution at `step: EXECUTE`; the injected `Skill(dobby)` is only allowed to load that already-active dobby command context and is not a human-check entry. `scripts/skill-stage-transition.mjs` therefore leaves dobby command-skill state at `step: EXECUTE` with `current_stage: null`; `workflow-human-check` is entered by the Stop hook after the freeform edit/action turn. Agent-owned `Skill(dobby)` recovery is blocked by `state-contract-injector.mjs` / `workflow-state-seeder.mjs`, so a non-dobby blocker cannot be bypassed by reseeding dobby without an explicit user `/dobby` command.

`scripts/pretool-stage-gate.mjs` records `Skill(workflow-*)` loads against the target workflow skill epoch (`<slug>::<skill>`) when the skill is allowed by the active state. This matches hook order: PreToolUse sees the Skill call before `skill-stage-transition.mjs` moves `current_stage`, so recording against the old current stage would make the following stage's first write (for example `workflow-human-check` writing `results.md`) look unloaded. Slash-prefixed command skill invocations such as `Skill(/implement)` are normalized; when they match the active mode, they are recorded as a load of the active entry stage (`workflow-investigate` for implement/fix/explore). Non-workflow, non-command, mismatched-command, or non-allowlisted skills fall back to the current-stage epoch. `results.md` is additionally pinned to the `workflow-human-check` active stage, so a prior stage's valid load cannot authorize terminal result writes before the transition occurs. MCP code search is provided by Semble (`mcp__semble__search`, `mcp__semble__find_related`) and is treated as read-only discovery rather than a mutating MCP surface.

`scripts/state-contract-injector.mjs` also enforces the executable-spec boundary at the Skill layer: `workflow-write-test → workflow-coding` is blocked until executable specification RED evidence exists (`events[].type === 'test_red'`, `events[].type === 'tdd_adopted'`, `events[].type === 'tdd_exempt'`, or legacy `test_cycles[]` with `run_result: 'fail'` from an added/modified case). This prevents the confusing intermediate state where `workflow-coding` enters `EXECUTE` but the first source edit is immediately blocked by the v0.4 guard for missing RED evidence. RED evidence is based on the actual Bash tool exit code; commands must not append `; echo "exit=$?"` because that turns a failing test into a successful Bash command and leaves no trusted RED event to record. The PostToolUse RED recorder recognizes direct test runners such as `node --test`, package test scripts such as `pnpm test` / `pnpm test:run`, and Vitest invocations such as `pnpm vitest run` / `vitest run`; it accepts exit codes from structured hook payload fields (`exit_code`, `exitCode`, or `status` under `tool_response`, `toolResponse`, `tool_output`, `toolOutput`, `output`, or the top-level payload) and, for known test commands only, Claude Bash failure text such as `Error: Exit code 1`. It still rejects masked `exit=...` stdout because that is not the tool's actual exit code. When RED is not recorded because trusted exit evidence is missing, the hook diagnostic explicitly forbids claiming RED was recorded, forbids `Skill(skill: 'workflow-coding')`, and tells the agent to rerun the failing executable spec command directly as the final Bash process with no pipes, redirects, `tail`, or `echo`. It also normalizes UI-decorated Bash tool labels and resolves the nearest ancestor `.smt` root before writing the RED event. When session-scoped and unscoped active pointers conflict, RED recording selects a same-session state that is actually recordable (`task_type=write` and `step ∈ {TEST_DESIGN, EXECUTE}`) instead of blindly using the first pointer. If a hook payload has no resolvable session id and the unscoped pointer is stale, RED recording scans session-scoped pointers and uses the newest recordable write-test state.

    **Executable-spec terminology:** for `workflow-write-test`, RED evidence means executable specification RED evidence. The failing command should exercise the behavior spec produced from concrete examples, not a placeholder test or implementation-detail assertion.

    **Session-isolation contract:** all consumer readers — `auto-confirm.findActiveTaskState`, `skill-stage-transition.resolveActiveState`, `critic-watchdog.readActiveState` — treat the per-session pointer as strictly authoritative when `sessionId` is present. None fall back to the non-scoped `active-feature.json` or to an mtime-latest scan of `features/*/task/*.state.json`. A fresh session that inherits a prior session's non-scoped pointer resolves to "no active state" and halts cleanly instead of advancing through another session's stages.

    **Hook session-id resolution:** hook scripts resolve the effective session id via `scripts/lib/session-paths.mjs::resolveHookSessionId(input)`, in this order: `input.session_id`, `input.sessionId`, then `process.env.SMELTER_SESSION_ID`. This keeps PreToolUse, PostToolUse, Stop, and UserPromptSubmit hooks on the same session-scoped pointer even when a Claude hook payload omits `session_id`. The unscoped `active-feature.json` is used only when no valid input/env session id exists.

**Classifier-subprocess re-entrancy guard**: when `lib/subagent-classifier.mjs` spawns the Claude CLI to run the Haiku classifier, that subprocess inherits the parent hook chain. `keyword-detector.mjs` detects this via `process.env.SMELTER_CLASSIFIER_SUBPROCESS === '1'` and bails out before any state-seeding side effect. Without this guard, slug derivation would use the classifier's system prompt as if it were user input, polluting the state store with spurious feature slugs over multiple sessions.

**Slug preamble pruning (defense-in-depth)**: `keyword-detector.mjs::deriveSlug` also strips system-prompt preambles — `You are a …`, Korean 당신은/너는, `Skill:/Role:/Context:` labels, echoed "successfully loaded skill" banners, and `[MAGIC KEYWORD: …]` tags — and drops leading filler tokens (a/an/the/for/to/of/…). So even if the re-entrancy guard is somehow bypassed (nested subprocess, env var dropped), a leaking classifier prompt produces a domain-reflective slug like `command-classifier-for-a-cli-tool-called-smelter-…` instead of `you-are-a-command-classifier-for-a-cli-tool-…`.

### 2-4. Token optimization

- Prompt injection uses only the **last 5** events.
- `test_cycles` is filtered to files related to `current_stage`.
- `active_feedback` is filtered to `resolved: false`.
- `state-contract-injector.mjs` keeps the per-`workflow-*` state-write reminder compact: it preserves the same guard instructions but avoids re-injecting long hook architecture prose on every Skill call.
- High-traffic workflow skill prompts (`workflow-coding`, `workflow-e2e`, `workflow-human-check`) stay checklist-sized and are guarded by `scripts/skill-prompt-budget.test.mjs`.
- Diff inspection defaults to `git diff --stat` and `git diff --name-only`; use path-scoped `git diff -- <path...>` for details. Avoid whole-repo `git diff` after large artifacts unless preparing a commit/PR summary.
- Hook continuation prompts inject only the next required command or Skill target. They must not replay prior assistant text or user prompt text into `additionalContext`; the transcript already contains that content.
- The rest stays on disk but outside the context window.

---

## 3. Workflow Skill Registry (16 skills)

> Skill definitions live in a single location (`skills/<name>/SKILL.md`). Shared across modes.

| # | Skill | Consumes | Produces | Notes |
|---|-------|----------|----------|-------|
| 1 | `workflow-brainstorm` | trigger prompt | `brainstorm.md` | `depth: deep\|light` |
| 2 | `workflow-brainstorm-review` | `brainstorm.md` | `brainstorm-review.md` | pass/fail/reshape |
| 3 | `workflow-investigate` | brainstorm.md or trigger | `investigation.md` | static read (structure, references) |
| 4 | `workflow-investigate-review` | `investigation.md` | `investigation-review.md` | pass/fail/reshape |
| 5 | `workflow-implementation-plan` | investigation.md (+brainstorm/tasks optional) | `implementation-plan.md` | code-based plan, reuse/new-tech options, trade-offs, user technical decision when needed |
| 6 | `workflow-implementation-plan-review` | `implementation-plan.md` | `implementation-plan-review.md` | evidence / trade-off / queue review |
| 7 | `workflow-tasker` | investigation.md (+brainstorm.md) | `tasks.md`, `target_type`, initial `team_runtime` | compact scope checklist for `/fix` and `/brainstorm` |
| 8 | `workflow-tasker-review` | `tasks.md` | `tasks-review.md` | works / omissions / verification check; pass/fail/reshape |
| 9 | `workflow-write-test` | `implementation-plan.md` or `tasks.md` | executable spec tests (RED), `test_cycles` entries | Specification by Example / BDD / ATDD; surface-based exemption applies |
| 10 | `workflow-coding` | `*.test.*` (RED) or `active_feedback` | `src/**` changes | implementation |
| 11 | `workflow-agent-review` | `src/**` diff | `agent_review.md`, `## Risks` updates | Pattern B Dual Adversarial (code-reviewer + security-reviewer). "no security surface" → A. |
| 12 | `workflow-e2e` | built `src/**` | `artifacts/` (video / screenshots / logs / transcripts / IO samples) | **Drives the real interface** (browser, subprocess, HTTP port, DB engine, hook pipe). Test-runner stdout alone is NOT a valid pass. |
| 13 | `workflow-e2e-review` | `artifacts/` | `e2e_review.md` | scenario coverage / artifact quality |
| 14 | `workflow-team-code-review` | whole change | `team_review.md` (severity-tagged) | **Multi-agent 95% consensus** |
| 15 | `workflow-verify` | current codebase (no RED required) | `verify_report.md` (Phase 1 tests + Phase 2 static inspection + Phase 3 E2E interface) | Entry skill of `/verify`. Non-modifying. Not a review skill — no Multi-Pass rounds. |
| 16 | `workflow-human-check` | all artifacts | user decision (`rework` / `complete` / `hold` / `upgrade`) | final gate |

---

## 4. Mode Definitions (v0.4)

v0.4 exposes six user modes: `brainstorm`, `implement`, `fix`, `explore`, `verify`, and `dobby`. The workflow config is a single file, and verification uses one global 2-round policy.

- `modes/workflow.yaml` — single source of truth: skills + pipelines + modes + target_type_routing + transition_adoptions + verification_rounds + command_aliases.
- Loader: `scripts/lib/workflow-loader.mjs`. Consumers: `keyword-detector.mjs`, `skill-stage-transition.mjs`.

### v0.4 pipelines

| Pipeline | Skills | Used by |
|---|---|---|
| `full` | 11 (investigate → implementation-plan → ... → human-check) | `/implement` for all target types |
| `fix` | 10 (investigate → investigate-review → tasker → tasker-review → write-test → coding → agent-review → e2e → e2e-review → human-check) | `/fix` default for all `bug_fix` |
| `fix_simple` | 4 (investigate → coding → e2e → human-check) | `/fix` for `text` (텍스트 수정) and `design` (디자인 수정) — the only two surfaces that route here |
| `planning_only` | 6 | `/brainstorm` |
| `explore_only` | 2 | `/explore` |
| `verify_only` | 4 | `/verify` |

v0.4 removes `extend_light`: all `/implement` work uses the same code-based implementation-plan pipeline. `extend_existing` is planning context, not a lighter verification path.

### v0.4 target_type dispatch (`/fix` and `/implement`)

`workflow-investigate` determines `target_type`. `workflow-loader.selectPipeline()` picks the pipeline with mode-specific gating:

| mode | target_type | pipeline |
|------|-------------|----------|
| `/fix` | `text` / `design` | `fix_simple` |
| `/fix` | `bug_fix` | `fix` |
| `/fix` | `extend_existing` | `upgrade_required` → escalate to `/implement` |
| `/fix` | `new_feature` / `refactor` / `migration` | `upgrade_required` → escalate to `/implement` or `/brainstorm` |
| `/implement` | `extend_existing` | `full` |
| `/implement` | any other / none | `full` (declared default) |

Prevents the tasker-overhead problem where trivial fixes ran the full chain, and avoids the dual-mode confusion where `/fix + extend_existing` silently pulled in a heavy pipeline.

### v0.4.0 verification rounds

`workflow.yaml.verification_rounds` is intentionally a single global value:
- `rounds: 2` — every review skill and every mode runs omission + contradiction.

Resolver: `getVerificationRounds(skill, modeName?, cfg?)` returns the global `rounds` value. `modeName` is accepted for API compatibility but does not branch behavior.

There are no mid-pipeline, terminal, or per-mode round buckets. Review strictness is uniform and predictable.

### 4-1. brainstorm (`/brainstorm`)

**pipeline**: `planning_only` (investigate → investigate-review → brainstorm → brainstorm-review → tasker → tasker-review).
**defaults**: `exempt.tdd: true`, `exempt.e2e: true`, `read_only: true`.
**entry**: `workflow-investigate` with `depth: deep`; `workflow-brainstorm` follows after discovery/review.
**purpose**: ideation + planning without touching code. Produces `brainstorm.md` + `tasks.md`. Exits via `mode_transition_to_implement` after user approves `tasks.md`.

`workflow-brainstorm` follows the superpowers brainstorming experience while preserving Smelter's file/state gates: explore project context first, offer an available visual companion when visual decisions would benefit from it, ask one question at a time, present 2-3 approaches with trade-offs and a recommendation, validate design sections with the user, persist the approved design, run author self-review for placeholders/contradictions/ambiguity/scope, then hand off to `workflow-brainstorm-review` for the mandatory 2-round review.

### 4-2. fix (`/fix`) — includes trivial-fix surfaces

**pipeline**: `fix` (10 skills) by default; `fix_simple` (4 skills) pinned to `target_type ∈ {text, design}`; `upgrade_required` for `extend_existing`/`new_feature`/`refactor`/`migration` (escalate to `/implement` or `/brainstorm`).
**defaults**: `exempt.tdd: false`, `exempt.e2e: false`.
**entry**: `workflow-investigate`.
**surface exemption**: `fix_simple` is entered via exactly two target_types.
- `text` (텍스트 수정) — magic keywords `typo` / `오타` / `dialogue` / `대화` / `text` / `텍스트` / `copy` / `i18n` → `target_type=text`, `exempt={tdd:true, e2e:true}`.
- `design` (디자인 수정) — magic keywords `css` / `style` / `design` / `디자인` / `border` / `outline` / `ring` / `테두리` → `target_type=design`, `exempt={tdd:true, e2e:false}` (visual surface keeps e2e).
This replaces the old standalone trivial-fix mode and the old narrow text-only target-type split.
**review rounds**: global **2 rounds** for every review skill; no mode-specific override.
**terminal**: `workflow-human-check` — **mandatory, cannot be skipped** (§8 human review).

`/fix` follows the superpowers systematic-debugging experience while preserving Smelter's TDD gates: reproduce the symptom, check recent changes, trace data flow, compare working examples, state one root-cause hypothesis, write a compact `tasks.md` scope checklist, then write a RED executable specification before coding. The v0.55 checklist is intentionally terse: `queue` may remain unchecked because downstream stages execute it, but `goal`, `approach`, `works`, `omissions`, `verified`, and `team_runtime` must be checked before the tasker stage can complete. `tasks-review.md` separately confirms the expected behavior works, no reviewed feature is missing, validation is named, side effects are scoped, and the decision is explicit.

### 4-3. implement (`/implement`)

**pipeline**: `full` for all implement work (investigate → investigate-review → implementation-plan → implementation-plan-review → write-test → coding → agent-review → e2e → e2e-review → team-code-review → human-check).
**defaults**: `exempt.tdd: false`, `exempt.e2e: false`.
**entry**: `workflow-investigate`.
`workflow-implementation-plan` is the technical decision point. It uses code evidence to decide reuse vs new technology, presents trade-offs to the user only when a real choice exists, and for `extend_existing` proceeds with the existing feature plan when sufficient.
**resume**: when entered after `/brainstorm`, pre-existing `brainstorm.md` / `tasks.md` are requirements input only; `/implement` still runs code investigation and implementation planning.
**terminal**: `workflow-human-check` — **mandatory**.

`/implement` follows the superpowers writing-plans and subagent-driven development experience: `implementation-plan.md` includes a file map, exact task queue, RED/GREEN commands with expected outcomes, and no placeholders. Independent queue items may be executed with fresh focused executor contexts, but Smelter's review chain remains authoritative.

### 4-4. explore (`/explore`)

**pipeline**: `explore_only` (investigate + investigate-review).
**defaults**: `exempt.tdd: true`, `exempt.e2e: true`, `read_only: true`.
Static read only. Exits via user-chosen mode transition (`mode_transition_to_fix`, `mode_transition_to_brainstorm`, `mode_transition_to_implement`, `free_chat`).

If `/explore` exits to `/fix` or `/implement`, completed discovery is reused instead of repeated because `modes/workflow.yaml → transition_adoptions.explore_discovery_to_write` declares that policy. Reuse requires both state and file evidence: `completed_stages` contains each declared stage, `events[]` has a matching pass with `evidence.path`, and artifact basenames are canonical (`investigation.md`, `investigation-review.md`). For chained-mode transitions the same task state is retargeted; for explicit `Skill(fix|implement)` mode-upgrade a new write-mode feature is created and the policy's artifacts are copied into that feature's task directory. If evidence is missing or invalid, the write workflow starts at `workflow-investigate` normally.

### 4-5. verify (`/verify`)

**pipeline**: `verify_only` (verify + e2e + e2e-review + human-check).
**defaults**: `exempt.tdd: true`, `exempt.e2e: false`, `read_only: true`.
**entry**: `workflow-verify`. Three-phase report (tests + static inspection + real-interface E2E). Fails route to `/fix` via mode upgrade or chain auto-advance.

`/verify` follows the superpowers verification-before-completion experience: no pass/fail claim without fresh command output or artifacts. `workflow-verify` records tests, static checks, and E2E scope; `workflow-e2e` and `workflow-e2e-review` produce and verify real-interface artifacts before `workflow-human-check` summarizes results. UI layout/position claims require viewport/bounding-box assertions plus opened screenshot/video inspection notes.

### 4-6. dobby (`/dobby`)

**pipeline**: `dobby_only` (human-check only).
**defaults**: `exempt.tdd: true`, `exempt.e2e: true`, `read_only: false`.
**entry**: freeform `EXECUTE`; `workflow-human-check` is the only workflow skill and final gate.

`/dobby` seeds `task_type: freeform` directly at `step: EXECUTE`, so source edits and recovery-oriented mutating git commands are allowed without the normal write pipeline or stage-skill preload. No commit, push, PR, or completion claim is allowed before `workflow-human-check` records a pass event. When the user chooses `complete`, `finalize-human-check.mjs` also accepts `mode: dobby`, unblocking the required local commit path.

---

## 5. Routing Rules

### 5-1. Producer chain (default fail routing)

```
workflow-brainstorm-review   ─fail─▶ workflow-brainstorm
workflow-investigate-review  ─fail─▶ workflow-investigate
workflow-implementation-plan-review ─fail─▶ workflow-implementation-plan
workflow-tasker-review       ─fail─▶ workflow-tasker
workflow-write-test          ─fail─▶ workflow-implementation-plan (/implement) OR workflow-investigate (/fix)
workflow-coding              ─fail─▶ workflow-write-test      (RED cycle missing)
                                    OR workflow-implementation-plan (/implement scope mismatch)
                                    OR workflow-investigate / mode-upgrade (/fix scope mismatch)
workflow-agent-review        ─fail─▶ workflow-coding
workflow-e2e                 ─fail─▶ workflow-coding          (assertion, typecheck, build)
                                    OR workflow-coding       (e2e_infra_missing → install harness, v3 §7-1)
                                    OR workflow-e2e          (artifact_missing / mocked_interface)
workflow-e2e-review          ─fail─▶ workflow-coding          (insufficient_scenario)
                                    OR workflow-coding       (visual_mismatch → v3 §7-2 vision inspection)
                                    OR workflow-e2e          (file_absent)
workflow-team-code-review    ─fail─▶ workflow-coding          (medium/low)
                                    OR workflow-implementation-plan / workflow-tasker (high/critical)
workflow-verify              ─fail─▶ mode-upgrade suggestion  (read-only; user chooses /fix or other recovery)
workflow-human-check         ─fail─▶ active_feedback[].target_skill (default workflow-coding)
```

Origin/planning skills (`workflow-brainstorm`, `workflow-investigate`, `workflow-implementation-plan`, `workflow-tasker`) re-run themselves on fail.

### 5-2. Reshape edge (review skills only)

Review skills emit `result ∈ { pass, fail, reshape }`:
- `pass`: advance.
- `fail`: route to producer (rework the input).
- `reshape`: jump further upstream (scope change; evidence required).

Example: `workflow-investigate-review` declaring `reshape` → `workflow-brainstorm`.

### 5-3. Mode whitelist check (hook-enforced)

**Applies to workflow-* only.** Utility skills skip this.

If a fail-route target is `workflow-*` but not in `allowed_skills`:
1. Walk the producer chain upstream for the nearest allowed target.
2. If none: escalate via `workflow-human-check` mode-upgrade option.

### 5-4. Mode upgrade

Any direction allowed; always user-gated.

```
fix ──▶ implement ──▶ brainstorm
 ◀──    ◀──          ◀──
```

`explore` and `verify` are read-only siblings that upgrade to any of the three code-writing modes via user-gated transition.

On upgrade: `mode` and `allowed_skills` are rewritten; `events`, `test_cycles`, `active_feedback`, `sub_tasks` are **preserved**.

---

## 6. Fail Model

### 6-1. Fail event structure (fixed schema)

```json
{
  "t": "ISO8601",
  "skill": "<workflow-* skill name>",
  "result": "fail",
  "declarer": "hook | user",
  "cause": "<fixed enum>",
  "evidence": { "type": "<fixed enum>", "detail": "<string>" }
}
```

### 6-2. Declarer priority

| Declarer | Authority | Applies to |
|----------|-----------|-----------|
| `hook` | highest | typecheck, lint, test_run, build, file_absent, tdd_cycle, artifact_missing, mocked_interface |
| `skill` | ❌ forbidden | Self-declared fail is rejected (Iron Law #3) |
| `user` | final | Only at `workflow-human-check` |

### 6-3. Cause enum (fixed)

| Cause | Emitted by | Detection |
|-------|-----------|-----------|
| `typecheck` | write-test, coding, e2e, verify | `tsc --noEmit` exit |
| `lint` | write-test, coding, verify | eslint exit |
| `test_run` | coding, e2e, team-code-review, verify | test runner exit |
| `build` | e2e | `npm run build` exit |
| `assertion` | e2e | test assertion failure |
| `file_absent` | all review skills | postcondition file missing |
| `tdd_cycle` | coding | test_cycles has no RED entry |
| `review_reject` | human-check | explicit user rejection |
| `scope_mismatch` | tasker-review, team-code-review | plan vs. implementation mismatch |
| `side_effect` | tasker-review | other-feature impact detected |
| `security` | agent-review, team-code-review | vulnerability found |
| `insufficient_scenario` | e2e-review | scenario coverage thin |
| `stall_cascade` | auto-confirm (stall-detector) | cascade-level event |
| `conflict_merge_failed` | aggregator | Pattern C merge failed |
| `verification_failed` | Multi-Pass review skills | a verification round failed |
| `artifact_missing` | e2e, verify | E2E pass claim without real-interface artifacts (§8) |
| `mocked_interface` | e2e, verify | the surface under test was mocked (§8) |
| `missing_credentials` | e2e, verify | scenario requires auth and `.env.e2e` is absent (`file_absent` evidence) or a required `E2E_*` key is missing (`parse` evidence) — §8-4 |

### 6-4. Evidence type enum

| Type | Content |
|------|---------|
| `exit_code` | command exit + stderr excerpt |
| `file_absent` | expected file path |
| `file_present` | produced file path |
| `parse` | log/output parse result |
| `user_input` | user input transcript |
| `diff` | git diff excerpt |

### 6-5. Post-fail behavior

```
┌─────────────┐
│ skill fails │
└─────────────┘
       │
       ▼
[events append] ──▶ [producer lookup] ──▶ [whitelist check (workflow-* only)]
                                                │
                         ┌──────────────────────┤
                         ▼                      ▼
                   [producer allowed]     [producer not allowed]
                         │                      │
                         ▼                      ▼
                   run producer          propose mode upgrade → user
                         │                      │
                         └──────────────────────┘
                                   │
                                   ▼
                          [auto-confirm hook]
                                   │
                                   ▼
                          workflow advances (only user stop halts)
```

The combination of Iron Laws #1, #2, #4: agents follow the producer chain indefinitely. Loop detection is the user's job. No retry counter.

---

## 7. TDD Cycle Log

### 7-1. Structure

```json
"test_cycles": [
  {
    "t": "ISO8601",
    "file": "<test file path>",
    "action": "added_case | modified_case | unchanged",
    "case_name": "<describe/it text>",
    "run_result": "fail | pass",
    "error": "<stderr or null>"
  }
]
```

### 7-2. Existing-feature modification

- An existing test file is OK.
- At least one entry with `action ∈ {added_case, modified_case}` required.
- `case_name` should string-match the task description or bug id (loose).
- The test must be an executable specification: concrete domain values, a clear Given/When/Then or Arrange/Act/Assert shape, and an externally observable outcome.
- Tests that assert private helpers, internal call order, temporary structure, or other implementation details do not satisfy the write-test contract unless that detail is the public contract.
- Open behavior questions block coding; route back to clarification instead of inventing expected behavior.

### 7-3. TDD gate (hook-enforced)

**On `workflow-coding` entry**:
- At least one `action ∈ {added_case, modified_case}` + `run_result: fail` entry.
- Otherwise: `declarer: hook, cause: tdd_cycle` → route to `workflow-write-test`.

**On `workflow-e2e` / `workflow-team-code-review` pass**:
- Verify a recent `run_result: pass` entry.

### 7-4. Surface-based exemption

| Surface | TDD | E2E |
|---------|-----|-----|
| CSS / style / typography | ❌ exempt | ❌ (visual check only) |
| i18n / copy | ❌ exempt | ❌ |
| Typo (comments / docs) | ❌ exempt | ❌ |
| Pure dialogue (no code) | ❌ exempt | ❌ |
| Bug fix (logic) | ✅ required | ✅ if interface |
| Existing-feature behavior change | ✅ required | ✅ if user-visible |
| New logic | ✅ required | ✅ if interface |

Record exemption at `state.json.exempt` + `decisions.md: TDD: exempt (<reason>)`.

---

## 8. E2E Policy — Real-Interface Contract

> **E2E is not a test-runner stage.** `vitest run`, `jest`, and `pytest` alone **do not satisfy** `workflow-e2e` or `workflow-verify` Phase 3.

### 8-1. Every E2E run must:

1. Drive the **actual user-facing interface** for the surface under test.
2. Produce an **artifact file** in `.smt/features/<slug>/artifacts/` for each exercised surface.
3. Record the event with `evidence.type ∈ {exit_code, parse, diff, file_present}` referencing the artifact path (not a test-runner stdout scrape).
4. For UI layout/position requirements, assert the target element's bounding box against the viewport and preserve a screenshot/video showing that state.

### 8-2. Per-surface real interface

| Surface | Real interface | Required artifact |
|---------|----------------|-------------------|
| UI / Frontend | Real browser launched by Playwright, real clicks/typing | `.webm` video + `.png` screenshots + `console.log` |
| CLI / Script | Real subprocess with real stdin/argv/exit | command transcript file |
| HTTP API | Real server bound to real port, real fetch/curl | request/response log (method/path/status/body/timing) |
| Database | Real DB engine (or compatible in-process, never a stub) | query log + before/after state |
| Hook script | Actual `cat payload.json \| node hook.mjs` pipe | input JSON + output JSON + exit code |

### 8-3. Disallowed

- `pnpm test` / `vitest run` / `jest` alone (that is `workflow-write-test` or `workflow-verify` Phase 1).
- Calling a handler function in-process without the interface wrapper.
- Mocking the surface under test (MSW when HTTP is the subject, stubs when DB is the subject).
- Playwright `--list` / dry runs.
- Asserting on function return values without the externally visible side effect.

### 8-4. Credentials for authenticated E2E

If a scenario requires a login account, session cookie, API key, or any other secret the runner cannot obtain on its own:

- The runner reads secrets from **`.env.e2e`** at the project root (git-ignored; never `.env`, never committed, never inlined into test code or artifacts).
- Canonical variable names — use only what the scenario needs:
  - `E2E_ACCOUNT_ID` — login identifier (email / username).
  - `E2E_ACCOUNT_PW` — login password.
  - `E2E_COOKIE` — pre-authenticated session cookie.
  - `E2E_KEY` — API key / bearer token.
  - Additional scenario-specific variables MUST use the `E2E_` prefix.
- When `.env.e2e` is missing, or a required variable is absent/empty, the skill halts the scenario and asks the user to populate the exact missing keys before retrying. Fabricating values, stubbing the auth layer, or silently running an anonymous path is disallowed.
- Fail cause: `missing_credentials` (new) — evidence `file_absent` or `env_missing` referencing `.env.e2e` and the required variable names. Routes back to `workflow-e2e` on next entry after the user populates the file.

### 8-5. Enforcement

- `workflow-e2e` gate postconditions include `real_interface_invoked`, `no_interface_mocks`, `per_surface_artifact_present`.
- `critic-watchdog` rule R11 (CRITICAL) blocks any attempt to record an E2E pass while `artifacts/` holds none of the allowed file types (`.webm`, `.mp4`, `.png`, `.jpg`, `.log`, `.transcript`, `.json`, `.sql`, `.exit`).
- `critic-watchdog` rule R18 (CRITICAL) blocks UI `workflow-e2e-review` pass verdicts unless `e2e-review.md` contains `## Visual Inspection` with `opened:`, `observed:`, `expected:`, an existing screenshot/video path, and a viewport/bounding-box comparison.
- `critic-watchdog` rule R12 (CRITICAL) blocks `Edit` / `Write` tool calls to `src/`, `scripts/`, `bin/`, or `lib/` paths (non-test files) when `.state.json` exists with `current_stage === null` OR `.state.json` does not exist but `.smt/state/active-feature.json` exists. Exception: outside a Smelter project (no `.smt/` directory). Rationale: enforces workflow-skill entry before code mutation; closes the "write code before invoking any workflow skill" bypass. Also exempts `test-<name>` prefix and `<name>-test` infix filenames used by Smelter's hook test scaffolds.
- New fail causes: `artifact_missing`, `mocked_interface`, `missing_credentials`. `artifact_missing` / `mocked_interface` route to `workflow-e2e` (self-rerun with correct runner / without mocks). `missing_credentials` halts for user input before re-entering.

---

## 9. Review Skills

| Skill | When | Reviews | Performer | On fail |
|-------|------|---------|-----------|---------|
| `workflow-brainstorm-review` | after brainstorm | ambiguity / contradiction in plan | single critic | workflow-brainstorm |
| `workflow-investigate-review` | after `workflow-investigate` | coverage / risk validation | single explore-high | workflow-investigate |
| `workflow-tasker-review` | after tasker | plan side-effects / scope | Pattern B 95% consensus | workflow-tasker |
| `workflow-agent-review` | after coding, before e2e | code quality / bugs / security / Risks | Pattern B dual (code-reviewer + security-reviewer) | workflow-coding |
| `workflow-e2e-review` | after e2e | scenario coverage / artifact quality | single code-reviewer | workflow-coding |
| `workflow-team-code-review` | after e2e-review | whole change, holistic | Pattern B 95% consensus (advocate + critic + arbitrator) | severity routes to coding or tasker |
| `workflow-human-check` | final | business context / intent | **user** | active_feedback.target_skill |

### 9-1. 95% consensus process (Pattern B)

```
advocate   (positive): defend implementation merits
critic     (negative): call out defects, missed cases, bugs
arbitrator (neutral):  synthesize, compute score, render final verdict

Rounds repeat until all agents' agreement ≥ 95%.
```

### 9-2. Severity classification (team-code-review / human-check)

| Severity | Criterion | Routing |
|----------|-----------|---------|
| `CRITICAL` | data loss, security vulnerability, service outage | `workflow-tasker` (redesign) |
| `HIGH` | major bugs, missed edge cases | `workflow-tasker` |
| `MEDIUM` | minor bugs, improvements | `workflow-coding` |
| `LOW` | style, naming | record in `## Risks`, continue |

The `## Risks` section is retained in the task document.

### 9-3. Multi-Pass Verification (2-round enforcement)

All review skills enforce:

```yaml
min_verification_rounds: 2
verification_rounds:
  - n: 1
    focus: omission         # what's missing?
  - n: 2
    focus: contradiction    # what conflicts?
```

`pass` requires `completed_rounds === 2` and every round `result === 'pass'`. Anti-evasion guards:
1. No prior-round conclusions injected into the current round.
2. `critic-watchdog` blocks "already verified" skip statements.
3. Declaring `pass` with `completed_rounds < 2` is hook-blocked.

### 9-4. Evidence Integrity (Mechanical Enforcement)

Every `fail` verdict emitted by a fail-routing review skill (`workflow-investigate-review`, `workflow-implementation-plan-review`, `workflow-tasker-review`, `workflow-agent-review`, `workflow-e2e-review`, `workflow-team-code-review`) MUST cite at least one anchor in the strict form:

```
**Evidence:** `path/to/file.ext:LINE[-LINE]` "verbatim quote substring"
```

Rules:
- Path must exist on disk at the session's cwd (or be absolute).
- Quoted substring must appear on the cited line (or within the `L1-L2` range) after whitespace normalization. Quote is a substring match, not a regex.
- `PostToolUse:Edit|Write` hook (`scripts/review-evidence-verifier.mjs`) blocks any review artifact write whose `fail` verdict lacks a verified anchor, or whose anchor fails path/line/quote resolution.
- Agents must not paraphrase — quote the line verbatim.
- If a verified anchor cannot be produced, the symptom is not grounded; do NOT emit a `fail` verdict.

Grandfathering: existing review artifacts predating this rule are not retroactively blocked; the hook only fires on new `Edit|Write` operations. `workflow-brainstorm-review` is exempt (brainstorm reshape targets do not route via producer chain).

---

## 10. Human Check

### 10-1. Presented report

```
Human Review Report
────────────────────────────────────
Feature  : <slug>
Task     : <title>
Mode     : <mode>
Stages   : <list of completed workflow skills>

Artifacts:
  - Video : <path or (none)>
  - Log   : <path or (none)>
  - Diff  : <summary>

Risks    : <## Risks section or (none)>
TDD      : <test_cycles summary>
E2E      : <surface + pass/fail + artifacts>
────────────────────────────────────
```

### 10-2. User options

**MANDATORY:** ask via the Claude Code `AskUserQuestion` tool (native clickable prompt), never as a plain-text menu. `AskUserQuestion` is a deferred tool — load its schema first via `ToolSearch("select:AskUserQuestion")`, then invoke it. Plain-text menus like `Decide: complete / rework / hold / upgrade?` are invalid; the Stop hook re-enters `workflow-human-check` and requires native `AskUserQuestion`. The same rule applies to `/explore` exit options (`commands/explore.md`).

Options:

```
[1] rework                 → specify rework targets → create active_feedback → target_skill routing
[2] complete-commit-current → finalize results.md → record human-check pass → git commit on current branch
[3] complete-new-branch-pr → finalize results.md → record human-check pass → new branch/push → gh pr create
[4] hold                   → record status: blocked
[5] upgrade                → mode upgrade
```

### 10-3. Completion

On either `complete-*` action: write `results.md`, let `finalize-human-check.mjs` record the human-check pass shape, then run only the selected git action. `complete-commit-current` commits on the current branch without pushing. `complete-new-branch-pr` creates or switches to a new task-named branch derived from the feature slug, commits, pushes with upstream, and runs `gh pr create`.

---

## 11. Auto-Confirm Hook — Never-Halt Engine

> The runtime implementation of Iron Law #1. The session never halts until the workflow completes or the user stops.

### 11-1. Hook flow

```
[Stop event]
     │
     ▼
 auto-confirm.mjs
     ├── read state.json (current_stage, events, active_feedback, test_cycles)
     ├── analyze last assistant response
     ├── apply decision tree (§11-2)
     └── drop payload to .smt/state/auto-confirm-queue-<sessionId>.json
         (session-scoped; legacy auto-confirm-queue.json only when session_id absent)
         + emit { decision: 'block' } (exit 2)
     │
     ▼ (on next UserPromptSubmit)
 auto-confirm-consumer.mjs
     ├── read queue (ignore entries older than 5 min, delete)
     └── emit { decision: 'continue', additionalContext: <injection> }
```

### 11-2. Decision tree

| Signal | Next action |
|--------|-------------|
| `events[-1].result === pass` + (`events[-1].skill === current_stage` OR `current_stage` has a fail event) | **advance to next workflow skill** |
| `events[-1].result === fail` | **producer-chain routing** |
| `active_feedback` has `resolved: false` | **re-enter target_skill** |
| Risk keyword in response text | **spawn sub-tasker → add new task to queue** |
| `test_cycles` has RED but no `workflow-coding` entered | **enter workflow-coding** |
| `current_stage === workflow-human-check && result === complete` | **wrap session, write session log** |
| `chained_modes.length > 1` + transition signal | **auto-advance the chain** |
| `mode_upgrade` requested | user input awaited (only halt) |
| Canonical artifact exists for `current_stage` but no state event exists yet | **backfill artifact-backed pass/fail event** via `applyArtifactCompletionEvent(state, statePath)` before classifier routing |
| `decision.action === stage_complete` (classifier prose verdict) | **write hook pass event to `state.events[]`** via `applyProseCompletionPass(state, statePath)` BEFORE signature computation, then queue injection |
| No state-machine signal | **delegate to lightweight LLM classifier sub-agent** (verdict = `continue` or `halt` — no regex, no fallback) |

**Advance branch guard (Fix A companion):** the advance signal requires `last.skill === current_stage` OR a prior fail event for `current_stage`. Without this guard, a cross-stage pass event (Fix A's hook-written pass for the prior stage while `current_stage` has already advanced via PostToolUse:Skill) would cause `pickNextStage` to skip the current stage entirely. The fail-recovery condition keeps the producer-chain legitimate (e.g., `workflow-coding` fails → `workflow-tasker` re-plans + passes → advance resumes at coding).

**Prose-completion pass-event write (Fix A):** when the stage-completion classifier returns `complete` on prose (no canonical artifact on disk), `skill-stage-transition.mjs` cannot write a pass event because its write is artifact-gated (`evidence.path` required). Without a pass event, `shouldRunStageCompletionClassifier` re-fires on every Stop, and a mode-transition acknowledgement in the agent's response ("User selected /fix") makes the classifier flip to `incomplete`, looping until the stuck-loop guard exits silently. `applyProseCompletionPass(state, statePath)` writes `{skill: current_stage, result: 'pass', declarer: 'hook'}` to `state.events[]` (no `evidence.path`; does NOT advance `completed_stages[]` because `state-validator.mjs:61` early-returns only when `completed_stages` is empty — a prose-completion event lacking `evidence.path` would trip per-stage validation). Idempotent via `alreadyHasPass`; blocked by `alreadyHasFail` (fail is terminal for the session). See `scripts/auto-confirm.mjs:applyProseCompletionPass`.

**Artifact-completion backfill:** if the agent invoked a workflow skill before writing that skill's canonical artifact, `skill-stage-transition.mjs` can only set `current_stage`; it cannot mark completion because the artifact does not exist yet. On the next Stop event, `auto-confirm.mjs::applyArtifactCompletionEvent` checks the current stage's canonical artifact (`investigation.md`, `investigation-review.md`, etc.) under the active task directory (`.smt/features/<slug>/task/`). If the file is present and non-empty and no pass/fail event exists for the stage, the Stop hook records an artifact-backed event with `evidence.path`. Review artifacts with `verdict: fail` are recorded as `result: 'fail'` with a detected cause (default `review_reject`) and immediately route through producer-chain fail handling; pass artifacts advance normally and update `completed_stages[]` for non-deferred stages. Recovery prompt text must put the absolute artifact path first (`Write missing artifact at absolute path: ...`) so agents do not call `Write(investigation.md)` in the repository root. This closes the state/artifact drift where a review file existed on disk but Stop still classified the stage as incomplete.

**Classifier prompt exception clause (Fix B):** `buildStageCompletionPrompt` teaches the classifier to return `complete` for user-selected mode-transition acknowledgements ("User selected /fix", "사용자가 /fix 선택", "review passed", "consensus reached"). Excludes (a) agent speculation ("I think we should go to /fix"), (b) investigation-complete alone ("조사 완료") without user selection, (c) `/fix` as a file path token.

The classifier sub-agent runs `claude -p <classifier-prompt> --model <model>` and outputs exactly one word. The Stop hook acts on that verdict:
- `continue` → block + queue injection (next turn proceeds)
- `halt` (or sub-agent failure: timeout, missing binary, malformed output) → exit 0, no queue (no infinite loop)

Recursion is prevented by setting `SMT_CLASSIFIER=1` on the spawned sub-agent's env; the Stop hook bails out immediately when it sees that flag, so classifier sessions cannot recursively re-fire the hook. Hook timeout raised to 45 s to accommodate one LLM round-trip.

Sub-agent model selection (`pickSubAgentModel`):
- Default = `sonnet`.
- Env `CODEX_MODE=1` or env `SMELTER_MODEL_MODE=codex` → `gpt-5.4-mini` (Codex mini) for the Codex CLI runtime. Env is the only truth source; the old `~/.smt/config.json.codexMode` fallback is removed because the global file last-writer-wins race leaked codex state into parallel plain-claude sessions.
- `SMELTER_MODEL_MODE=claude` (set by the claude wrapper for non-codex sessions) forces the queued sub-agent back to `sonnet`, even if stale Codex env like `SMELTER_ACTIVE_MODEL=gpt-*` is still present.

The queued payload includes `sub_agent_model` so the next-turn agent's continuation work uses the same model.

Statusline HUD model labeling: in Codex windows, `scripts/statusline-hud.mjs` prefers the Codex mode label/state over raw stdin `model.display_name`, preventing plain `gpt-*` IDs from leaking into the HUD.

### 11-3. Risk auto-tasking (sub-tasker)

Trigger keywords in the agent's response:
- "리스크", "위험", "주의해야", "잠재적"
- "TODO", "나중에", "추후"
- "고려 필요", "검토 필요"
- "이상하지만", "임시로", "일단"

Flow: keyword → call `sub-tasker` agent → extract the risk from context → create a new task under `.smt/features/<slug>/task/risk-<timestamp>.md` → append id to `state.sub_tasks[]` → original workflow continues.

### 11-4. Halt conditions (only allowed)

1. Explicit user stop (`/cancel`, `/stop`, or manual abort).
2. `workflow-human-check` awaiting user input. The halt clears only when `state.events` contains a pass event whose `skill === 'workflow-human-check'`, or when `state.completed_stages` includes `workflow-human-check` (legacy migration fallback). A pass event from any prior skill (e.g., `workflow-tasker-review`) must NOT clear the halt — previously, the guard only checked `lastEvent.result === 'pass'` and allowed a stale prior-skill pass to advance the chain to `workflow-write-test`. On terminal approval (pass event OR legacy marker), the guard short-circuits to `session_wrap` so a genuine human-check approval does not fall through to the generic advance branch below.
3. Mode-upgrade decision awaited.
4. `explore` mode terminal (user picks the next mode).
5. **Classifier sub-agent verdict = `halt`** — when no state-machine signal matches, the lightweight LLM classifier decides; a `halt` verdict (or any sub-agent failure: timeout, missing binary, malformed output) ends the session cleanly and prevents the prior "no explicit signal, prompting to proceed" infinite loop. There is no regex fallback (see §11-2).

### 11-5. Config

`~/.smt/config.json`:

```json
{
  "autoConfirm": true,
  "subTaskerOnRisk": true,
  "maxSessionHours": 24,
  "stopOnCostLimit": false
}
```

Codex detection is env-only (`CODEX_MODE=1` or `SMELTER_MODEL_MODE=codex`) — env switches the queued sub-agent model from `sonnet` (default) to `gpt-5.4-mini` for the Codex CLI runtime. The `codexMode` key in `~/.smt/config.json` is no longer written or read; `scripts/session-start-smt.mjs` had synced it for Stop/UserPromptSubmit hooks, but the global shared file caused cross-session bleed between parallel `claude-codex` + plain `claude` windows. `scripts/lib/subagent-classifier.mjs` and `scripts/auto-confirm.mjs::pickSubAgentModel()` now rely solely on env + the session-scoped `.smt/state/model-mode-${SMELTER_SESSION_ID}.json`. The SessionStart hook still injects Caveman from vendored upstream skill content at `skills/caveman/SKILL.md`.

**Session-scoped model-mode state:** the per-session codex indicator lives in `.smt/state/model-mode-${SMELTER_SESSION_ID}.json`, never in a shared `model-mode.json`. The wrapper (`codex-for-claude-code/scripts/claude-wrapper.mjs`) coins `SMELTER_SESSION_ID` via `randomUUID()` (or reuses an inbound value after `sanitizeSessionId` validation) and injects it into the child env. Every reader — `statusline-hud.mjs`, `hud-summary-trigger.mjs`, `scripts/lib/subagent-classifier.mjs`, `pre-compact.mjs` — resolves the same env var, sanitizes it, and short-circuits to the settings/env fallback when it is absent. Plain `claude` sessions have no `SMELTER_SESSION_ID` and therefore never read a state file → concurrent codex + plain claude in the same cwd are isolated by env, not by path. Wrapper pre-launch sweeps the legacy unscoped file (one-time migration) plus `model-mode-*.json` entries older than 24h; normal exit / SIGINT / SIGTERM / SIGHUP unlinks the current session's scoped file. `sanitizeSessionId` (`scripts/auto-confirm.mjs:65`) is the shared contract — regex `/^[A-Za-z0-9_-]+$/`; changing it requires a coordinated consumer review.
`claude` sessions are forced to pass `SMELTER_MODEL_MODE=claude` and actively clear inherited Codex-only env (`CODEX_MODE`, `SMELTER_ACTIVE_MODEL`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) via `scripts/claude-wrapper.mjs`, so parallel windows can’t inherit a stale Codex-only override from another session. For concurrent codex/claude isolation the wrapper injects `CLAUDE_CONFIG_DIR=~/.claude` into the codex child; this keeps session history and `--resume` shared with plain Claude while the Claude binary reads `~/.claude/.claude-<sha8(NFC(dir))>.json` instead of the global `~/.claude.json` for Codex model cache. `applyCodexMode()` writes codex `additionalModelOptionsCache` only to that scoped file, never the global one — plain `claude` windows (which bypass the wrapper) always see a clean global picker. `~/.claude/` remains the shared config dir for settings/agents/commands/hooks. Codex child exit only runs a legacy-global `clearModelCache()` safety net; the scoped file stays populated so a concurrent second codex window isn't disrupted when the first exits (every codex launch writes the same constant `CODEX_MODEL_OPTIONS`).

Hook timeouts and env vars:
- `hooks/hooks.json` Stop hook timeout = 120 s, giving the folded single-hook enough budget for one inner classifier round-trip plus state I/O; the inner classifier call is capped at 10 s via `STAGE_CLASSIFIER_TIMEOUT_MS` so a hung sub-agent cannot consume the full budget.
- `SMT_CLASSIFIER=1` is injected into the spawned classifier sub-agent's env. The Stop hook bails out immediately when it sees this flag, preventing recursive Stop-hook fires from the classifier session.
- `SMT_CLASSIFIER_CMD` (test-only) overrides the classifier binary path so unit tests can inject a stub.

There is no learned-skill pre-injection hook. `UserPromptSubmit` runs command routing (`keyword-detector.mjs`) and queued continuation delivery (`auto-confirm-consumer.mjs`) only; workflow skill bodies are loaded by explicit Skill invocation inside each flow. This avoids broad prompt inflation from automatic skill-body injection.

Developer install does not globally expose workflow resources. `scripts/dev-install.mjs` keeps only the `~/.claude/commands -> <repo>/commands` symlink and removes legacy Smelter dev symlinks for `~/.claude/skills` and `~/.claude/agents` when they point at this repo. Workflow skills and agents must be reached through the active flow, not global auto-discovery.

#### 11-5a. Queue-signal handling (auto-confirm CLI entry)

The `/queue` skill writes `.smt/state/cancel-signal.json` with `type: "queue"` + `queued_intent`. On the next Stop event, the auto-confirm hook checks the queue signal **before** running `decide()` or invoking the classifier sub-agent:

- Fresh, session-matching queue signal present → drop a continuation payload into `auto-confirm-queue-<sessionId>.json` (session-scoped so parallel Claude sessions in the same project never cross-consume each other's queued payload) carrying the `queued_intent`, clear the cancel signal, emit `decision: 'block'` (exit 2). The next `UserPromptSubmit` — matched by `session_id` in the hook's stdin — injects the queued intent so the main agent picks it up.
- No queue signal → decision flow proceeds normally (state-machine → classifier sub-agent → halt/continue).

This guarantees `/queue` items always run; without this check the classifier would (correctly) halt on a final-summary message and the queued intent would be silently dropped.

#### 11-5b. E2E reminder untracking (post-tool-verifier ↔ auto-confirm)

**Current Stop-hook shape**: `stop-stage-enforcer.mjs` has been deleted and its stage-progression logic (`pickNextStage`, `isTerminalStage`, `ALWAYS_TERMINAL_STAGES`) folded directly into `scripts/auto-confirm.mjs` as local exports. `auto-confirm.mjs` is now the **single Stop hook**. The `hooks/hooks.json` and `settings.json` Stop hook arrays each contain only the auto-confirm entry (timeout 120 s).

`auto-confirm.mjs` is the unified Stop-hook stage-progression guard. Its primary role is to block Stop when a workflow mode (fix/implement/brainstorm) has not yet reached a terminal stage. It also preserves the legacy E2E reminder pathway as a fallback: it reads `/tmp/smelter-session-files-<projectHash>.json` (populated by `post-tool-verifier.mjs` on every Edit/Write) and surfaces an `[E2E]` reason when the next stage would be `workflow-e2e` and `summary.json.e2e_required` is set.

Active-state resolution is **session-isolated**: `findActiveStatePath(cwd, sessionId)` reads `.smt/state/active-feature-<sessionId>.json` (primary) then `.smt/state/active-feature.json` (non-scoped, session-less fallback only). The global `.smt/active_task` pointer was removed — concurrent sessions would overwrite it and strand each other's mid-flow chains. Same resolution applies to `critic-watchdog.readActiveState`, `skill-stage-transition.resolveActiveState`, `auto-confirm.findActiveTaskState`, and `critic-watchdog` R12. `keyword-detector.seedWorkflowState` writes only the per-session pointer when `session_id` is present; non-scoped pointer is written only when `session_id` is absent (legacy CLI / `session-sim.mjs`). `clearActiveFeature(directory, sessionId)` unlinks per-session + non-scoped + legacy `.smt/active_task` so `/cancel` fully clears the chain.

**Stuck-loop escape**: `auto-confirm` maintains a per-project + per-session loop counter at `/tmp/smelter-auto-confirm-loop-<projectHash>-<sessHash>.json`. The counter signature is `slug:mode:current_stage:completedCount` (count of `completed_stages`, not the decision-action string) — monotonically increasing on genuine advance, so the counter resets precisely when state moves forward. When the same signature triggers `AUTO_CONFIRM_STUCK_THRESHOLD` (default 3) consecutive identical-signature runs with no state progression, the hook halts with a stuck-loop warning. Any genuine state transition (stage advance, mode flip, slug swap) resets the counter; the counter is also considered stale after 30 min. `cancel-propagator.mjs` cleans both the auto-confirm counter path and the legacy stop-loop path (`/tmp/smelter-stop-loop-<projectHash>-<sessHash>.json`) on hard cancel so pre-existing files from prior sessions do not inherit stale state.

To stop the reminder firing repeatedly after the user has already validated changes, `post-tool-verifier.mjs` removes a tracked source file from the list whenever a Bash command runs `<base>.test.<ext>` and the command does **not** match `detectBashFailure()`. When the list becomes empty, the tracking file is deleted, so auto-confirm SKIPs the E2E surface enrichment cleanly on the next Stop event.

Untrack heuristic (matches anywhere in the command, including under `bash -c`):

```
/(?:^|[\s'"])([^\s'"]+\.test\.(mjs|js|ts|tsx|jsx|cjs))/g
```

For each match, the corresponding `<base>.<ext>` (and its basename) is removed from the tracking list. Tests that fail leave the entries in place so the reminder still fires.

#### 11-5c. Interactive-skill in-progress continue

Interactive workflow skills (`workflow-brainstorm`, `workflow-investigate`, `workflow-tasker`) run a multi-turn Q&A before writing their canonical artifact. Between Q1 and Q_n, `state.completed_stages` and `state.events` are both empty; the hook treats an in-progress tool invocation as continuation rather than forcing the agent to re-invoke the skill on every turn.

`auto-confirm.mjs::decide` (which absorbed the `isTerminalStage` / `pickNextStage` logic from the now-deleted `stop-stage-enforcer.mjs`) consults the transcript before emitting `entry_not_started`. After `isTerminalStage` (terminal short-circuit), if `current_stage` is set with empty completed/events AND `hasSkillInvocationSinceLastUserText(transcriptPath, current_stage)` returns true, the hook returns `{action: 'continue'}` and Stop passes cleanly — the agent halts, the user replies, and the next turn resumes the Q&A naturally.

`hasSkillInvocationSinceLastUserText` (in `scripts/lib/transcript-reader.mjs`) anchors on the last `role: 'user'` entry carrying a `type: 'text'` part (so Claude Code's user-role `tool_result` envelopes do not mistakenly cut the current turn's tool loop out of the window). Success is gated on a matching `tool_result` with `is_error !== true`; platform-rejected invocations do NOT register. The helper is fail-closed — missing `transcript_path`, oversize files, and parse exceptions all return `false`, preserving the guarded `entry_not_started` block.

Paired with this, `auto-confirm.mjs::decide` now accepts `questionShape` and suppresses the `spawn_sub_tasker` branch when the last assistant message matches `multi_choice`, `yes_no`, or `open_question` (`classifyQuestionShape` applies a conservative bullet-line requirement so rhetorical `?`-ending prose still triggers risk-keyword routing). The shape gate is inserted AFTER the halt conditions (`workflow-human-check`, `_awaiting_mode_upgrade`, investigate-review pass halt, `done`) so those pauses remain authoritative.

### 11-5b. No-Choice Policy & Autopick Directive

The classifier prompt (`buildClassifierPrompt`) and the `continue` injection branch (`buildPromptInjection` + `buildAutopickDirective`) jointly enforce the no-choice policy:

1. **Classifier**: when the assistant's last message presents branching options ("A/B", "어느 쪽", numbered alternatives, "원하시면 ... 또는 ..."), the classifier is instructed to STILL return `continue` rather than `halt`. A/B presentation is no longer a halt condition — only credentials, irreversible-destructive-confirmation, and unresolvable ambiguity halt.
2. **Injection**: when the `continue` decision fires AND `questionShape` is `multi_choice` / `yes_no` / `open_question`, `buildPromptInjection` appends a `[NO-CHOICE POLICY]` block instructing the agent to (a) pick the highest-confidence option (strongest evidence, safest blast radius, fewest assumptions), (b) state the pick + one-line reason, (c) execute it via tools immediately. The directive is `continue`-only — `enter_skill` / `advance` / `chain_advance` injections do not append it because those branches already name an explicit next skill.
3. **Behavior anchor**: `CLAUDE.md` (project) carries a top-level "No-Choice Policy" so the main agent does not rely on the hook's safety-net injection. The hook is the backstop for slip-ups, not the primary mechanism.

### 11-6. Stall Detection & Internal Resolution Cascade

> The Smelter UX principle: **minimize user monitoring**. Stalls are resolved internally first.

Stall signals (checked periodically):

| Signal | Threshold |
|--------|-----------|
| parallel agent idle (no tool use) | 5 min or 10 tool calls |
| same `skill@fail` repeats | 3 in a row |
| sync-point wait on specific agents | 3 min after peers done |
| `test_cycles` accumulated without `run_result: pass` | 10+ |
| `active_feedback` backlog unresolved | 3+ |
| `state.json.updated_at` not refreshed | 10 min |

Four-level cascade (Levels 1-3 user-silent):

```
[Stall detected]
   ├─ Level 1: spawn debugger agent (ReadOnly) → diagnosis + unblock strategy
   ├─ Level 2: producer-chain reroute to upstream
   ├─ Level 3: sub-tasker extracts blocker as new task; current task → blocked
   └─ Level 4: propose mode upgrade (user-gated)
       └─ Level 4 refused or fatal: user notification
```

Each level retries up to 2 times before escalating. Level 2 onward do not reset the stall timer (prevents infinite cascade).

### 11-7. Read-before-Write Prevention & Retry Fallback

The Claude Code harness rejects `Write`/`Edit` of any file not `Read` in the current session with the error `File has not been read yet. Read it first before writing to it.`. Two complementary mechanisms keep this error from halting the agent:

**Preventive prompt (PreToolUse, `scripts/pre-tool-enforcer.mjs`)**: whenever the tool is `Write` or `Edit` AND `existsSync(file_path)` is true, the hook appends a `Read-first reminder:` block to `additionalContext` alongside the existing `Writing:`/`Editing:` description. The reminder echoes the exact path through the tool description, tells the agent to read or re-read when the file is unread, stale, or modified since read, and explicitly exempts new-file writes. Emitted in the normal (non-block) flow path — block paths (protected-state, code-file gate, commit gate) short-circuit first, so the reminder does not leak into block reasons.

**Escalated retry (PostToolUse, `scripts/tool-retry.mjs`)**: the existing `file-not-read` retry pattern stays as attempt 1 (single-line instruction). On `currentCount >= 1` (attempt 2+), `buildRetryInstruction` returns a `FALLBACK (escalated...)` block that enumerates steps (1)…(4) — explicit `Read()` call, Read-verify, re-issue with same payload, spurious-error recovery. The retry-cap (`MAX_RETRIES=3`) is unchanged; only the message content escalates. Attempt 1 keeps the original single-line form so routine recoveries do not bloat context. The file-writer gate accepts both bare tool names (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) and UI-decorated variants like `Write(/abs/path)` so the retry still fires when the payload includes the rendered invocation label.

The two layers are independent: the preventive prompt fires on every Write/Edit (cheap), the escalated fallback fires only when the retry counter demonstrates the agent did not Read between attempts (expensive message, rare path). Both layers preserve Iron Law #4 (no unbounded retry).

---

## 12. Team Agent Patterns

### 12-1. Five patterns

| ID | Name | Shape | Use |
|----|------|-------|-----|
| A | **Specialist Assignment** | 1 skill = 1 agent | Simple / focused; default |
| B | **Team Consensus** | N agents vote to 95% | Judgment / consensus (team-code-review, tasker-review) |
| C | **Parallel Delegation** | N agents parallel + Aggregator | Independent areas (investigate area-split, coding module-split, write-test file-split) |
| D | **Hierarchical** | Lead + sub-agents | Complex design / multi-perspective (tasker architect-lead, brainstorm personas) |
| E | **Adversarial Watchdog** | Background critic | Iron-Law live surveillance (during workflow-coding) |

### 12-2. Pattern declaration layers

| Layer | Owns | Role |
|-------|------|------|
| `SKILL.md` (template) | skill | default pattern / aggregator / sync strategy / rules |
| `workflow-tasker` output (override) | tasker | complexity- / surface-signal override |
| `state.json.team_runtime` (runtime) | runtime | actually assigned agent IDs / current status / artifact path |

### 12-3. Aggregator & Conflict-Resolver

- **Aggregator** (default `architect`): merges parallel outputs into a single file. First pass of dedup / contradiction cleanup.
- **Conflict-Resolver**: dedicated agent called when aggregator declares merge failure. Adjudicates per conflict, writes the final consolidated file. Can declare `resolved: false` with reason (information_gap / business_decision / requirements_conflict) → sub-tasker takes over.

### 12-4. Per-skill pattern matrix

| Skill | Primary pattern | Fallback | Aggregator |
|-------|----------------|----------|-----------|
| workflow-brainstorm (deep) | D (planner lead + 3 personas) | A | planner |
| workflow-brainstorm (light) | A | — | — |
| workflow-brainstorm-review | B (critic-only adversarial) | A | — |
| workflow-investigate | C (area-split) | A (explore-medium) | architect |
| workflow-investigate-review | A (explore-high) | — | — |
| workflow-tasker | D (architect lead) | A | architect |
| workflow-tasker-review | B (95% consensus) | A | arbitrator |
| workflow-write-test | C (file-split) | A (executor) | executor |
| workflow-coding | C (module-split) + E (watchdog always-on) | A (executor) + E | architect + code-reviewer |
| workflow-agent-review | B dual (code-reviewer + security-reviewer) | A | arbitrator |
| workflow-e2e | A (qa-tester) | — | — |
| workflow-e2e-review | A | — | — |
| workflow-team-code-review | B 95% consensus | — | arbitrator |
| workflow-verify | A (qa-tester) | C (parallel phases) | arbitrator |
| workflow-human-check | User | — | — |

### 12-5. Critic Watchdog (Pattern E)

Two-layer architecture:

- **Layer 1** — `scripts/critic-watchdog.mjs` (PostToolUse hook, **17 formal rules**, millisecond latency):

| # | Rule | Severity |
|---|------|----------|
| R01 | Test file deletion | CRITICAL |
| R02 | `--no-verify` / `--force` | CRITICAL |
| R03 | `.env` / secrets write | CRITICAL |
| R04 | Complete claim with unresolved feedback | CRITICAL |
| R05 | Coding entry without RED cycle | CRITICAL |
| R06 | workflow-* outside mode whitelist | CRITICAL |
| R07 | Scope leak (file not in plan.md Queue) | HIGH |
| R08 | Evasion patterns (`??` chain, TODO flood) | HIGH |
| R09 | Parallel file conflict | HIGH |
| R10 | Complete without session log | MEDIUM |
| R11 | E2E pass claim without real-interface artifact | CRITICAL |
| R12 | Edit/Write to src-like path when workflow active but current_stage null | CRITICAL |
| R13 | Bash-based state.json write bypassing pre-tool-enforcer | CRITICAL |
| R14 | E2E pass claim without populated `scenarios[].effect_evidence` | CRITICAL |
| R15 | Code edit at stage ≠ `workflow-coding` (stage-skip on code edit) | CRITICAL |
| **R16** | **`current_stage: done` write without `workflow-human-check` pass event** | **CRITICAL** |
| **R17** | **Completion-claim prose in canonical task / results / session files before human-check pass** | **HIGH** |
| **R18** | **UI E2E review pass without opened visual inspection and viewport/bounding-box comparison** | **CRITICAL** |

**R16 / R17 rationale:** Complements the per-skill enforcement language (§0-bis). R16 catches the *state-level* side effect (writing `"current_stage": "done"` without running `workflow-human-check`). R17 catches the *human-readable* side effect (phrases like "task complete", "bug fixed", "implementation complete", "ready to ship") in `.smt/features/**/task/*.md` (excluding `plan.md`), `.smt/features/**/results.md`, and `.smt/session/YYYY-MM-DD.md`. Both skip when the current mode does not include `workflow-human-check` (e.g., `/verify`) and when `state.user_decision === 'complete'` is already recorded. Code files, test files, and `plan.md` are out of scope — those legitimately contain phrases like "task complete when X" as descriptive text.

- **Layer 2** — `agents/critic-watchdog.md` (periodic agent, ReadOnly, every 5-10 tool calls during coding): semantic checks that Layer 1 cannot do (scope drift via intent, evasion via type gap, logic evasion, half-done, Iron-Law evasion).

### 12-6. Session sharing

Per-task queues are independent; session context may be shared. Specialist agents assignable. Team Agents supported across all 5 patterns.

---

## 13. Complete mode graph (unified)

```
                                ╭──────────────────╮
                                │ natural input or │
                                │ explicit command │
                                ╰──────────────────╯
                                         │
                                         ▼
                                ╭──────────────────╮
                                │  classifier       │
                                │ (rules + LLM)     │
                                ╰──────────────────╯
                                         │
            ┌──────┬─────────┬──────┬──────────┐
            ▼      ▼         ▼      ▼          ▼
        brainstorm fix       explore verify  implement   (explicit override)
            │      │         │         │        │
            ▼      ▼         ▼         ▼        ▼
           ╭────────────────────────────────────────────────╮
           │           SHARED PIPELINE (workflow-*)          │
           │                                                  │
            │  brainstorm ◀──▶ workflow-investigate           │
           │       │                │                         │
           │       ▼                ▼                         │
            │  brainstorm-review  investigate-review          │
           │                        │                         │
           │                        ▼                         │
           │  tasker ──▶ tasker-review                       │
           │                        │                         │
           │                        ▼                         │
           │  write-test ──▶ coding                          │
           │                        │                         │
           │                        ▼                         │
           │  agent-review ──▶ e2e (real interface)          │
           │                        │                         │
           │                        ▼                         │
           │  e2e-review ──▶ team-code-review                │
           │                        │                         │
           │                        ▼                         │
           │                  human-check                     │
           ╰────────────────────────────────────────────────╯

           verify path: workflow-verify → (e2e / e2e-review) → workflow-human-check

           [utility skills are callable anywhere]
```

---

## 14. Context Isolation & Scoped Testing

### 14-1. Independent queues (preserved)

```
plan.md:
  - [ ] Task A  →  independent queue + its own state.json
  - [ ] Task B  →  independent queue + its own state.json
  - [ ] Task C  →  independent queue + its own state.json
```

### 14-2. Session sharing

Multiple tasks may run in a single session:
- Specialist agent assignment preserves expertise per task.
- On task switch, auto-confirm reconstructs context from `state.json`.

### 14-3. Scoped testing

```bash
# find changed files
git diff --name-only

# run only related tests
pnpm vitest run <changed_test_files>
npx playwright test <changed_specs>

# ❌ forbidden before workflow-human-check
pnpm test
npx playwright test
```

Full regression only at `workflow-human-check` via explicit user request.

---

## 15. Prompt Injection Boundary

`scripts/lib/yellow-tag.mjs` is a shared hook utility. Keep its
invisible-character sanitization table encoded with escaped Unicode literals
(`\u2028`, `\u2029`, `\u202A-\u202E`, `\u2066-\u2069`) rather than embedding raw
control characters directly in source; Node 22 can treat raw line/paragraph
separators as lexical breaks during ESM parse.

Smelter does not run a generic per-file rule prompt injector. Mandatory TDD,
security, and style constraints belong in deterministic gates, workflow skills,
tests, and review hooks. Smelter-specific hook architecture is project-local
knowledge and is documented in `CLAUDE.md`, not pushed into user-project coding
contexts.

---

## 16. Output Format (REQUIRED)

Every workflow skill entry prints an English header:

```
--- Skill: workflow-coding (mode: fix, agent: executor) ---
Goal: Apply RED → GREEN for validator.test.ts bug #123
```

Rules:
- English only.
- Header on every workflow-skill transition.
- Include `agent:` reflecting `team_runtime`.
- One-line `Goal:`.

---

## 17. File Structure

```
.smt/features/<slug>/
├── task/
│   ├── plan.md
│   ├── <task>.md                    ← human-readable
│   └── <task>.state.json            ← machine state (single source)
├── decisions.md
└── artifacts/
    ├── ui/                           ← .webm / .png / console.log
    ├── cli/                          ← .transcript
    ├── api/                          ← request/response .log
    ├── db/                           ← .sql.log + state samples
    └── hook/                         ← input/output .json + .exit

skills/
├── workflow-brainstorm/SKILL.md
├── workflow-brainstorm-review/SKILL.md
├── workflow-investigate/SKILL.md
├── workflow-investigate-review/SKILL.md
├── workflow-tasker/SKILL.md
├── workflow-tasker-review/SKILL.md
├── workflow-write-test/SKILL.md
├── workflow-coding/SKILL.md
├── workflow-agent-review/SKILL.md
├── workflow-e2e/SKILL.md
├── workflow-e2e-review/SKILL.md
├── workflow-team-code-review/SKILL.md
├── workflow-verify/SKILL.md
├── workflow-human-check/SKILL.md
└── (utility skills, no prefix)
    ├── ui-ux-pro-max/SKILL.md
    ├── copywriting/SKILL.md
    ├── ../commands/queue.md
    ├── deep-interview/SKILL.md
    └── ...

modes/                                 ← v0.4 unified workflow config
└── workflow.yaml                      ← skills + pipelines + modes + routing

commands/                              ← v0.4 canonical set (6 commands + utilities)
├── brainstorm.md
├── fix.md
├── implement.md
├── explore.md
├── verify.md
├── dobby.md
└── queue.md                           ← utility (no mode)

scripts/
├── auto-confirm.mjs              ← §11 Stop hook (queue-drop)
├── auto-confirm-consumer.mjs     ← UserPromptSubmit consumer
├── state-schema.mjs              ← state.json schema + validator (§2)
├── mode-classifier.mjs           ← natural-language routing (§1-2)
├── route-on-fail.mjs             ← producer chain (§5-1)
├── stall-detector.mjs            ← §11-6 stall signals + cascade
├── critic-watchdog.mjs           ← Pattern E Layer 1 (17 rules, §12-5)
├── parallel-dispatcher.mjs       ← Pattern A/B/C/D dispatch plan
└── feature-version-check.mjs     ← .smt/features/* state integrity

agents/
├── debugger.md                   ← Stall Cascade Level 1
├── aggregator.md                 ← Parallel output integrator
├── conflict-resolver.md          ← Merge-failure adjudicator
├── critic-watchdog.md            ← Pattern E Layer 2 (ReadOnly)
├── advocate.md | critic.md | arbitrator.md   ← Pattern B trio
├── product-persona.md | engineer-persona.md | design-persona.md  ← Pattern D brainstorm personas
└── (role specialists: executor, code-reviewer, security-reviewer, qa-tester, architect, explore-*, researcher, planner, ...)
```

---

## 18. Related Documents

- English spec (this file): `document/workflow.md`
- Korean translation: `document/workflow.ko.md`
- Implementation reference: `document/implementation-v2.md` + `.ko.md`
- Release notes: `RELEASE_NOTES.md` + `.ko.md`
- Public overview: `README.md` + `.ko.md`
- Project intro: `document/Introduce.md`
- Root agent instructions: `CLAUDE.md`, `AGENTS.md`

---

## Appendix A — Producer Chain (complete)

```
                         ┌──────────────────────┐
                         │ workflow-brainstorm  │
                         └──────────┬───────────┘
                                    ▼
                 ┌─────────────────────────────────────┐
                 │   workflow-brainstorm-review        │
                 └──────────┬──────────────────────────┘
                            │                 ▲ reshape
                            ▼                 │
                 ┌──────────────────────┐     │
                 │ workflow-investigate │◀────┘
                 └──────────┬───────────┘
                            ▼
                 ┌────────────────────────────────┐
                 │  workflow-investigate-review   │
                 └──────────┬─────────────────────┘
                            │         ▲ reshape
                            ▼         │
                   ┌─────────────────┴┐
                   │ workflow-tasker  │
                   └────────┬─────────┘
                            ▼
                 ┌─────────────────────────┐
                 │ workflow-tasker-review  │
                 └──────────┬──────────────┘
                            │         ▲ reshape
                            ▼         │
                 ┌──────────────────────┐
                 │ workflow-write-test  │
                 └──────────┬───────────┘
                            ▼
                 ┌──────────────────────┐
                 │  workflow-coding     │◀──┐
                 └──────────┬───────────┘   │
                            ▼               │
                 ┌──────────────────────┐   │
                 │ workflow-agent-review│───┤ fail
                 └──────────┬───────────┘   │
                            ▼               │
                 ┌──────────────────────┐   │
                 │   workflow-e2e       │───┤ (assertion / typecheck / build / test_run)
                 │   (real interface)   │   │
                 └──────────┬───────────┘   │
                            ▼               │
                 ┌──────────────────────┐   │
                 │ workflow-e2e-review  │───┤
                 └──────────┬───────────┘   │
                            ▼               │
                 ┌─────────────────────────┐│
                 │workflow-team-code-review│┤ fail (medium / low)
                 └──────────┬──────────────┘│
                            ▼               │
                 ┌──────────────────────────┐│
                 │  workflow-human-check    │┤ rework (default)
                 └──────────┬───────────────┘│
                            │                │
                            ▼                │
                         complete            │
                                             │
                  (fail: all paths)          ▼
                                    (producer or
                                     active_feedback.target)
```

---

## Appendix B — Design Decisions

| Topic | Decision |
|-------|----------|
| Skill prefix | `workflow-*` is mode-whitelist-constrained; utility skills are free. |
| Routing | Producer chain (replaces step-engine `on_fail`). |
| Retry | **None** (Iron Law #4). |
| Skill self-fail | **Forbidden** (Iron Law #3). |
| Cause enum | Fixed (§6-3). |
| Declarer | hook > user > (skill forbidden). |
| Mode upgrade | Always user-gated; any direction. |
| brainstorm ↔ workflow-investigate | Bidirectional (reshape edge). |
| Implement brainstorm | `depth: light` shared skill. |
| Fix routing (text/design) | **Auto-classifier first** (pattern match); `/fix` + magic keyword → `target_type ∈ {text, design}` → `fix_simple` pipeline (only these two surfaces route there). |
| State store | `<task>.state.json` (JSON, per-task). |
| Event history in context | Last 5 events. |
| TDD verification | `test_cycles` RED entry required. |
| Feedback | `active_feedback` accumulation with `resolved` flag. |
| Session isolation | Queue independent; session shared; specialists / teams supported. |
| Team patterns | 5 formalized (A / B / C / D / E). |
| Pattern declaration | SKILL.md (template) + tasker (override) + state (runtime). |
| Parallel Delegation (C) | investigate (area), coding (module), write-test (file), brainstorm (persona). |
| Hierarchical (D) | tasker (architect lead), brainstorm-deep (planner + personas). |
| Aggregator | Dedicated agent per skill. |
| **Conflict-Resolver** | Dedicated agent for aggregator failure. Sub-tasker fallback. |
| **Critic Watchdog (E)** | Hook Layer 1 (11 rules) + Agent Layer 2 (periodic semantic). |
| **Stall Detection** | 6 signals + 4-Level Cascade (§11-6). |
| Utility skills | No whitelist; free use. |
| **E2E real-interface enforcement (§8)** | Mandatory artifacts per surface; test-runner output alone fails the gate. R11 blocks. |

---

## Appendix D — Transcript-paste passthrough

This passthrough is intentionally narrower than the Layer-3 LLM passthrough hint. Transcript-paste detection still bypasses workflow seeding even during an active workflow session, but generic LLM `passthrough:true` hints do not: active workflow continuation wins unless the input matches the transcript-paste heuristic.

`scripts/keyword-detector.mjs::detectNaturalLanguageCommand` short-circuits to `{ passthrough: true, matched: 'transcript-paste', source: 'passthrough' }` when `isTranscriptPaste(prompt)` returns true (≥2 distinct markers among: `⏺` bullet, `⎿` connector, `Stop hook (error|feedback)`, `Ran \d+ stop hooks?`, `[master|main <sha>]`). Prevents pasted Claude Code session logs from seeding a spurious `/fix` chain via the legacy `\bfix\b` pattern. Explicit slash commands (`/fix`, `/brainstorm`, …) still bypass the heuristic via `extractExplicitHarnessCommand`. If the same pasted prompt also contains a narrow current-turn directive (`이걸 고쳐줘`, `수정해줘`, `구현 진행해`, `지원하도록 해줘`), the directive wins and seeds `fix` or `implement` state for the current session. Rollback: `SMELTER_SKIP_TRANSCRIPT_HEURISTIC=1`.

`scripts/stop-stage-enforcer.mjs::buildBlockReason` entry_not_started branch includes a `/cancel` escape hint so users whose legitimate prompt was nonetheless mis-seeded can clear state without completing the whole workflow chain.

## Appendix E — Sticky active workflow passthrough (v0.4.0)

Once a session has an unfinished active workflow pointer, natural-language prompts do not start a different mode. `scripts/keyword-detector.mjs::detectNaturalLanguageCommand` checks the active per-session state before the LLM classifier; if the active task is not terminal (`workflow-human-check` not completed and `step !== DONE`), non-slash prompts are treated as continuation and no new mode skill is injected. Explicit slash commands and explicit new-work phrases (`새 feature`, `new feature`, `다른 작업`, `새로 시작`) remain the user-controlled way to start another feature.

Communication-only prompts such as `한글로 말해봐`, language switches, and response-style changes are passthrough and never seed workflow state. Investigation rollback phrasing inside an active workflow (for example `다시 탐색해보자`) stays in the current mode and injects `Skill: workflow-investigate` instead of starting `/explore`.

---

## Appendix C — Implementation Roadmap (checklist)

| # | Item | Depends on | Notes |
|---|------|-----------|-------|
| 1 | `state.json` schema v0.4.0 | none | single source of truth |
| 2 | Mode classifier (`scripts/mode-classifier.mjs`) | 1 | natural-language → mode |
| 3 | Unified workflow config (`modes/workflow.yaml`) | 1 | 7 modes + allowed_skills |
| 4 | 19 `skills/workflow-*/SKILL.md` | 1 | contract + default pattern |
| 5 | Producer-chain router (`scripts/route-on-fail.mjs`) | 1, 4 | |
| 6 | Auto-confirm hook (`scripts/auto-confirm.mjs`) | 1, 5 | decide tree + risk sub-tasker + chain advance |
| 7 | Auto-confirm consumer (`scripts/auto-confirm-consumer.mjs`) | 6 | queue-drop pattern pair |
| 8 | Stall detection | 6 | 6 signals + 4-Level cascade |
| 9 | Pattern C Parallel Delegation | 4, 6 | investigate first (biggest ROI) |
| 10 | Aggregator agent | 9 | architect-based |
| 11 | Conflict-Resolver agent | 10 | merge-failure safety |
| 12 | Pattern B Dual Adversarial (agent-review) | 4 | code-reviewer + security-reviewer |
| 13 | Critic Watchdog Hook Layer 1 | 1, 6 | 17 rules (R01–R17); R16/R17 enforce per-skill Terminal State language (§0-bis) |
| 14 | Critic Watchdog Agent Layer 2 | 13 | periodic semantic checks |
| 15 | Pattern D Hierarchical (tasker / brainstorm) | 4 | architect + personas |
| 16 | Multi-Pass Verification engine | 4 | 2-round enforcement for review skills |
| 17 | Feature state integrity utility (`feature-version-check.mjs`) | 1 | orphan scan |
| 18 | `/verify` mode + `workflow-verify` skill | 4, 13 | tests + static + real-interface E2E |
| 19 | **E2E real-interface enforcement (§8)** | 13 | R11 CRITICAL block, artifact_missing / mocked_interface causes, per-surface artifact gate |

---

**End of workflow.md**
