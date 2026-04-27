---
name: workflow-infra-execute
version: 0.51
type: workflow
consumes: infra-plan.md, infra-plan-review.md
produces: infra-execute.md
default_pattern: A
default_agent: executor
can_delegate_to: [executor]
gate:
  postcondition:
    - file_exists: "infra-execute.md"
    - commands_and_results_recorded: true
---

# workflow-infra-execute

## Overview

Execute only the approved infrastructure plan. Do not expand scope during execution.

## Before Mutation

- Re-read `infra-plan.md` and `infra-plan-review.md`.
- If the planned action is destructive/shared and there is no explicit approval in the current conversation, stop and ask for approval.
- Confirm account/profile/region/stage in the command arguments before running mutating commands.

## Output

Write `infra-execute.md` with:

- `## Commands Run` — exact commands, profile/region/stage, timestamps when useful.
- `## Results` — exit codes and relevant output summaries.
- `## Resources Changed` — created/updated/deleted resources.
- `## Documentation Updated` — `Infra.md` or other inventory docs updated.
- `## Verification Handoff` — commands/checks `workflow-verify` must run.

## Rules

- Do not run unrelated cleanup.
- Do not delete data stores unless named in the approved scope.
- Do not hide partial failures; record them and route to verification/recovery.

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL:** `workflow-verify`
