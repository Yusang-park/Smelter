---
name: workflow-tasker
version: 0.4.0
type: workflow
consumes: investigation.md (+brainstorm.md optional)
produces: tasks.md (+ target_type + team_runtime initial assignment)
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
    - plan_has_queue: true
    - target_type_set: true
    - team_runtime_populated: true
---

# workflow-tasker

## Overview

Based on investigation results, decides the **plan, queue, and team composition**. Produces the single artifact that `workflow-write-test`, `workflow-coding`, and every downstream skill consume.

**Core principle:** No implementation work begins until the plan, target_type, and team_runtime are all written. Missing any one of the three is a gate fail.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-tasker to produce tasks.md + target_type + team_runtime from the investigation."

## The Iron Law

```
NO IMPLEMENTATION SKILL WITHOUT tasks.md + target_type + team_runtime
```

`workflow-write-test` and `workflow-coding` both refuse to start if any of the three postconditions is missing. The hook gate is:

- `file_exists: tasks.md`
- `plan_has_queue: true`
- `target_type_set: true`
- `team_runtime_populated: true`

All four must hold. Partial plans do not advance.

## Three core artifacts

### 1. `tasks.md`

```markdown
## Goal
<one-line goal>

## Approaches
- [x] Chosen: <approach + rationale>

## Queue
- [ ] Task 1: <description>
  - [ ] 1-1: <detail>
- [ ] Task 2: ...
- [ ] TDD (minimum 10 cases)
- [ ] E2E

## Target Type
<new_feature | refactor | extend_existing | migration | bug_fix>
```

### 2. `state.json.target_type`

One of the fixed enum values.

### 3. `state.json.team_runtime` (initial assignment)

Assign a Pattern + agent for each downstream workflow-* skill.

#### Assignment principles

- Default: follow mode's `default_team_overrides`
- Override conditions:
  - security sensitive → force `workflow-agent-review` Pattern B
  - low complexity → demote Pattern C to A
  - frontend/backend separable → promote `workflow-coding` to Pattern C

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "I know the tasks, why write them in tasks.md" | Downstream implementation reads persisted task artifacts. In-head tasks are invisible to them. |
| "Team assignment can wait" | `team_runtime` gates pattern selection downstream. An empty field forces Pattern A defaults even when the tasker would have chosen B or C. |
| "Target type is obvious" | `target_type` drives mode-specific routing (e.g., migration forces extra review). Set it explicitly. |
| "Queue is too granular" | Bite-sized tasks are the contract with `workflow-coding`. Each queue item maps to a TDD cycle. |
| "Skip the 2–3 approaches section, I already picked one" | The rejected approaches and rationale are audit evidence for `workflow-tasker-review`. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Security isn't touched here" | Tasker declares `security_surface: false` explicitly. Absence is ambiguous — default Pattern B stays on. |
| "Plan is short, skip the queue" | No queue = gate fail. The queue is what `workflow-coding` iterates on. |
| "I'll populate team_runtime later" | Later = never. Fill it now or downstream skills run with wrong defaults. |

## Entry output format

```
--- Skill: workflow-tasker (mode: <mode>, agent: architect) ---
Goal: Produce plan, target_type, and team_runtime for <feature>
```

## Fail routing

- gate failure (empty team_runtime, etc.) → self re-run
- `workflow-tasker-review` declaring fail/reshape → returns here

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL:** `workflow-tasker-review`

Do NOT:
- Invoke `workflow-write-test`, `workflow-coding`, or any implementation skill
- Stop after tasks.md is written, report "tasks ready", or ask for approval
- Offer A/B/continue choices — Iron Law #1 forbids pausing at non-human-check stages

The `workflow-tasker-review` 95% consensus + 2-round pass is the only gate that releases downstream execution.
