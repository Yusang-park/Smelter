---
name: workflow-brainstorm
version: 2.3.0
type: workflow
consumes: trigger_prompt
produces: brainstorm.md
default_pattern: D
default_agent: planner
supports_patterns: [A, D]
params:
  depth: [deep, light]
team_template:
  D:
    lead: planner
    sub_agents: [product-persona, engineer-persona, design-persona]
    synthesis_by: lead
can_delegate_to: [deep-interview, copywriting]
gate:
  postcondition:
    - file_exists: "brainstorm.md"
    - min_sections: 3
---

# workflow-brainstorm

Explores ideas, concepts, and scope. Two variants via the `depth` parameter:

- **deep** (default for plan mode): brainstorming + deep interview (multi-persona, Pattern D)
- **light** (default for implement mode): short interview (single planner, Pattern A)

## Required output

`brainstorm.md` sections:
- `## Goal` — one-line goal
- `## Scope` — in-scope / out-of-scope
- `## Constraints` — technical and business constraints
- `## Candidate Approaches` — 2–4 options (deep mode only)
- `## Open Questions` — deferred questions

## Entry output format

```
--- Skill: workflow-brainstorm (mode: <mode>, depth: <deep|light>, agent: <agent>) ---
Goal: <one-line goal>
```

## Reshape rule

None (this skill is an origin point).

## Fail routing

- hook validation failure (brainstorm.md not produced) → self re-entry (same skill re-run, different prompt)
