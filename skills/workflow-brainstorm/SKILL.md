---
name: workflow-brainstorm
version: 2.4.1
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

## Overview

Explores ideas, concepts, and scope before any implementation skill runs. Two variants via the `depth` parameter:

- **deep** (default for plan mode): brainstorming + deep interview (multi-persona, Pattern D)
- **light** (default for implement mode): short interview (single planner, Pattern A)

**Core principle:** No implementation action until scope, constraints, and goal are captured on disk and a downstream skill consumes them.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-brainstorm to capture goal, scope, constraints, and candidate approaches into `brainstorm.md`."

## The Iron Law

```
NO IMPLEMENTATION SKILL BEFORE brainstorm.md EXISTS AND PASSES REVIEW
```

You may not invoke `workflow-investigate`, `workflow-tasker`, `workflow-coding`, or any implementation skill until `brainstorm.md` is written, persisted under `.smt/features/<slug>/task/`, and `workflow-brainstorm-review` has declared `pass`.

This applies to every project regardless of perceived simplicity. "A todo list, a single-function utility, a config change" — all of them go through this gate. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST write it and submit it to review.

## Required output

`brainstorm.md` sections:

- `## Goal` — one-line goal
- `## Scope` — in-scope / out-of-scope
- `## Constraints` — technical and business constraints
- `## Candidate Approaches` — 2–4 options (deep mode only)
- `## Open Questions` — deferred questions

## Scope decomposition (before detailed questions)

Before spending interview turns on detail, assess scope. If the request describes multiple independent subsystems ("build a platform with chat, file storage, billing, and analytics"), stop and decompose first. Each sub-project gets its own brainstorm → investigate → tasker → execute cycle.

Refining details of a project that needs to be decomposed first is wasted work.

## Entry output format

```
--- Skill: workflow-brainstorm (mode: <mode>, depth: <deep|light>, agent: <agent>) ---
Goal: <one-line goal>
```

## Red Flags - STOP

These thoughts mean STOP — you're rationalizing:

| Thought | Reality |
|---------|---------|
| "This is too simple to need a design" | Every project goes through this. Simple projects cause the most wasted work from unexamined assumptions. Write the short design. |
| "User said 'fix X' so brainstorming is skipped" | `/fix` routes through `workflow-investigate` first, not `workflow-coding`. `/simple-fix` skips brainstorm but has its own gate. If you are here, you must run. |
| "I can design while I code" | Designing while coding means design is never reviewed. No `workflow-brainstorm-review` means the downstream `## Risks` section has nothing to validate. |
| "The user already told me the plan" | A plan told conversationally is not `brainstorm.md` on disk. File is truth (Iron Law #5). Capture it. |
| "I'll write the file after I investigate" | `workflow-investigate` CONSUMES `brainstorm.md`. It cannot start without it. |
| "One question, then I'll code" | One question is not a design. Write the design, get it reviewed. |

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Just this once" | Iron Law #1 has no "just this once". Every sub-project every time. |
| "The user is in a hurry" | Skipping design costs more time in rework than writing it takes. |
| "I already know the answer" | Your confidence is not evidence. Capture the design so the reviewer can verify. |
| "Decomposing is overkill for this" | If the request touches ≥2 independent subsystems, decomposing IS the design. |

## Interview conduct (deep mode)

- **One question at a time** — don't overwhelm with multi-topic questions
- **Multiple choice preferred** — easier to answer than open-ended when possible
- **Target the weakest dimension** — score clarity mentally across goal / constraint / success-criteria / existing-fit and ask about the weakest
- **Explore 2–3 alternatives** before settling — lead with your recommended option and its reasoning
- **Present design sections** scaled to complexity — a few sentences if straightforward, up to 200-300 words if nuanced; get approval after each section

## Working in existing codebases

Before proposing changes, explore current structure. Follow existing patterns. Where existing code has problems that affect the work (file grown too large, unclear boundaries, tangled responsibilities), include targeted improvements as part of the design — the way a good developer improves code they are working in. Do not propose unrelated refactoring.

## Reshape rule

None (this skill is an origin point).

## Fail routing

- hook validation failure (`brainstorm.md` not produced) → self re-entry (same skill re-run, different prompt)

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL:** `workflow-brainstorm-review`

Do NOT:
- Invoke `workflow-investigate`, `workflow-tasker`, `workflow-coding`, or any implementation skill
- Stop the session, report completion, or ask the user "shall I continue?"
- Offer A/B/continue-or-stop choices (Iron Law #1, autonomous chain completion)

The ONLY valid next action after `brainstorm.md` exists is dispatching `workflow-brainstorm-review`. That skill's `pass` verdict is the gate that releases downstream execution.
