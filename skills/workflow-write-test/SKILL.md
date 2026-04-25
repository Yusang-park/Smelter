---
name: workflow-write-test
version: 0.4.0
type: workflow
consumes: investigation.md OR implementation-plan.md OR tasks.md
produces: "*.test.*" files (RED), test_cycles entries
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

Test-first principle. Write failing tests before any implementation file. `workflow-coding` refuses to start without at least one RED entry in `state.json.test_cycles`.

**Core principle:** If you didn't watch the test fail, you don't know if it tests the right thing.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-write-test to write failing tests before any source code changes."

## Plan source by mode

Read the active mode's persisted planning source before writing tests:

- `/fix` → `investigation.md` is the source of the bug, reproduction evidence, and expected corrected behavior.
- `/implement` → `implementation-plan.md` is the source of the file map, chosen approach, task queue, and test strategy.
- `/brainstorm` does not invoke this skill directly; its `tasks.md` is consumed later by `/implement` as requirements context.

Do not route `/fix` through `workflow-tasker`. Fix scope is intentionally narrow: investigation evidence is enough to design the RED regression test. If the fix scope is too large for that, request a mode upgrade instead of silently widening `/fix`.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over. No exceptions:

- Don't keep it as "reference"
- Don't "adapt" it while writing tests
- Don't look at it
- Delete means delete

Implement fresh from tests. Period.

## Minimum cases per category (10+ total)

| Category | Minimum |
|----------|---------|
| happy path | 2+ |
| boundary | 2+ |
| error path | 2+ |
| edge case | 2+ |
| integration | 1+ |

A test file with 9 cases fails the gate. A test file with 10 happy-path cases and no boundary/error coverage also fails because the distribution check runs.

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "I'll write tests after the code compiles" | That's not TDD. Delete the code, write tests first. |
| "Just this once, the code is trivial" | Triviality is rationalization. Write the test. |
| "I'll keep the existing code as reference while writing the test" | Don't look at it. Implement fresh from tests. |
| "10 cases is overkill for this change" | The gate checks distribution, not just count. Plan distribution before writing. |
| "Tests don't need to fail — I know the function works" | Watch it RED. Tests that are GREEN on first run test nothing. |
| "Mocks are fine for this test" | Prefer real code. Mocks hide the bug the test should catch. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "I'm confident it works" | Confidence ≠ evidence. Run the test RED, then GREEN. |
| "I'm tired" | Exhaustion ≠ excuse. TDD is the speed shortcut, not the slowdown. |
| "The spec already tests this" | `workflow-write-test` produces NEW RED cases for the current change. Existing tests are not new evidence. |
| "Integration tests are enough" | Integration ≠ unit. Distribution requirement is there for a reason. |

## When modifying existing features

- Search related existing tests
- Modify existing tests to reflect the new intent so they go RED (`action: modified_case`)
- Link `case_name` to the task/bug id

## Surface Exemption

When `state.json.exempt.tdd == true`, this skill is **auto-skipped** and flow advances to the next skill.
(Set via the mode's magic_keywords or a tasker declaration.)

Exempt surfaces: CSS/style, typography, i18n/copy-only, typo, pure dialogue. The exemption must be declared up-front by the mode or tasker — the executor cannot demote TDD mid-flow.

## Parallel execution (Pattern C)

When Pattern C is chosen with `parallel_split_by: file`:

- A separate agent writes each test file
- The aggregator (executor) verifies test suite integrity

## After output

Append to `state.json.test_cycles`:

```json
{ "file": "...", "action": "added_case", "case_name": "...", "run_result": "fail", "error": "..." }
```

`workflow-coding` pre-gate reads this array. Without at least one `{ action: added_case|modified_case, run_result: fail }` entry, coding refuses to start.

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
