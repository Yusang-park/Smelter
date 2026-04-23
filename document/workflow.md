---
title: Smelter Workflow
type: canonical
lang: en
tags: [smelter, workflow, skill-composition, producer-routing, tdd, e2e, auto-confirm]
status: canonical
version: 2.4.1
created: 2026-04-19
updated: 2026-04-20
translations: document/workflow.ko.md
---

# Smelter Workflow — Skill-Composition Model

> Smelter composes **workflow skills** into modes. Each skill declares a `consumes → produces → gate` contract; on failure the engine routes via **producer chain** — no retries, no evasion, no self-failure.
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

Commands are **hints**; the default is **three-layer auto-routing** from natural-language input. Users can invoke explicit slash commands, but when an utterance arrives the classifier assigns a mode at entry.

#### Three-layer classifier (v2.4.9+)

`scripts/mode-classifier.mjs::classify(input, { cwd, sessionId })` runs the layers in order; the first match wins.

| # | Layer | Implementation | Fires when |
|---|-------|----------------|------------|
| 1 | Explicit slash command | `EXPLICIT_COMMANDS` table + word-boundary check | prompt starts with `/think`, `/fix`, `/implement`, `/investigate`, or `/verify` followed by EOL, whitespace, `:`, or `-` |
| 2 | Passthrough | `PASSTHROUGH_PATTERNS` (anchored) | entire prompt matches pure git/shell verb-first (e.g. `git commit`, `커밋해`, `push 좀`) |
| 3 | LLM classifier | `scripts/lib/subagent-classifier.mjs::classifyMode` via OAuth Claude CLI | any remaining natural-language prompt |

The Layer 3 LLM returns `{ mode, chained_modes, passthrough, trigger }`. Cached per `{sessionId, prompt-hash}` under `.smt/state/mode-classifier-cache.json`. `classifyMode` normalizes the raw trigger with an `llm:` prefix **on write** so subsequent reads pass `isValidModeCacheEntry`'s `llm:`/`stub:` prefix whitelist; without this normalization every call re-invokes Haiku and doubles latency per prompt. The detector also forwards the full classification object into `seedWorkflowState` (via `detectNaturalLanguageCommand`'s return value) to avoid a redundant second Haiku call during surface extraction — the earlier double call could time out and silently skip state seeding, leaving the mode banner printed without an active workflow. If `passthrough === true` but the current session already has an active non-terminal workflow pointer (`.smt/state/active-feature-<sessionId>.json`), `keyword-detector.mjs` overrides the passthrough hint and keeps the turn inside workflow continuation; only explicit transcript-paste passthrough remains exempt.

**Failure policy (v2.4.9)**: if Layer 3 throws (LLM outage, invalid response, or tampered cache dropped by the validator), the error **propagates**. There is no regex fallback. Callers treat a throw or `null` return as "no classification" and skip state seeding — the prompt flows through unseeded.

**Empty input** returns `null` (no classification, no exception).

**Principles**:
- The classifier runs **only at entry**. Mid-workflow mode changes are user-gated (upgrade).
- Layers 1 and 2 are deterministic regex. Layer 3 is LLM-based (OAuth). No fallback — LLM failures surface as errors.
- An explicit slash command **overrides** the classifier.

**Source of truth**: `scripts/mode-classifier.mjs` — pure module exporting `classify(input, opts)`. `scripts/keyword-detector.mjs` (the UserPromptSubmit hook) imports it at step 2 of command resolution and passes `{ cwd, sessionId }` so per-session LLM-cache isolation holds. On classifier throw, the detector returns `null` and the prompt flows through without state seeding.

**Compound intents (chained modes)**: when the LLM detects a connective-joined chain (e.g., "분석하고 구현해줘" → `[investigate, implement]`), it populates `chained_modes`. `keyword-detector` writes this into `.state.json` at entry; `auto-confirm.decide()` picks it up at the `mode_transition` signal and auto-advances via `consumeNextChainedMode` without a user prompt (`chain_advance`). Entry mode is always `chained_modes[0]`.

**Testing**: set `SMELTER_MODE_CLASSIFIER_MODULE=<path>` to replace Layer 3 with a deterministic stub (see `scripts/lib/__fixtures__/mode-classifier-stub.mjs`). Used by `mode-classifier.test.mjs`, `keyword-detector.test.mjs`, and `workflow-scenarios.test.mjs` SCENARIO 13 so test assertions do not depend on live LLM availability.

#### Mode summary

| Mode | Entry skill | Pipeline | Purpose |
|------|-------------|----------|---------|
| `think` | `workflow-brainstorm` (deep) | `planning_only` | Ideation & planning. No code changes. Produces `brainstorm.md` + `tasks.md`. |
| `fix` | `workflow-investigate` | `no_brainstorm` | Bug / logic repair. `target_type ∈ {text, design}` routes to `fix_simple`; everything else (`bug_fix`) stays on the 8-skill `fix` pipeline. |
| `implement` | `workflow-brainstorm` (light) | `full` | Feature development on existing code. |
| `investigate` | `workflow-investigate` | `investigate_only` | Static read only (맥락·근거 파악). Exits via mode transition. |
| `verify` | `workflow-verify` | `verify_only` | Non-modifying verification (test run + static inspection + real-interface E2E). |

