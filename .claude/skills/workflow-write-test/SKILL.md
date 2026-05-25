---
name: workflow-write-test
description: Create executable RED specifications before implementation, or record valid Smelter TDD exemptions.
version: 0.55
type: workflow
consumes: tasks.md OR implementation-plan.md
produces: executable specification tests (RED), test_cycles entries
default_pattern: C
default_agent: executor
supports_patterns: [A, C]
team_template:
  C:
    parallel_split_by: file
    agents: [executor]
    aggregator: executor
    sync_point: "test suite ready"
can_delegate_to: [tdd-guide, test-driven-development]
gate:
  postcondition:
    - test_files_exist: true
    - min_cases: 10
    - all_red: true
    - test_cycle_entries: ">=1 with action=added_case"
exempt_if_surface: [css, style, typography, i18n, copy, typo, dialogue]
---

# workflow-write-test

## Overview

Write an executable specification before any implementation file changes. The output is a failing test suite that specifies the requested behavior with concrete examples, then records RED evidence for the next skill.

Use Specification by Example, BDD, and ATDD principles: clarify behavior through examples, formulate those examples as tests, and automate them before coding.

**Core principle:** If you didn't watch the executable specification fail for the intended missing behavior, you don't know if it tests the right thing.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-write-test to write failing executable specifications before source code changes."

## Plan source by mode

Read the active mode's persisted planning source before writing tests:

- `/fix` → `tasks.md` is the compact v0.55 checklist; use `investigation.md` only as supporting evidence.
- `/implement` → `implementation-plan.md` is the source of the file map, chosen approach, task queue, and test strategy.
- `/brainstorm` does not invoke this skill directly; its `tasks.md` is consumed later by `/implement` as requirements context.

Use the persisted plan as input only. If the behavior cannot be expressed as a failing test, stop and route back for clarification instead of coding.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write implementation code before the executable specification? Delete it. Start over. No exceptions:

- Don't keep it as "reference"
- Don't "adapt" it while writing tests
- Don't look at it
- Delete means delete

Implement fresh from the executable specification. Period.

## Executable Specification Contract

Every new or modified test must specify externally observable behavior, not implementation details. Prefer Given/When/Then for scenarios or Arrange/Act/Assert for unit-level specs.

Each spec must include:

- Behavior being specified
- Concrete domain values, not vague placeholders
- Initial state and trigger action
- Expected observable outcome
- Meaningful boundary, edge, and error examples
- Exact RED command and failing output before implementation

Do not assert private helpers, internal call order, temporary structure, or other implementation details unless they are the public contract. Open behavior questions block coding; return to clarification rather than inventing behavior.

## Minimum Cases Per Category (10+ total)

| Category | Minimum |
|----------|---------|
| happy path | 2+ |
| boundary | 2+ |
| error path | 2+ |
| edge case | 2+ |
| integration | 1+ |

A test file with 9 cases fails the gate. A test file with 10 happy-path cases and no boundary/error coverage also fails because the distribution check runs.

Choose the lowest-level test that fully specifies the behavior:

- Pure logic/state transition: unit executable spec
- API/CLI/hook/script: integration or E2E executable spec
- Service boundary: contract test
- UI behavior: user-observable E2E spec
- Complex output or legacy behavior: approval, snapshot, or characterization spec

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "I'll write tests after the code compiles" | That's not TDD. Delete the code, write the executable spec first. |
| "Just this once, the code is trivial" | Triviality is rationalization. Write the test. |
| "I'll keep the existing code as reference while writing the test" | Don't look at it. Implement fresh from tests. |
| "10 cases is overkill for this change" | The gate checks distribution, not just count. Plan distribution before writing. |
| "Tests don't need to fail — I know the function works" | Watch it RED. Tests that are GREEN on first run test nothing. |
| "Mocks are fine for this test" | Prefer real code. Mocks hide the bug the test should catch. |
| "The test can describe internals" | Specs describe behavior. Implementation details make tests brittle. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "I'm confident it works" | Confidence ≠ evidence. Run the test RED, then GREEN. |
| "I'm tired" | Exhaustion ≠ excuse. TDD is the speed shortcut, not the slowdown. |
| "The spec already tests this" | `workflow-write-test` produces NEW RED cases for the current change. Existing tests are not new evidence. |
| "Integration tests are enough" | Integration ≠ unit. Distribution requirement is there for a reason. |

## When modifying existing features

- Search related existing tests
- Modify existing tests to reflect the new executable specification so they go RED (`action: modified_case`)
- Link `case_name` to the task/bug id

## Surface Exemption

When the upstream investigation or plan records `exempt.tdd: true`, this skill is skipped by the Archon workflow prompt and flow advances to the next node.

Exempt surfaces: CSS/style, typography, i18n/copy-only, typo, pure dialogue. The exemption must be declared up-front; the executor cannot demote TDD mid-flow.

## Parallel execution (Pattern C)

When Pattern C is chosen with `parallel_split_by: file`:

- A separate agent writes each test file
- The aggregator (executor) verifies test suite integrity

## After Output

Append a `## RED Evidence` section to the relevant artifact (`test-plan.md`, `implementation-plan.md`, or `tasks.md`):

```json
{ "file": "...", "action": "added_case", "case_name": "...", "run_result": "fail", "error": "..." }
```

`workflow-coding` reads this artifact. Without at least one `{ action: added_case|modified_case, run_result: fail }` entry for the executable specification, coding must refuse to start.

## Fail routing

- `/fix` gate failure because the bug is not reproducible or expected behavior is unclear → `workflow-investigate`
- `/implement` gate failure because the task queue or test strategy is incomplete → `workflow-implementation-plan`
- TDD exemption mismatch → active mode recovery; do not demote TDD inside this skill

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL:** `workflow-coding`

Do NOT:
- Skip to `workflow-agent-review` or beyond — implementation has not happened yet
- Stop after tests are RED, report "tests ready", or ask "shall I implement?"
- Offer A/B/continue choices — Iron Law #1 forbids pausing at non-human-check stages

The RED tests are the gate. `workflow-coding` consumes them immediately.
