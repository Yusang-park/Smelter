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
| 5 | **File is truth** | Skill completion is recognized only via **file-verifiable postconditions**. Self-claims are rejected. |
| 6 | **Workflow whitelist is user-decision** | Only `workflow-*` skills are constrained by the mode's `allowed_skills`. If a workflow skill outside the current mode is needed, the agent does not decide — it **requests a user-gated mode upgrade**. Utility skills (`ui-ux-pro-max`, `copywriting`, `claude-api`, ...) are **freely usable** with no constraint. |
| 7 | **Independent queues, shared sessions, specialist agents** | Each task's **Queue** is independent. Multiple tasks may share a session. Tasks may delegate to **specialist agents** (frontend, backend, security, ...). **Team Agents** (multi-agent collaboration) are supported. |
| 8 | **Scoped testing** | Only tests related to changed files run by default. Full regression only at `workflow-human-check` with explicit request. |

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

Commands are **hints**; the default is **rule-based auto-routing** from natural-language input. Users can invoke explicit slash commands, but when an utterance arrives the classifier assigns a mode at entry.

#### Auto-routing table

| Input pattern (natural language) | Mode | Explicit command |
|----------------------------------|------|------------------|
| "파악해", "분석해", "how does X work?", "investigate", "verify" (static), "validate", "check", "확인", "검증", "체크" | `investigate` | `/investigate` |
| "테스트 해봐", "점검해", "돌려봐", "실행해", "run tests", "health check" | `verify` | `/verify` |
| "만들거야", "리팩토링할거야", "설계해", "기획해", "design", "refactor" | `plan` | `/plan` |
| "~만들어줘", "~추가해줘", "~구현해줘", "implement", "extend" | `implement` | `/implement` |
| "텍스트 수정", "이름 바꿔", "색깔 변경", "css", "오타", "번역" | `simple_fix` | `/simple-fix` |
| "버그", "문제", "에러", "작동 안 해", "고쳐줘", "bug", "fix" | `fix` | `/fix` |
| ambiguous | `fix` (safe default) | — |

