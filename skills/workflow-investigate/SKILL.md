---
name: workflow-investigate
version: 0.51
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
    - file_exists: ".smt/features/<active-slug>/task/investigation.md"
    - min_sections: 2
---

# workflow-investigate

## Overview

Investigates existing code, data, and external documents. Default is **Pattern C parallel** (split by area). Output is the active task's canonical `.smt/features/<active-slug>/task/investigation.md`, consumed by the active mode's next stage: `workflow-tasker` for `/brainstorm`, `workflow-implementation-plan` for `/implement`, `workflow-infra-plan` for `/infra`, `workflow-write-test` for `/fix`, or mode transition for `/explore`.

**Core principle:** Evidence from the current codebase, not memory or assumption, is the source of truth for the plan. Every finding must cite a file path or external reference.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-investigate to gather evidence from the code and external docs into the active task's canonical `investigation.md`."

## `/fix` systematic debugging flow

When active mode is `/fix`, this skill follows the superpowers systematic-debugging experience before any test or code change:

1. **Read the failure carefully** — capture exact errors, stack traces, symptoms, commands, URLs, inputs, and observed output.
2. **Reproduce consistently** — document exact reproduction steps. If reproduction is not possible, identify the missing data and add only diagnostic evidence requests; do not guess.
3. **Check recent changes** — inspect current diff, related commits, config changes, dependency changes, or environment changes that could explain the regression.
4. **Trace data flow** — identify where the bad value, missing state, or wrong branch first appears. In multi-component paths, inspect each boundary.
5. **Compare working examples** — find similar working code in this repo and list the relevant differences.
6. **State one root-cause hypothesis** — write why this is the root cause and what observation supports it.
7. **Define the regression test target** — specify the exact RED test or interface assertion `workflow-write-test` must create.

For `/fix`, the canonical `investigation.md` must include `## Reproduction`, `## Root Cause`, and `## Regression Test Target` in addition to the standard sections.

## The Iron Law

```
NO PLAN WITHOUT EVIDENCE FROM CODE — EVERY FINDING CITES A FILE
```

You may not hand off to `workflow-tasker` until the canonical `investigation.md` lists actual files, actual schemas, actual existing behaviors — not "I believe X", "typically X does Y", or "the pattern seems to be X". Pattern guesses without a grep or a file path are not evidence.

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

Write exactly one canonical artifact:

`.smt/features/<active-slug>/task/investigation.md`

Resolve `<active-slug>` from the active workflow pointer (`.smt/state/active-feature-<session_id>.json`, falling back to `.smt/state/active-feature.json` only when no session id is available). Do not write `investigation.md` in the repository root or current working directory.

`investigation.md` must contain:

- `## Findings by Area` — per-area summary (each item cites path or URL)
- `## Relevant Files` — path list
- `## Risks Identified` — discovered risks
- `## Data Flow` (if applicable)
- `## Reproduction` (required for `/fix`) — exact steps, command, request, UI path, or reason reproduction is blocked
- `## Root Cause` (required for `/fix`) — source-level cause, not symptom
- `## Regression Test Target` (required for `/fix`) — behavior the RED test must prove

The aggregator (`architect`) merges per-area results into a single document.

## Red Flags - STOP

| Thought | Reality |
|---------|---------|
| "I remember how this codebase works" | Memory is not evidence. File is truth (Iron Law #5). Read it. |
| "The pattern is typically X" | Pattern guesses are not findings. Grep for actual usage before claiming. |
| "External docs say it works this way" | Cite the URL. Findings without references are unverifiable by the reviewer. |
| "One file is enough to understand this" | Pattern C splits by area for a reason. Investigate the areas tasker will need. |
| "I'll investigate as I code" | Downstream tests and coding consume investigation-backed artifacts. Investigate now or the whole chain has no base. |
| "The fix is obvious" | Obvious symptom is not root cause. Reproduce, compare, and write the hypothesis before test design. |
| "Just try this patch" | Guess-and-check is not debugging. One hypothesis, one observation, then a RED test. |

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

On `/explore` mode, the review still runs; mode transition only happens on `pass` after review.
