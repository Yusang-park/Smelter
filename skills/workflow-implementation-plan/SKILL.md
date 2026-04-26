---
name: workflow-implementation-plan
version: 0.4.1
type: workflow
consumes: investigation.md (+brainstorm.md/tasks.md optional)
produces: implementation-plan.md
default_pattern: D
default_agent: architect
supports_patterns: [A, D]
team_template:
  D:
    lead: architect
    sub_agents: [executor, researcher]
can_delegate_to: [architect, executor, researcher]
gate:
  postcondition:
    - file_exists: "implementation-plan.md"
    - chosen_approach_set: true
    - technology_decisions_recorded: true
    - user_decision_recorded_when_tradeoff_exists: true
---

# workflow-implementation-plan

## Overview

Turns code investigation into an implementation strategy. This is not product brainstorming. It decides how the requested behavior will be built in the current codebase.

**Core principle:** prefer existing project technology and patterns unless a concrete trade-off justifies introducing something new.

**Announce at start:** "I'm using workflow-implementation-plan to decide the code-based implementation approach, including reuse vs new technology trade-offs."

## Superpowers writing-plans experience

Write the plan for a skilled engineer with zero session context. The plan must be executable from the file alone.

Before defining tasks, map the file structure:

- Exact files to create, modify, or test.
- Responsibility of each file.
- Existing patterns or APIs each change reuses.
- Boundaries between units and how they communicate.

Then write bite-sized implementation tasks. Each task should be one coherent change with explicit TDD steps:

1. Write the failing test or modify the existing test to express the new behavior.
2. Run the exact command and record the expected RED failure.
3. Implement the minimal code needed for GREEN.
4. Run the exact command and record the expected pass.
5. Refactor only after GREEN, with tests staying green.

Do not use placeholders such as `TBD`, `TODO`, "add appropriate validation", "write tests", or "similar to previous task". If a step changes code, show enough concrete code shape, API, or assertion detail for the executor to know what to do.

## Interactive Decision Rule

If investigation reveals multiple viable technical approaches, present concise options to the user before writing the final plan:

- Reuse existing technology/patterns, with expected constraints.
- Introduce or expand a technology, with migration, dependency, and maintenance costs.
- Hybrid or staged approach, if it reduces risk.

For each option include:

- What existing files, libraries, or patterns it reuses.
- What new technology or new abstraction it introduces, if any.
- Trade-offs: speed, risk, maintainability, testability, performance, security.
- Recommendation and why.

If the task is clearly `extend_existing` and the existing feature's plan/pattern is sufficient, do not invent a branch or ask for unnecessary approval. Record that the existing approach is reused and proceed.

## Output

`implementation-plan.md`:

- `## Goal` — requested behavior or change.
- `## Codebase Evidence` — cited findings from `investigation.md`.
- `## File Map` — exact create/modify/test paths and each file's responsibility.
- `## Existing Reuse` — files, functions, APIs, UI patterns, tests, and conventions to reuse.
- `## Options Considered` — only when real trade-offs exist.
- `## Chosen Approach` — selected approach, including user decision when applicable.
- `## Technology Decisions` — existing vs new technology decision log.
- `## Change Queue` — bite-sized implementation tasks mapped to files and TDD cycles.
- `## Test Strategy` — unit/integration/E2E surfaces.
- `## Risks` — side effects, rollback, and compatibility concerns.
- `## Target Type` — `new_feature | refactor | extend_existing | migration | bug_fix`.

## Self-review before handoff

Before invoking `workflow-implementation-plan-review`, check the plan against the investigation and requested behavior:

- **Coverage:** every requirement and risk has a task or explicit non-goal.
- **Placeholder scan:** no `TBD`, `TODO`, vague tasks, or missing commands.
- **Type/API consistency:** names introduced in early tasks match names used later.
- **TDD viability:** every behavior-changing task has a RED target and exact command.
- **Scope:** if this is multiple independent subsystems, split the plan before TDD.

Fix issues inline. This author self-review does not replace `workflow-implementation-plan-review`.

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "Brainstorm already planned this" | Brainstorm is PM/product planning. This stage decides code reuse and implementation mechanics. |
| "A new library would be cleaner" | New technology needs an explicit trade-off and user decision. Default to existing stack. |
| "The existing feature is close enough" | Cite the existing files and state exactly what will be reused. |
| "I'll decide during coding" | `workflow-write-test` and `workflow-coding` consume this plan. Decide before tests. |
| "The executor can infer details" | The executor gets a file, not your unstated intent. Write exact paths, commands, and expected outcomes. |
| "Similar to Task N" | Tasks may be executed independently. Repeat the relevant details. |

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL:** `workflow-implementation-plan-review`

Do NOT:
- Invoke `workflow-write-test`, `workflow-coding`, or any implementation skill directly.
- Re-run product brainstorm unless investigation proves the requested behavior is undefined.
- Ask the user to choose when there is only one low-risk existing-code path.