**Principles**:
- The classifier runs **only at entry**. Mid-workflow mode changes are user-gated (upgrade).
- Routing is **rule-based** — no LLM inference (Iron Law #2, no evasion).
- An explicit slash command **overrides** the classifier.

#### Mode summary

| Mode | Entry skill | Purpose |
|------|-------------|---------|
| `simple_fix` | `workflow-coding` | Text/CSS/constant substitution. |
| `fix` | `workflow-investigate` | Bug / logic repair. |
| `investigate` | `workflow-investigate` | Static read only (맥락·근거 파악). Exits via mode transition. |
| `verify` | `workflow-verify` | Non-modifying verification (test run + static inspection + real-interface E2E). Single report output. |
| `plan` | `workflow-brainstorm` (deep) | New feature / refactor, planning first. |
| `implement` | `workflow-brainstorm` (light) | Lightweight build on existing code. |

### 1-3. Magic Keywords

Natural-language tokens that flip flags independently of the auto-routing branch:

| Keyword | Action |
|---------|--------|
| `css`, `style`, `텍스트`, `i18n`, `typo`, `dialogue` | auto-set `workflow-write-test` TDD exemption (surface-based) |
| `extend`, `add to`, `덧붙여` | skip `workflow-brainstorm` in `implement` |
| `fix`, `bug`, `버그`, `문제` | nudge toward `fix` mode (even inside `/simple-fix` upon interface change detection) |

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

### 2-3. Token optimization

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
| 2 | `workflow-brainstorm-review` | `brainstorm.md` | `brainstorm_review.md` | pass/fail/reshape |
| 3 | `workflow-investigate` | brainstorm.md or trigger | `investigation.md` | static read (structure, references) |
| 4 | `workflow-investigate-review` | `investigation.md` | `investigate_review.md` | pass/fail/reshape |
| 5 | `workflow-tasker` | investigation.md (+brainstorm.md) | `plan.md`, `target_type`, initial `team_runtime` | |
| 6 | `workflow-tasker-review` | `plan.md` | `tasker_review.md` | side-effect / scope check; pass/fail/reshape |
| 7 | `workflow-write-test` | `plan.md` | `*.test.*` (RED), `test_cycles` entries | surface-based exemption applies |
| 8 | `workflow-coding` | `*.test.*` (RED) or `active_feedback` | `src/**` changes | implementation |
| 9 | `workflow-agent-review` | `src/**` diff | `agent_review.md`, `## Risks` updates | Pattern B Dual Adversarial (code-reviewer + security-reviewer). "no security surface" → A. |
| 10 | `workflow-e2e` | built `src/**` | `artifacts/` (video / screenshots / logs / transcripts / IO samples) | **Drives the real interface** (browser, subprocess, HTTP port, DB engine, hook pipe). Test-runner stdout alone is NOT a valid pass. |
| 11 | `workflow-e2e-review` | `artifacts/` | `e2e_review.md` | scenario coverage / artifact quality |
| 12 | `workflow-team-code-review` | whole change | `team_review.md` (severity-tagged) | **Multi-agent 95% consensus** |
| 13 | `workflow-verify` | current codebase (no RED required) | `verify_report.md` (Phase 1 tests + Phase 2 static inspection + Phase 3 E2E interface) | Entry skill of `/verify`. Non-modifying. Not a review skill — no Multi-Pass rounds. |
| 14 | `workflow-human-check` | all artifacts | user decision (`rework` / `complete` / `hold` / `upgrade`) | final gate |

---

## 4. Mode Definitions

Each mode is a subset of the 14 workflow skills plus an entry point.

### 4-1. simple_fix (`/simple-fix`)

**allowed**: `workflow-coding`, `workflow-e2e`, `workflow-human-check`.
**defaults**: `exempt.tdd: true`, `exempt.e2e: false`.
Interface changes force `/fix` mode upgrade at `workflow-human-check`.

### 4-2. fix (`/fix`)

**allowed**: all 11 core skills (no brainstorm; investigate-first pipeline).
Full bug-repair pipeline: investigate → investigate-review → tasker → tasker-review → write-test → coding → agent-review → e2e → e2e-review → team-code-review → human-check.

### 4-3. investigate (`/investigate`)

**allowed**: `workflow-investigate`, `workflow-investigate-review`.
Static read only. Exits via user-chosen mode transition.

### 4-4. verify (`/verify`)

**allowed**: `workflow-verify`, `workflow-e2e`, `workflow-e2e-review`, `workflow-human-check`.
**defaults**: `exempt.tdd: true`, `exempt.e2e: false`.
Non-modifying verification. `workflow-verify` runs three phases in one invocation (tests + static inspection + real-interface E2E). Report-only. Fails route to `/fix` via mode upgrade (or chain auto-advance).

### 4-5. plan (`/plan`)

**allowed**: brainstorm + investigate + tasker (+ reviews). Planning-only mode.
Entry: `workflow-brainstorm` with `depth: deep`. Exits to `/implement`.

### 4-6. implement (`/implement`)

**allowed**: all 14 skills.
Entry: `workflow-brainstorm` with `depth: light`. Full pipeline after brainstorm.
`extend` / `add to` / `덧붙여` magic keywords skip brainstorm.

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
                                    OR workflow-e2e          (artifact_missing / mocked_interface)
workflow-e2e-review          ─fail─▶ workflow-coding          (insufficient_scenario)
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
simple_fix ──▶ fix ──▶ implement ──▶ plan
              ◀──     ◀──           ◀──
```

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

### 8-4. Enforcement

- `workflow-e2e` gate postconditions include `real_interface_invoked`, `no_interface_mocks`, `per_surface_artifact_present`.
- `critic-watchdog` rule R11 (CRITICAL) blocks any attempt to record an E2E pass while `artifacts/` holds none of the allowed file types (`.webm`, `.mp4`, `.png`, `.jpg`, `.log`, `.transcript`, `.json`, `.sql`, `.exit`).
- New fail causes: `artifact_missing`, `mocked_interface`. Both route to `workflow-e2e` (self-rerun with correct runner / without mocks).

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

---

## 10. Human Check

### 10-1. Presented report

```
┌────────────────────────────────────────────────┐
│              Human Review Report              │
├────────────────────────────────────────────────┤
│ Feature  : <slug>                              │
│ Task     : <title>                             │
│ Mode     : <mode>                              │
│ Stages   : [completed workflow skills]         │
│ Artifacts:                                     │
│   - Video : <path>                             │
│   - Log   : <path>                             │
│   - Diff  : <summary>                          │
│ Risks    : <## Risks section>                  │
│ TDD      : <test_cycles summary>               │
│ E2E      : <surface + pass/fail + artifacts>   │
└────────────────────────────────────────────────┘
```

### 10-2. User options

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
     └── drop payload to .smt/state/auto-confirm-queue.json
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
| Last assistant message asks permission ("진행할까요?", "shall I proceed?", "ready to continue?", etc.) | **auto-confirm: continue (spawn sub-agent with selected model)** |
| No signal + no proceed prompt | **halt** (no infinite loop) |

The queued payload includes `sub_agent_model` so the next-turn agent spawns the work via a sub-agent using the selected model. Default = `sonnet`. When `~/.smt/config.json.codexMode === true` or env `CODEX_MODE=1`, the model switches to `haiku` (mini) for the Codex CLI runtime.

### 11-3. Risk auto-tasking (sub-tasker)

Trigger keywords in the agent's response:
- "리스크", "위험", "주의해야", "잠재적"
- "TODO", "나중에", "추후"
- "고려 필요", "검토 필요"
- "이상하지만", "임시로", "일단"

Flow: keyword → call `sub-tasker` agent → extract the risk from context → create a new task under `.smt/features/<slug>/task/risk-<timestamp>.md` → append id to `state.sub_tasks[]` → original workflow continues.

### 11-4. Halt conditions (only allowed)

1. Explicit user stop (`/cancel`, `/stop`, or manual abort).
2. `workflow-human-check` awaiting user input.
3. Mode-upgrade decision awaited.
4. `investigate` mode terminal (user picks the next mode).
5. **No actionable signal AND last assistant message contains no proceed prompt** — halt to prevent the previous "no explicit signal, prompting to proceed" infinite loop. The Stop hook reads the last message every time; only auto-confirms when the agent explicitly asked permission (see §11-2).

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

`codexMode: true` (or env `CODEX_MODE=1`) switches the queued sub-agent model from `sonnet` (default) to `haiku` for the Codex CLI runtime.

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

- **Layer 1** — `scripts/critic-watchdog.mjs` (PostToolUse hook, **11 formal rules**, millisecond latency):

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
| **R11** | **E2E pass claim without real-interface artifact** | **CRITICAL** |

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
       ┌──────┬──────────┬─────────┬──────┼───────┬──────────┐
       ▼      ▼          ▼         ▼      ▼       ▼          ▼
  simple_fix fix    investigate  verify  plan  implement  (explicit override)
       │       │          │         │      │        │
       │       ▼          ▼         ▼      ▼        ▼
       │   ╭────────────────────────────────────────────────╮
       │   │           SHARED PIPELINE (workflow-*)          │
       │   │                                                  │
       │   │  brainstorm ◀──▶ investigate                    │
       │   │       │                │                         │
       │   │       ▼                ▼                         │
       │   │  brainstorm-review  investigate-review          │
       │   │                        │                         │
       │   │                        ▼                         │
       │   │  tasker ──▶ tasker-review                       │
       │   │                        │                         │
       │   │                        ▼                         │
       │   │  write-test ──▶ coding                          │
       │   │                        │                         │
       │   │                        ▼                         │
       │   │  agent-review ──▶ e2e (real interface)          │
       │   │                        │                         │
       │   │                        ▼                         │
       │   │  e2e-review ──▶ team-code-review                │
       │   │                        │                         │
       │   │                        ▼                         │
       │   │                  human-check                     │
       │   ╰──────────────────────┬──────────────────────────╯
       │                          │
       │                          ▼
       └──────────▶         ╭───────────────╮
                            │workflow-coding│
                            ╰───────────────╯
                                    │
                                    ▼
                         workflow-e2e → workflow-human-check
                         (simple_fix path)

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
    ├── queue/SKILL.md
    ├── deep-interview/SKILL.md
    └── ...

modes/
├── simple_fix.json
├── fix.json
├── investigate.json
├── verify.json
├── plan.json
└── implement.json

commands/
├── simple-fix.md
├── fix.md
├── investigate.md
├── verify.md
├── plan.md
└── implement.md

scripts/
├── auto-confirm.mjs              ← §11 Stop hook (queue-drop)
├── auto-confirm-consumer.mjs     ← UserPromptSubmit consumer
├── state-schema.mjs              ← state.json schema + validator (§2)
├── mode-classifier.mjs           ← natural-language routing (§1-2)
├── route-on-fail.mjs             ← producer chain (§5-1)
├── stall-detector.mjs            ← §11-6 stall signals + cascade
├── critic-watchdog.mjs           ← Pattern E Layer 1 (11 rules, §12-5)
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
| Simple-fix vs fix routing | **Auto-classifier first** (pattern match); `/simple-fix` and `/fix` overrides. |
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
| 13 | Critic Watchdog Hook Layer 1 | 1, 6 | 11 rules (R01–R11) |
| 14 | Critic Watchdog Agent Layer 2 | 13 | periodic semantic checks |
| 15 | Pattern D Hierarchical (tasker / brainstorm) | 4 | architect + personas |
| 16 | Multi-Pass Verification engine | 4 | 3-round enforcement for review skills |
| 17 | Feature state integrity utility (`feature-version-check.mjs`) | 1 | orphan scan |
| 18 | `/verify` mode + `workflow-verify` skill | 4, 13 | tests + static + real-interface E2E |
| 19 | **E2E real-interface enforcement (§8)** | 13 | R11 CRITICAL block, artifact_missing / mocked_interface causes, per-surface artifact gate |

---

**End of workflow.md**
