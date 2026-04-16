# Smelter: /plan — Deep Planning Command

Run Steps 1–3 + deep interview on $ARGUMENTS. Creates or refines `.smt/features/<slug>/` planning state.

Internally drives `workflows/tasker.yaml` via the step engine. Execution happens later via `/build` or `/fix`.

**Core rule: agents do not memorize — agents read files.**

## Task
$ARGUMENTS

## Protocol

### Planning protocol

1. Propose and refine planning text directly in `.smt/features/<slug>/task/` files.
2. Keep `.smt/` as the source of truth for planning state.
3. Use deep interview when the request is vague, high-risk, or requires requirement discovery.
4. Continue autonomously when the likely next step is clear. Ask only for truly blocking ambiguity.

### Engine protocol

1. Engine seeds `.smt/features/<slug>/state/workflow.json` at `step: step-1` on first run.
2. Follow the injected step prompt — step-1 (Problem Recognition), step-2 (Learning), step-3 (Planning), step-3-interview (planning summary / routing).
3. Workflow ends at step-3-interview; downstream execution is `/build` or `/fix`.

### Interview vs. direct mode

| Mode | Trigger | Behavior |
|------|---------|----------|
| Deep interview | Default for vague or strategic work | One question at a time, assumption-seeking |
| Direct planning | Detailed request | Compress discovery and move to step-3 |

**Adaptive context gathering:** spawn `explore` for codebase facts, reserve questions for user preferences and unresolved product intent.

Never ask multiple questions in one message.

## Output structure

```
{PROJECT_ROOT}/.smt/features/<slug>/
├── task/
│   ├── plan.md  ← goal, scope, acceptance criteria
│   └── <task-name>.md ← individual task (atomic, agent-readable)
└── decisions.md
```

## Scope — what /plan does NOT do

- No TDD, implementation, review, or E2E. Those belong to `/build` and `/fix`.
- No code edits outside `.smt/`.

## Quality criteria

- 80%+ claims cite file/line references
- 90%+ acceptance criteria are testable
- No vague terms without metrics
- No `{{...}}` placeholders
