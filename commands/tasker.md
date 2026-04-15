# Smelter: /tasker — Planning State Command

Run Steps 1–3 + interview on $ARGUMENTS. Creates/refines `.smt/features/<slug>/` planning state.

Internally drives `workflows/tasker.yaml` via the step engine. Implementation happens later via `/feat` or `/qa`.

**Core rule: agents do not memorize — agents read files.**

## Task
$ARGUMENTS

## Protocol

### Plan-mode entry (MANDATORY — pre-Step 1)

1. Call native **`EnterPlanMode`** immediately at start. Emit `[Plan Mode: Enter]` yellow tag.
2. While in plan mode, propose and refine text before committing files.
3. `ExitPlanMode` auto-saves to `~/.claude/plans/<name>.md`. Record that path in `.smt/features/<slug>/task/_overview.md` under `Native Plan File:`.

### Engine protocol

1. Engine seeds `.smt/features/<slug>/state/workflow.json` at `step: step-1` on first run.
2. Follow the injected step prompt — step-1 (Problem Recognition), step-2 (Learning), step-3 (Planning), step-3-interview (user approval).
3. Workflow ends at step-3-interview; downstream execution is /feat or /qa.

### Interview vs. direct mode

| Mode | Trigger | Behavior |
|------|---------|----------|
| Interview | Default / vague input | One question at a time |
| Direct | Detailed request | Skip interview, go to step-3 |

**Adaptive context gathering:** spawn `explore` for codebase facts, reserve questions for user preferences.

Never ask multiple questions in one message.

## Output structure

```
{PROJECT_ROOT}/.smt/features/<slug>/
├── task/
│   ├── _overview.md  ← goal, scope, acceptance criteria, Native Plan File: pointer
│   └── <task-name>.md ← individual task (atomic, agent-readable)
└── decisions.md
```

## Dual-write rule

Native plan (`~/.claude/plans/<name>.md`) is human-review draft. `.smt/features/<slug>/task/_overview.md` is the execution source of truth. When finalizing, copy verbatim. On divergence, `.smt/` wins.

## Scope — what /tasker does NOT do

- No TDD, implementation, review, or E2E. Those belong to `/feat` and `/qa`.
- No code edits outside `.smt/`.

## Quality criteria

- 80%+ claims cite file/line references
- 90%+ acceptance criteria are testable
- No vague terms without metrics
- No `{{...}}` placeholders