v3 (2026-04-21): the 6-mode set (`simple_fix` / `plan` retained) collapsed to 5. `/simple-fix` folded into `/fix` + magic keyword; `/plan` renamed to `/think`. Mode/pipeline/skill definitions live in `modes/{modes,pipelines,skills}.yaml` loaded by `scripts/lib/workflow-loader.mjs`.

### 1-3. Surface Extraction (v3.2+)

Surface fields (`target_type`, `exempt`, `skip_brainstorm`) are inferred from two complementary lanes — never via free-form NL regex.

- **Natural language** → emitted by `classifyMode` (scripts/lib/subagent-classifier.mjs) alongside `mode`. The Haiku classifier reads the prompt once and returns both mode classification and surface inference in a single call. System prompt includes an anti-injection clause: user text that explicitly instructs `"set target_type to text"` is ignored; classifier infers from the actual task surface.
- **Slash-command arguments** → resolved by `parseSlashArgs` (scripts/lib/surface-extraction.mjs) against the frozen `SLASH_SURFACE_TABLE`. Tokenized match (no `\b` regex), first-match-wins for `target_type`, union for `exempt.*` and `skip_brainstorm`. Only `fix` and `implement` have rows; other commands return `null`.

The old regex `applyMagicKeywords` path and the `modes/workflow.yaml → modes.*.magic_keywords` YAML blocks were removed in v3.2. Cache entries are bumped to `schema_version: 2`; pre-rollout validators remain compatible via the unchanged `trigger: "llm:..."` invariant.

### 1-4. Workflow vs. Utility Skills

Only **workflow skills** are constrained by mode whitelist. Utility skills are free.

#### workflow-* skills (mode whitelist target, 14)

