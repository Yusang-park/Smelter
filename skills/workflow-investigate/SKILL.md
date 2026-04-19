---
name: workflow-investigate
version: 2.4.1
type: workflow
consumes: brainstorm.md OR trigger_prompt
produces: investigation.md
default_pattern: C
default_agent: explore-medium
supports_patterns: [A, C]
team_template:
  C:
    parallel_split_by: area
    agents: [explore-medium]
    aggregator: architect
    conflict_resolver: conflict-resolver
    sync_point: "investigation.md merge"
can_delegate_to: [explore-high, researcher]
gate:
  postcondition:
    - file_exists: "investigation.md"
    - min_sections: 2
---

# workflow-investigate

Investigates existing code, data, and external documents. Default is **Pattern C parallel** (split by area).

## Split criteria (`parallel_split_by: area`)

| Area | Agent |
|------|-------|
| `database-schema` | explore-medium |
| `api-surface` | explore-medium |
| `ui-components` | explore-medium |
| `security` | security-reviewer (optional) |
| `external-docs` | researcher |

On re-entry after `workflow-tasker`, a restricted run limited to a specific area is allowed.

## Output

`investigation.md`:
- `## Findings by Area` — per-area summary
- `## Relevant Files` — path list
- `## Risks Identified` — discovered risks
- `## Data Flow` (if applicable)

The aggregator (`architect`) merges per-area results into a single document.

## On conflict

When contradictory interpretations of the same component are found, invoke `conflict-resolver` (section 12-7).

## Fail routing (producer)

- None (origin point). On hook gate failure, self re-entry.
