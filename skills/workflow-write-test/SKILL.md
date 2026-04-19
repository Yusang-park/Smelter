---
name: workflow-write-test
version: 2.3.0
type: workflow
consumes: plan.md
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

Test-first principle. Write failing tests before any implementation file.

## Minimum cases per category (10+ total)

| Category | Minimum |
|----------|---------|
| happy path | 2+ |
| boundary | 2+ |
| error path | 2+ |
| edge case | 2+ |
| integration | 1+ |

## When modifying existing features

- Search related existing tests
- Modify existing tests to reflect the new intent so they go RED (`action: modified_case`)
- Link `case_name` to the task/bug id

## Surface Exemption

When `state.json.exempt.tdd == true`, this skill is **auto-skipped** and flow advances to the next skill.
(Set via the mode's magic_keywords or a tasker declaration.)

## Parallel execution (Pattern C)

When Pattern C is chosen with `parallel_split_by: file`:
- A separate agent writes each test file
- The aggregator (executor) verifies test suite integrity

## After output

Append to `state.json.test_cycles`:
```json
{ "file": "...", "action": "added_case", "case_name": "...", "run_result": "fail", "error": "..." }
```

## Fail routing

- gate failure → `workflow-tasker` (plan needs revisiting)
