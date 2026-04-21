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

## Overview

Investigates existing code, data, and external documents. Default is **Pattern C parallel** (split by area). Output is `investigation.md` that downstream `workflow-tasker` consumes to build the plan.

**Core principle:** Evidence from the current codebase, not memory or assumption, is the source of truth for the plan. Every finding must cite a file path or external reference.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-investigate to gather evidence from the code and external docs into `investigation.md`."

## The Iron Law

```
NO PLAN WITHOUT EVIDENCE FROM CODE — EVERY FINDING CITES A FILE
```

You may not hand off to `workflow-tasker` until `investigation.md` lists actual files, actual schemas, actual existing behaviors — not "I believe X", "typically X does Y", or "the pattern seems to be X". Pattern guesses without a grep or a file path are not evidence.

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

- `## Findings by Area` — per-area summary (each item cites path or URL)
- `## Relevant Files` — path list
- `## Risks Identified` — discovered risks
- `## Data Flow` (if applicable)

The aggregator (`architect`) merges per-area results into a single document.

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "I remember how this codebase works" | Memory is not evidence. File is truth (Iron Law #5). Read it. |
| "The pattern is typically X" | Pattern guesses are not findings. Grep for actual usage before claiming. |
| "External docs say it works this way" | Cite the URL. Findings without references are unverifiable by the reviewer. |
| "One file is enough to understand this" | Pattern C splits by area for a reason. Investigate the areas tasker will need. |
| "I'll investigate as I code" | `workflow-coding` consumes `plan.md` which consumes `investigation.md`. Investigate now or the whole chain has no base. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Just the surface, not the internals" | Tasker needs internal side-effect data. Go deeper. |
| "Security area is optional, skip" | Optional ≠ skip. Evaluate if the change touches auth / data / permissions. |
| "I'll add risks later" | `## Risks Identified` is mandatory. Empty == "none detected", which the reviewer will challenge. |
| "One agent is faster than Pattern C" | Pattern C parallel finds contradictions across areas. A single agent can't. Demote to A only if tasker declared low complexity. |

## On conflict

When contradictory interpretations of the same component are found across parallel agents, invoke `conflict-resolver` (section 12-7). Do NOT silently pick one interpretation.

## Fail routing (producer)

- None (origin point). On hook gate failure, self re-entry with narrowed scope.

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL:** `workflow-investigate-review`

Do NOT:
- Invoke `workflow-tasker`, `workflow-coding`, or any downstream skill
- Stop the session or report "investigation complete"
- Offer continue/pause choices — Iron Law #1 forbids pausing at non-human-check stages

On `/investigate` mode, the review still runs; mode transition only happens on `pass` after review.
