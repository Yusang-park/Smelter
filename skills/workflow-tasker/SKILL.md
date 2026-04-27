---
name: workflow-tasker
version: 0.51
type: workflow
consumes: investigation.md (+brainstorm.md optional)
produces: tasks.md
default_pattern: D
default_agent: architect
supports_patterns: [A, D]
team_template:
  D:
    lead: architect
    sub_agents: [researcher, executor]
can_delegate_to: [architect, researcher, explore-high]
gate:
  postcondition:
    - file_exists: "tasks.md"
    - schema_version: "0.51"
    - compact_checkbox_contract: true
---

# workflow-tasker

Produce one compact `tasks.md` checklist from the investigation. `/fix` also runs this stage in v0.51, so keep it terse.

Announce: `I'm using workflow-tasker to write the v0.51 compact task checklist.`

## Output Contract

Write exactly this shape, with short one-line values:

```markdown
---
schema_version: "0.51"
target_type: bug_fix|text|design|extend_existing|new_feature|refactor|migration
surface: ["path/or/surface"]
---

# tasks

- [x] goal: <one-line outcome>
- [x] approach: <chosen minimal path>
- [ ] queue: <test/change/verify sequence>
- [x] works: <how the feature/fix is known to work>
- [x] omissions: <why no reviewed feature/requirement is dropped>
- [x] verified: <test/typecheck/e2e commands to run>
- [x] team_runtime: <workflow-write-test=A, workflow-coding=A|C, workflow-agent-review=B, workflow-e2e=A>
```

Rules:
- No long prose, alternatives matrix, or nested rationale.
- `queue` may stay unchecked because downstream stages execute it.
- Every other checkbox must be checked before invoking `workflow-tasker-review`.
- Missing `schema_version: "0.51"`, `target_type`, any checkbox label, or `team_runtime` blocks completion.

## Terminal State

Required next skill: `workflow-tasker-review`.

Do not invoke test/coding skills directly, stop after writing `tasks.md`, or ask whether to continue.