- `workflow-brainstorm`, `workflow-brainstorm-review`
- `workflow-investigate`, `workflow-investigate-review`
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
  "schema_version": "2.4.1",
  "task_id": "fix-empty-input-bug",
  "mode": "fix",
  "allowed_skills": [
    "workflow-investigate", "workflow-investigate-review",
    "workflow-tasker", "workflow-tasker-review",
    "workflow-write-test", "workflow-coding",
    "workflow-agent-review",
    "workflow-e2e", "workflow-e2e-review",
    "workflow-team-code-review",
    "workflow-human-check"
  ],
  "current_stage": "workflow-coding",
  "completed_stages": ["workflow-investigate", "workflow-investigate-review", "workflow-tasker", "workflow-tasker-review", "workflow-write-test"],
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
- `allowed_skills` ⊆ the 14 workflow skills.
- `events[].declarer` ∈ `{hook, user}` (skill-declarer forbidden per Iron Law #3).
- `events[].cause` ∈ the fixed enum (see §6-3).
- `team_runtime[skill].rounds[i]` (when present) has `focus` ∈ `{omission, contradiction, edge_case}` and `result` ∈ `{null, pass, fail}`.
- `active_feedback[i].target_skill` ∈ workflow skills; `resolved` boolean.

### 2-3. State initialization

On every workflow command (`/plan`, `/fix`, `/simple-fix`, `/investigate`, `/implement`, `/verify`), `scripts/keyword-detector.mjs` writes `.smt/features/<slug>/task/<slug>.state.json` using `state-schema.createInitialState()` plus `allowed_skills` loaded from `modes/<mode>.json`, and also writes a `.smt/state/active_task` pointer. **`current_stage` is intentionally seeded as `null`** — the agent must invoke the mode's entry workflow skill to advance. Combined with R12 (critic-watchdog), this enforces the canonical skill-entry workflow. The legacy `workflow.json` in `.smt/features/<slug>/state/` is retained for backward compatibility but `.state.json` is now the enforcement source of truth.

**Gate enforcement stack** (v2.4.2 harness-integrity):
1. `scripts/pre-tool-enforcer.mjs` — PreToolUse Write/Edit guard on `.state.json` path. Agents cannot directly mutate state. Escape hatch `SMT_HOOK_WRITE=1` reserved for future hook scripts. Also enforces the **commit gate** for `mode ∈ {fix, implement}`: a Bash `git commit` is blocked unless the active state shows either pass shape — `events[]` contains `{skill:'workflow-human-check', result:'pass'}`, or `completed_stages` includes `workflow-human-check`. Both shapes are written together by `scripts/finalize-human-check.mjs` when the user clicks `complete`, so either alone suffices. A `current_stage === 'done'` value is NOT a pass shape: the schema's `WORKFLOW_SKILLS` enum rejects that literal, the finalize hook deliberately leaves `current_stage` at `workflow-human-check`, and SKILL.md forbids writing it.
2. `scripts/skill-stage-transition.mjs` — PostToolUse `Skill` matcher. Invoking an allowed workflow skill auto-writes the pass event + updates `current_stage` + (for non-deferred skills) appends `completed_stages`. Deferred skills (`workflow-e2e`, `workflow-human-check`, `workflow-agent-review`, `workflow-team-code-review`, `workflow-verify`, `workflow-e2e-review`) set `current_stage` only.
3. `scripts/state-validator.mjs` — `validateEvidenceIntegrity()` wired into `state-schema.writeState()`. Every `completed_stages` entry must have a pass event with existing `evidence.path`. Forged stages throw.
4. `critic-watchdog.mjs` R13 — Bash-based bypass defense-in-depth. Skipped when `SMT_HOOK_WRITE=1`.
5. `keyword-detector.mjs::shouldCreateNewFeature` (v2.4.3) — natural-language follow-ups reuse the session's active feature instead of creating a new slug per prompt. New feature is only created for slash commands, explicit `새 feature` / `new feature` phrases, or when no in-progress pointer exists. Per-session pointer `.smt/state/active-feature-<session_id>.json` keeps concurrent sessions isolated.

    **Session-isolation contract (v2.4.8):** all consumer readers — `auto-confirm.findActiveTaskState`, `stop-stage-enforcer.findActiveStatePath` / `getActiveFeatureSummary`, `skill-stage-transition.resolveActiveState`, `critic-watchdog.readActiveState` — treat the per-session pointer as strictly authoritative when `sessionId` is present. None fall back to the non-scoped `active-feature.json` or to an mtime-latest scan of `features/*/task/*.state.json`. A fresh session that inherits a prior session's non-scoped pointer resolves to "no active state" and halts cleanly instead of advancing through another session's stages.

**Classifier-subprocess re-entrancy guard**: when `lib/subagent-classifier.mjs` spawns the Claude CLI to run the Haiku classifier, that subprocess inherits the parent hook chain. `keyword-detector.mjs` detects this via `process.env.SMELTER_CLASSIFIER_SUBPROCESS === '1'` and bails out before any state-seeding side effect. Without this guard, slug derivation would use the classifier's system prompt as if it were user input, polluting the state store with spurious feature slugs over multiple sessions.

**Slug preamble pruning (defense-in-depth)**: `keyword-detector.mjs::deriveSlug` also strips system-prompt preambles — `You are a …`, Korean 당신은/너는, `Skill:/Role:/Context:` labels, echoed "successfully loaded skill" banners, and `[MAGIC KEYWORD: …]` tags — and drops leading filler tokens (a/an/the/for/to/of/…). So even if the re-entrancy guard is somehow bypassed (nested subprocess, env var dropped), a leaking classifier prompt produces a domain-reflective slug like `command-classifier-for-a-cli-tool-called-smelter-…` instead of `you-are-a-command-classifier-for-a-cli-tool-…`.

### 2-4. Token optimization

- Prompt injection uses only the **last 5** events.
- `test_cycles` is filtered to files related to `current_stage`.
- `active_feedback` is filtered to `resolved: false`.
- The rest stays on disk but outside the context window.

---

## 3. Workflow Skill Registry (14 skills)

> Skill definitions live in a single location (`skills/<name>/SKILL.md`). Shared across modes.

| # | Skill | Consumes | Produces | Notes |
|---|-------|----------|----------|-------|
| 1 | `workflow-brainstorm` | trigger prompt | `brainstorm.md` | `depth: deep\|light` |
| 2 | `workflow-brainstorm-review` | `brainstorm.md` | `brainstorm-review.md` | pass/fail/reshape |
| 3 | `workflow-investigate` | brainstorm.md or trigger | `investigation.md` | static read (structure, references) |
| 4 | `workflow-investigate-review` | `investigation.md` | `investigation-review.md` | pass/fail/reshape |
| 5 | `workflow-tasker` | investigation.md (+brainstorm.md) | `tasks.md`, `target_type`, initial `team_runtime` | |
| 6 | `workflow-tasker-review` | `tasks.md` | `tasks-review.md` | side-effect / scope check; pass/fail/reshape |
| 7 | `workflow-write-test` | `tasks.md` | `*.test.*` (RED), `test_cycles` entries | surface-based exemption applies |
| 8 | `workflow-coding` | `*.test.*` (RED) or `active_feedback` | `src/**` changes | implementation |
| 9 | `workflow-agent-review` | `src/**` diff | `agent_review.md`, `## Risks` updates | Pattern B Dual Adversarial (code-reviewer + security-reviewer). "no security surface" → A. |
| 10 | `workflow-e2e` | built `src/**` | `artifacts/` (video / screenshots / logs / transcripts / IO samples) | **Drives the real interface** (browser, subprocess, HTTP port, DB engine, hook pipe). Test-runner stdout alone is NOT a valid pass. |
| 11 | `workflow-e2e-review` | `artifacts/` | `e2e_review.md` | scenario coverage / artifact quality |
| 12 | `workflow-team-code-review` | whole change | `team_review.md` (severity-tagged) | **Multi-agent 95% consensus** |
| 13 | `workflow-verify` | current codebase (no RED required) | `verify_report.md` (Phase 1 tests + Phase 2 static inspection + Phase 3 E2E interface) | Entry skill of `/verify`. Non-modifying. Not a review skill — no Multi-Pass rounds. |
| 14 | `workflow-human-check` | all artifacts | user decision (`rework` / `complete` / `hold` / `upgrade`) | final gate |

---

## 4. Mode Definitions (v3.1)

v3 collapsed the six-mode set to **five**. v3.1 unifies all configuration into a single file for maintenance simplicity and adds target-type dispatch + 2-round mid-pipeline reviews.

- `modes/workflow.yaml` — single source of truth: skills + pipelines + modes + target_type_routing + verification_rounds + command_aliases.
- Loader: `scripts/lib/workflow-loader.mjs`. Consumers: `keyword-detector.mjs`, `skill-stage-transition.mjs`.

### v3.1 pipelines (4 code-modifying + 3 read-only)

| Pipeline | Skills | Used by |
|---|---|---|
| `full` | 13 (brainstorm → ... → human-check) | `/implement` default (new_feature / refactor / migration / bug_fix) |
| `extend_light` | 9 (investigate → ... → human-check, no brainstorm, no tasker-review, no team-code-review) | `/implement` when `target_type: extend_existing` (via `extend` magic keyword) |
| `fix` | 8 (investigate → investigate-review → write-test → coding → agent-review → e2e → e2e-review → human-check) | `/fix` default for all `bug_fix` |
| `fix_simple` | 4 (investigate → coding → e2e → human-check) | `/fix` for `text` (텍스트 수정) and `design` (디자인 수정) — the only two surfaces that route here |
| `planning_only` | 6 | `/think` |
| `investigate_only` | 2 | `/investigate` |
| `verify_only` | 4 | `/verify` |

v3.2 removes the scope-dependent `medium` pipeline: all `/fix` bug_fix runs take `fix` regardless of file count / surface count, and `extend_existing` routes out of `/fix` to `/implement + extend_light`.

### v3.2 target_type dispatch (`/fix` and `/implement`)

`workflow-investigate` determines `target_type`. `workflow-loader.selectPipeline()` picks the pipeline with mode-specific gating:

| mode | target_type | pipeline |
|------|-------------|----------|
| `/fix` | `text` / `design` | `fix_simple` |
| `/fix` | `bug_fix` | `fix` |
| `/fix` | `extend_existing` | `upgrade_required` → escalate to `/implement` |
| `/fix` | `new_feature` / `refactor` / `migration` | `upgrade_required` → escalate to `/implement` or `/think` |
| `/implement` | `extend_existing` | `extend_light` |
| `/implement` | any other / none | `full` (declared default) |

Prevents the tasker-overhead problem where trivial fixes ran the full chain, and avoids the dual-mode confusion where `/fix + extend_existing` silently pulled in a heavy pipeline.

### v3.2 verification rounds

`workflow.yaml.verification_rounds` separates mid-pipeline reviews from terminal gates, with per-mode overrides:
- `mid_pipeline: 2` — `workflow-brainstorm-review`, `workflow-investigate-review`, `workflow-tasker-review`, `workflow-agent-review`. Rounds: omission + contradiction.
- `terminal: 3` — `workflow-e2e-review` (visual verification), `workflow-team-code-review` (95% consensus), `workflow-human-check`.
- `mode_overrides.fix` — all reviews drop to **1 round** (omission only), except `workflow-e2e-review` (2 rounds: omission + edge_case) and `workflow-human-check` (3, user gate).

Resolver: `getVerificationRounds(skill, modeName?, cfg?)` checks `mode_overrides[mode][skill] → mode_overrides[mode].default → skills[skill].rounds bucket → mid_pipeline`.

v3.1 cut 4 mid-reviews × 1 round per `/fix` run; v3.2 cuts 3 additional rounds from the common `/fix` flow by dropping all mid-pipeline reviews to 1 round.

### 4-1. think (`/think`) — was `/plan`

**pipeline**: `planning_only` (brainstorm → brainstorm-review → investigate → investigate-review → tasker → tasker-review).
**defaults**: `exempt.tdd: true`, `exempt.e2e: true`, `read_only: true`.
**entry**: `workflow-brainstorm` with `depth: deep`.
**purpose**: ideation + planning without touching code. Produces `brainstorm.md` + `tasks.md`. Exits via `mode_transition_to_implement` after user approves `tasks.md`.

### 4-2. fix (`/fix`) — absorbs former `simple_fix`

**pipeline**: `fix` (8 skills) by default; `fix_simple` (4 skills) pinned to `target_type ∈ {text, design}`; `upgrade_required` for `extend_existing`/`new_feature`/`refactor`/`migration` (escalate to `/implement` or `/think`).
**defaults**: `exempt.tdd: false`, `exempt.e2e: false`.
**entry**: `workflow-investigate`.
**surface exemption (v3.3)**: `fix_simple` is entered via exactly two target_types.
- `text` (텍스트 수정) — magic keywords `typo` / `오타` / `dialogue` / `대화` / `text` / `텍스트` / `copy` / `i18n` → `target_type=text`, `exempt={tdd:true, e2e:true}`.
- `design` (디자인 수정) — magic keywords `css` / `style` / `design` / `디자인` → `target_type=design`, `exempt={tdd:true, e2e:false}` (visual surface keeps e2e).
This replaces the v2 `simple_fix` mode and the v3.2 `typo`/`dialogue` enum.
**review rounds**: mode override — all mid-pipeline reviews at **1 round**, `workflow-e2e-review` at **2 rounds**, `workflow-human-check` at **3 rounds** (user gate).
**terminal**: `workflow-human-check` — **mandatory, cannot be skipped** (§8 human review).

### 4-3. implement (`/implement`)

**pipeline**: `full` (13 skills — brainstorm → ... → human-check) by default; `extend_light` (9 skills — no brainstorm, no brainstorm-review, no tasker-review, no team-code-review) for `target_type: extend_existing`.
**defaults**: `exempt.tdd: false`, `exempt.e2e: false`.
**entry**: `workflow-brainstorm` with `depth: light`.
`extend` / `add to` / `덧붙여` magic keywords set `target_type: extend_existing`, which — via target-type dispatch — routes to `extend_light` (brainstorm skipped because it's not in the pipeline).
**resume**: when entered after `/think`, pre-existing `brainstorm.md` / `tasks.md` cause `nextSkill()` to skip straight to `workflow-write-test` (file-driven routing from superpowers).
**terminal**: `workflow-human-check` — **mandatory**.

### 4-4. investigate (`/investigate`)

**pipeline**: `investigate_only` (investigate + investigate-review).
**defaults**: `exempt.tdd: true`, `exempt.e2e: true`, `read_only: true`.
Static read only. Exits via user-chosen mode transition (`mode_transition_to_fix`, `mode_transition_to_think`, `mode_transition_to_implement`, `free_chat`).

### 4-5. verify (`/verify`)

**pipeline**: `verify_only` (verify + e2e + e2e-review + human-check).
**defaults**: `exempt.tdd: true`, `exempt.e2e: false`, `read_only: true`.
**entry**: `workflow-verify`. Three-phase report (tests + static inspection + real-interface E2E). Fails route to `/fix` via mode upgrade or chain auto-advance.

---

## 5. Routing Rules

### 5-1. Producer chain (default fail routing)

```
workflow-brainstorm-review   ─fail─▶ workflow-brainstorm
workflow-investigate-review  ─fail─▶ workflow-investigate
workflow-tasker-review       ─fail─▶ workflow-tasker
workflow-write-test          ─fail─▶ workflow-tasker
workflow-coding              ─fail─▶ workflow-write-test      (RED cycle missing)
                                    OR workflow-tasker       (scope mismatch)
workflow-agent-review        ─fail─▶ workflow-coding
workflow-e2e                 ─fail─▶ workflow-coding          (assertion, typecheck, build)
                                    OR workflow-coding       (e2e_infra_missing → install harness, v3 §7-1)
                                    OR workflow-e2e          (artifact_missing / mocked_interface)
workflow-e2e-review          ─fail─▶ workflow-coding          (insufficient_scenario)
                                    OR workflow-coding       (visual_mismatch → v3 §7-2 vision inspection)
                                    OR workflow-e2e          (file_absent)
workflow-team-code-review    ─fail─▶ workflow-coding          (medium/low)
                                    OR workflow-tasker        (high/critical)
workflow-verify              ─fail─▶ workflow-coding          (any runtime failure → /fix upgrade)
workflow-human-check         ─fail─▶ active_feedback[].target_skill (default workflow-coding)
```

Origin skills (brainstorm, investigate, tasker) re-run themselves on fail.

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
fix ──▶ implement ──▶ think
 ◀──    ◀──          ◀──
```

`investigate` and `verify` are read-only siblings that upgrade to any of the three code-writing modes via user-gated transition.

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
- `critic-watchdog` rule R12 (CRITICAL) blocks `Edit` / `Write` tool calls to `src/`, `scripts/`, `bin/`, or `lib/` paths (non-test files) when `.state.json` exists with `current_stage === null` OR `.state.json` does not exist but `.smt/state/active-feature.json` exists. Exception: outside a Smelter project (no `.smt/` directory). Rationale: enforces workflow-skill entry before code mutation; closes the "write code before invoking any workflow skill" bypass. Also exempts `test-<name>` prefix and `<name>-test` infix filenames used by Smelter's hook test scaffolds.
- New fail causes: `artifact_missing`, `mocked_interface`, `missing_credentials`. `artifact_missing` / `mocked_interface` route to `workflow-e2e` (self-rerun with correct runner / without mocks). `missing_credentials` halts for user input before re-entering.

---

## 9. Review Skills

| Skill | When | Reviews | Performer | On fail |
|-------|------|---------|-----------|---------|
| `workflow-brainstorm-review` | after brainstorm | ambiguity / contradiction in plan | single critic | workflow-brainstorm |
| `workflow-investigate-review` | after investigate | coverage / risk validation | single explore-high | workflow-investigate |
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

### 9-3. Multi-Pass Verification (3-round enforcement)

All 6 review skills enforce:

```yaml
min_verification_rounds: 3
verification_rounds:
  - n: 1
    focus: omission         # what's missing?
  - n: 2
    focus: contradiction    # what conflicts?
  - n: 3
    focus: edge_case        # what boundary is unaddressed?
```

`pass` requires `completed_rounds === 3` and every round `result === 'pass'`. Anti-evasion guards:
1. No prior-round conclusions injected into the current round.
2. `critic-watchdog` blocks "already verified" skip statements.
3. Same agent for 3 consecutive rounds emits a warning (Pattern A should mix ≥ 2 types).
4. Declaring `pass` with `completed_rounds < 3` is hook-blocked.

### 9-4. Evidence Integrity (Mechanical Enforcement)

Every `fail` verdict emitted by a fail-routing review skill (`workflow-investigate-review`, `workflow-tasker-review`, `workflow-agent-review`, `workflow-e2e-review`, `workflow-team-code-review`) MUST cite at least one anchor in the strict form:

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

**MANDATORY:** ask via the Claude Code `AskUserQuestion` tool (native clickable prompt), never as a plain-text menu. `AskUserQuestion` is a deferred tool — load its schema first via `ToolSearch("select:AskUserQuestion")`, then invoke it. The same rule applies to `/investigate` exit options (`commands/investigate.md`).

Options:

```
[1] rework   → specify rework targets → create active_feedback → target_skill routing
[2] complete → Git options (push current / push new branch / local only)
[3] hold     → record status: blocked
[4] upgrade  → mode upgrade
```

### 10-3. Completion

On `complete`: `state.json.current_stage: done`, task md checkboxes `[x]`, append to `session/YYYY-MM-DD.md`, write `results.md`.

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
| `events[-1].result === pass` + `current_stage` done | **advance to next workflow skill** |
| `events[-1].result === fail` | **producer-chain routing** |
| `active_feedback` has `resolved: false` | **re-enter target_skill** |
| Risk keyword in response text | **spawn sub-tasker → add new task to queue** |
| `test_cycles` has RED but no `workflow-coding` entered | **enter workflow-coding** |
| `current_stage === workflow-human-check && result === complete` | **wrap session, write session log** |
| `chained_modes.length > 1` + transition signal | **auto-advance the chain** |
| `mode_upgrade` requested | user input awaited (only halt) |
| No state-machine signal | **delegate to lightweight LLM classifier sub-agent** (verdict = `continue` or `halt` — no regex, no fallback) |

The classifier sub-agent runs `claude -p <classifier-prompt> --model <model>` and outputs exactly one word. The Stop hook acts on that verdict:
- `continue` → block + queue injection (next turn proceeds)
- `halt` (or sub-agent failure: timeout, missing binary, malformed output) → exit 0, no queue (no infinite loop)

Recursion is prevented by setting `SMT_CLASSIFIER=1` on the spawned sub-agent's env; the Stop hook bails out immediately when it sees that flag, so classifier sessions cannot recursively re-fire the hook. Hook timeout raised to 45 s to accommodate one LLM round-trip.

Sub-agent model selection (`pickSubAgentModel`):
- Default = `sonnet`.
- `~/.smt/config.json.codexMode === true`, env `CODEX_MODE=1`, or env `SMELTER_MODEL_MODE=codex` → `haiku` (mini) for the Codex CLI runtime.
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
4. `investigate` mode terminal (user picks the next mode).
5. **Classifier sub-agent verdict = `halt`** — when no state-machine signal matches, the lightweight LLM classifier decides; a `halt` verdict (or any sub-agent failure: timeout, missing binary, malformed output) ends the session cleanly and prevents the prior "no explicit signal, prompting to proceed" infinite loop. There is no regex fallback (see §11-2).

### 11-5. Config

`~/.smt/config.json`:

```json
{
  "autoConfirm": true,
  "subTaskerOnRisk": true,
  "codexMode": false,
  "maxSessionHours": 24,
  "stopOnCostLimit": false
}
```

`codexMode: true` (or env `CODEX_MODE=1` / `SMELTER_MODEL_MODE=codex`) switches the queued sub-agent model from `sonnet` (default) to `haiku` for the Codex CLI runtime. `scripts/session-start-smt.mjs` also syncs the current model-mode env into `~/.smt/config.json.codexMode` at session start so Stop/UserPromptSubmit hooks can read a stable codex flag. The same SessionStart hook now injects Caveman from vendored upstream skill content at `skills/caveman/SKILL.md`, replacing the old inline concise prompt string.
`claude` sessions are forced to pass `SMELTER_MODEL_MODE=claude` and actively clear inherited Codex-only env (`CODEX_MODE`, `SMELTER_ACTIVE_MODEL`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) via `scripts/claude-wrapper.mjs`, so parallel windows can’t inherit a stale Codex-only override from another session. For concurrent codex/claude isolation the wrapper injects `CLAUDE_CONFIG_DIR=~/.claude` into the codex child; this keeps session history and `--resume` shared with plain Claude while the Claude binary reads `~/.claude/.claude-<sha8(NFC(dir))>.json` instead of the global `~/.claude.json` for Codex model cache. `applyCodexMode()` writes codex `additionalModelOptionsCache` only to that scoped file, never the global one — plain `claude` windows (which bypass the wrapper) always see a clean global picker. `~/.claude/` remains the shared config dir for settings/agents/commands/hooks. Codex child exit only runs a legacy-global `clearModelCache()` safety net; the scoped file stays populated so a concurrent second codex window isn't disrupted when the first exits (every codex launch writes the same constant `CODEX_MODEL_OPTIONS`).

Hook timeouts and env vars:
- `hooks/hooks.json` Stop hook timeout = 120 s (raised from 45 s in v2.4.10 to give the folded single-hook enough budget for one inner classifier round-trip plus state I/O; the inner classifier call is capped at 10 s via `STAGE_CLASSIFIER_TIMEOUT_MS` so a hung sub-agent cannot consume the full budget).
- `SMT_CLASSIFIER=1` is injected into the spawned classifier sub-agent's env. The Stop hook bails out immediately when it sees this flag, preventing recursive Stop-hook fires from the classifier session.
- `SMT_CLASSIFIER_CMD` (test-only) overrides the classifier binary path so unit tests can inject a stub.

#### 11-5a. Queue-signal handling (auto-confirm CLI entry)

The `/queue` skill writes `.smt/state/cancel-signal.json` with `type: "queue"` + `queued_intent`. On the next Stop event, the auto-confirm hook checks the queue signal **before** running `decide()` or invoking the classifier sub-agent:

- Fresh, session-matching queue signal present → drop a continuation payload into `auto-confirm-queue-<sessionId>.json` (session-scoped so parallel Claude sessions in the same project never cross-consume each other's queued payload) carrying the `queued_intent`, clear the cancel signal, emit `decision: 'block'` (exit 2). The next `UserPromptSubmit` — matched by `session_id` in the hook's stdin — injects the queued intent so the main agent picks it up.
- No queue signal → decision flow proceeds normally (state-machine → classifier sub-agent → halt/continue).

This guarantees `/queue` items always run; without this check the classifier would (correctly) halt on a final-summary message and the queued intent would be silently dropped.

#### 11-5b. E2E reminder untracking (post-tool-verifier ↔ auto-confirm)

**v2.4.10 note**: `stop-stage-enforcer.mjs` has been deleted and its stage-progression logic (`pickNextStage`, `isTerminalStage`, `ALWAYS_TERMINAL_STAGES`) folded directly into `scripts/auto-confirm.mjs` as local exports. `auto-confirm.mjs` is now the **single Stop hook**. The `hooks/hooks.json` and `settings.json` Stop hook arrays each contain only the auto-confirm entry (timeout 120 s).

`auto-confirm.mjs` is the unified Stop-hook stage-progression guard. Its primary role is to block Stop when a workflow mode (fix/implement/think) has not yet reached a terminal stage. It also preserves the legacy E2E reminder pathway as a fallback: it reads `/tmp/smelter-session-files-<projectHash>.json` (populated by `post-tool-verifier.mjs` on every Edit/Write) and surfaces an `[E2E]` reason when the next stage would be `workflow-e2e` and `summary.json.e2e_required` is set.

Active-state resolution is **session-isolated** (v2.4.5): `findActiveStatePath(cwd, sessionId)` reads `.smt/state/active-feature-<sessionId>.json` (primary) then `.smt/state/active-feature.json` (non-scoped, session-less fallback only). The global `.smt/active_task` pointer was removed in Phase 13 — concurrent sessions would overwrite it and strand each other's mid-flow chains. Same resolution applies to `critic-watchdog.readActiveState`, `skill-stage-transition.resolveActiveState`, `auto-confirm.findActiveTaskState`, and `critic-watchdog` R12. `keyword-detector.seedWorkflowState` writes only the per-session pointer when `session_id` is present; non-scoped pointer is written only when `session_id` is absent (legacy CLI / `session-sim.mjs`). `clearActiveFeature(directory, sessionId)` unlinks per-session + non-scoped + legacy `.smt/active_task` so `/cancel` fully clears the chain.

**Stuck-loop escape** (v2.4.x, unified in v2.4.10): `auto-confirm` maintains a per-project + per-session loop counter at `/tmp/smelter-auto-confirm-loop-<projectHash>-<sessHash>.json`. The counter signature is now `slug:mode:current_stage:completedCount` (count of `completed_stages`, not the decision-action string) — monotonically increasing on genuine advance, so the counter resets precisely when state moves forward. When the same signature triggers `AUTO_CONFIRM_STUCK_THRESHOLD` (default 3) consecutive identical-signature runs with no state progression, the hook halts with a stuck-loop warning. Any genuine state transition (stage advance, mode flip, slug swap) resets the counter; the counter is also considered stale after 30 min. `cancel-propagator.mjs` cleans both the auto-confirm counter path and the legacy stop-loop path (`/tmp/smelter-stop-loop-<projectHash>-<sessHash>.json`) on hard cancel so pre-existing files from prior sessions do not inherit stale state.

To stop the reminder firing repeatedly after the user has already validated changes, `post-tool-verifier.mjs` removes a tracked source file from the list whenever a Bash command runs `<base>.test.<ext>` and the command does **not** match `detectBashFailure()`. When the list becomes empty, the tracking file is deleted, so auto-confirm SKIPs the E2E surface enrichment cleanly on the next Stop event.

Untrack heuristic (matches anywhere in the command, including under `bash -c`):

```
/(?:^|[\s'"])([^\s'"]+\.test\.(mjs|js|ts|tsx|jsx|cjs))/g
```

For each match, the corresponding `<base>.<ext>` (and its basename) is removed from the tracking list. Tests that fail leave the entries in place so the reminder still fires.

#### 11-5c. Interactive-skill in-progress continue (v2.4.8)

Interactive workflow skills (`workflow-brainstorm`, `workflow-investigate`, `workflow-tasker`) run a multi-turn Q&A before writing their canonical artifact. Between Q1 and Q_n, `state.completed_stages` and `state.events` are both empty — the pre-v2.4.8 enforcer read this as "skill has not been invoked yet" and emitted `[Stage] entry_not_started`, forcing the agent to re-invoke the skill on every turn. That in turn reset the Q&A, clouded the conversation, and eventually tripped the `STUCK_LOOP_THRESHOLD = 3` escape — but only after three forced re-entries.

`auto-confirm.mjs::decide` (which absorbed the `isTerminalStage` / `pickNextStage` logic from the now-deleted `stop-stage-enforcer.mjs`) consults the transcript before emitting `entry_not_started`. After `isTerminalStage` (terminal short-circuit), if `current_stage` is set with empty completed/events AND `hasSkillInvocationSinceLastUserText(transcriptPath, current_stage)` returns true, the hook returns `{action: 'continue'}` and Stop passes cleanly — the agent halts, the user replies, and the next turn resumes the Q&A naturally.

`hasSkillInvocationSinceLastUserText` (in `scripts/lib/transcript-reader.mjs`) anchors on the last `role: 'user'` entry carrying a `type: 'text'` part (so Claude Code's user-role `tool_result` envelopes do not mistakenly cut the current turn's tool loop out of the window). Success is gated on a matching `tool_result` with `is_error !== true`; platform-rejected invocations do NOT register. The helper is fail-closed — missing `transcript_path`, oversize files, and parse exceptions all return `false`, preserving the pre-v2.4.8 `entry_not_started` block.

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
                                │ (pattern match)   │
                                ╰──────────────────╯
                                         │
            ┌──────┬─────────┬──────┬──────────┐
            ▼      ▼         ▼      ▼          ▼
           think  fix    investigate verify  implement   (explicit override)
            │      │         │         │        │
            ▼      ▼         ▼         ▼        ▼
           ╭────────────────────────────────────────────────╮
           │           SHARED PIPELINE (workflow-*)          │
           │                                                  │
           │  brainstorm ◀──▶ investigate                    │
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

## 15. Rules Injection

`rules-lib/<lang>/*.md` is injected by `PreToolUse` based on file extension.

| Tag | Meaning |
|-----|---------|
| `[Inject: rules-lib/typescript]` | editing `.ts` / `.tsx` |
| `[Inject: rules-lib/python]` | editing `.py` |

Per-skill rules may also be injected (e.g., `workflow-coding` pulls `common/coding-style.md`).

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

modes/                                 ← v3: three-file YAML config (replaces modes/*.json)
├── skills.yaml                        ← per-skill team patterns + agent defaults
├── pipelines.yaml                     ← reusable skill sequences
└── modes.yaml                         ← thin mode defs (entry + pipeline + flags + team_hints)

commands/                              ← v3 canonical set (5 workflow + 1 utility)
├── think.md                           ← was plan.md
├── fix.md
├── implement.md
├── investigate.md
├── verify.md
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
├── feature-version-check.mjs     ← .smt/features/* state integrity
└── rule-injector.mjs             ← rules-lib injection

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
| brainstorm ↔ investigate | Bidirectional (reshape edge). |
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

## Appendix D — Transcript-paste passthrough (v2.4.8)

This passthrough is intentionally narrower than the Layer-3 LLM passthrough hint. Transcript-paste detection still bypasses workflow seeding even during an active workflow session, but generic LLM `passthrough:true` hints do not: active workflow continuation wins unless the input matches the transcript-paste heuristic.

`scripts/keyword-detector.mjs::detectNaturalLanguageCommand` short-circuits to `{ passthrough: true, matched: 'transcript-paste', source: 'passthrough' }` when `isTranscriptPaste(prompt)` returns true (≥2 distinct markers among: `⏺` bullet, `⎿` connector, `Stop hook (error|feedback)`, `Ran \d+ stop hooks?`, `[master|main <sha>]`). Prevents pasted Claude Code session logs from seeding a spurious `/fix` chain via the legacy `\bfix\b` pattern. Explicit slash commands (`/fix`, `/plan`, …) still bypass the heuristic via `extractExplicitHarnessCommand`. Rollback: `SMELTER_SKIP_TRANSCRIPT_HEURISTIC=1`.

`scripts/stop-stage-enforcer.mjs::buildBlockReason` entry_not_started branch includes a `/cancel` escape hint so users whose legitimate prompt was nonetheless mis-seeded can clear state without completing the whole workflow chain.

---

## Appendix C — Implementation Roadmap (checklist)

| # | Item | Depends on | Notes |
|---|------|-----------|-------|
| 1 | `state.json` schema v2.4.1 | none | single source of truth |
| 2 | Mode classifier (`scripts/mode-classifier.mjs`) | 1 | natural-language → mode |
| 3 | Mode definition files (`modes/*.json`) | 1 | 6 modes + allowed_skills |
| 4 | 14 `skills/workflow-*/SKILL.md` | 1 | contract + default pattern |
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
| 16 | Multi-Pass Verification engine | 4 | 3-round enforcement for review skills |
| 17 | Feature state integrity utility (`feature-version-check.mjs`) | 1 | orphan scan |
| 18 | `/verify` mode + `workflow-verify` skill | 4, 13 | tests + static + real-interface E2E |
| 19 | **E2E real-interface enforcement (§8)** | 13 | R11 CRITICAL block, artifact_missing / mocked_interface causes, per-surface artifact gate |

---

**End of workflow.md**
