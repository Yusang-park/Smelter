---
name: workflow-tasker
version: 2.4.1
type: workflow
consumes: investigation.md (+brainstorm.md optional)
produces: plan.md, target_type, team_runtime initial assignment
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
    - file_exists: "plan.md"
    - plan_has_queue: true
    - target_type_set: true
    - team_runtime_populated: true
---

# workflow-tasker

Based on investigation results, decides the **plan, queue, and team composition**.

## Three core artifacts

### 1. `plan.md`
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

## Entry output format

```
--- Skill: workflow-tasker (mode: <mode>, agent: architect) ---
Goal: Produce plan, target_type, and team_runtime for <feature>
```

## Fail routing

- gate failure (empty team_runtime, etc.) → self re-run
- `workflow-tasker-review` declaring fail/reshape → returns here
