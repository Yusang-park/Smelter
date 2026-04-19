---
name: workflow-human-check
version: 2.3.0
type: workflow
consumes: all artifacts + team_review.md
produces: user decision (rework | complete | hold | upgrade)
default_pattern: User
supports_patterns: [User]
halts_session: true  # The only allowed halting point
gate:
  postcondition:
    - user_decision: "rework | complete | hold | upgrade"
---

# workflow-human-check

Final user review. The one Iron Law #1 exception: waiting for user input is allowed.

## Presented Report

```
┌────────────────────────────────────────────────┐
│              Human Review Report               │
├────────────────────────────────────────────────┤
│ Feature  : <slug>                              │
│ Task     : <title>                             │
│ Mode     : <mode>                              │
│ Stages   : [list of completed workflow skills] │
│                                                │
│ Artifacts:                                     │
│   - Video : <path>                             │
│   - Log   : <path>                             │
│   - Diff  : <summary>                          │
│                                                │
│ Risks   : <## Risks section>                   │
│ TDD     : <test_cycles summary>                │
│ E2E     : <surface + pass/fail>                │
└────────────────────────────────────────────────┘
```

## User choices

```
[1] rework   → specify rework targets → create active_feedback → route to target_skill
[2] complete → Git options (push current branch / new branch / local only)
[3] hold     → record status: blocked
[4] upgrade  → upgrade mode (simple_fix→fix, etc.)
```

## On Rework (fail routing)

Create an `active_feedback` entry:
```json
{
  "id": "fb-<timestamp>",
  "from": "workflow-human-check@<ISO>",
  "target_skill": "<user-specified or default workflow-coding>",
  "text": "<user feedback>",
  "resolved": false
}
```

## On Complete (wrap up)

1. `state.json.current_stage: done`
2. Task md checkbox `[x]`
3. Append to `session/YYYY-MM-DD.md` log
4. Write `results.md` (video, log, branch, PR)
5. Perform Git options

## Full regression

Only on explicit user request: run full `pnpm test` / `npx playwright test`.
