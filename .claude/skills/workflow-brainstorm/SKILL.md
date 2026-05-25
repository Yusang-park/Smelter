---
name: workflow-brainstorm
description: Drive Smelter planning-only brainstorming with context discovery, approach comparison, decisions, and design artifacts.
version: 0.55
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

Explores ideas, concepts, and scope before any implementation skill runs. This skill intentionally follows the superpowers brainstorming experience: understand the project context, ask one question at a time, compare approaches, present the design for approval, then persist the approved design.

Two variants via the `depth` parameter:

- **deep** (default for brainstorm mode): brainstorming + deep interview (multi-persona, Pattern D)
- **light**: short interview (single planner, Pattern A) for narrow re-entry or scoped clarification

**Core principle:** No implementation action until scope, constraints, and goal are captured on disk and a downstream skill consumes them.

**Violating the letter of this rule is violating the spirit of this rule.**

**Announce at start:** "I'm using workflow-brainstorm to capture goal, scope, constraints, and candidate approaches into `brainstorm.md`."

## The Iron Law

```
NO IMPLEMENTATION SKILL BEFORE brainstorm.md EXISTS AND PASSES REVIEW
```

You may not invoke `workflow-tasker`, `workflow-coding`, or any implementation skill until `brainstorm.md` is written under `$ARTIFACTS_DIR` and `workflow-brainstorm-review` has declared `pass`.

This applies to every project regardless of perceived simplicity. "A todo list, a single-function utility, a config change" — all of them go through this gate. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST write it and submit it to review.

## Required output

`brainstorm.md` sections:

- `## Goal` — one-line goal
- `## Scope` — in-scope / out-of-scope
- `## Constraints` — technical and business constraints
- `## Candidate Approaches` — 2–4 options (deep mode only)
- `## Recommended Approach` — chosen direction and why
- `## Design` — behavior, architecture, components, data flow, error handling, and testing strategy scaled to complexity
- `## User Decisions` — decisions explicitly approved or selected by the user
- `## Risks` — important ambiguity, migration, UX, dependency, or validation risks
- `## Open Questions` — deferred questions

## Required checklist

Create and complete work items in this order:

1. **Explore project context** — check relevant files, docs, and recent project direction before asking the user about implementation details.
2. **Offer visual companion when useful** — if upcoming questions are visual (UI mockups, diagrams, layout comparisons), offer an available visual/canvas/browser companion in its own message. If no visual companion is available, continue text-only and record that choice.
3. **Ask clarifying questions** — one at a time, targeting purpose, constraints, success criteria, and existing-system fit.
4. **Propose 2–3 approaches** — include trade-offs, lead with the recommended option, and explain why.
5. **Present design sections** — scale detail to complexity and get user approval or correction after each section.
6. **Write `brainstorm.md`** — persist the approved design under `$ARTIFACTS_DIR`.
7. **Spec self-review** — scan for placeholders, contradictions, ambiguity, and scope creep; fix issues inline before handoff.
8. **User reviews written design** — ask the user to review the persisted design when the scope is non-trivial or when decisions were made through dialogue.
9. **Transition to review** — invoke `workflow-brainstorm-review`; do not invoke any implementation skill.

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
| "User said 'fix X' so brainstorming is skipped" | `/fix` routes through `workflow-investigate` first, not `workflow-coding`. Surface exemptions are handled inside the fix lane. If you are here, you must run. |
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
- **YAGNI ruthlessly** — remove unnecessary features from the design before it becomes a task plan
- **Be flexible** — go back and clarify when an answer changes the scope or invalidates a prior assumption

## Approach presentation

Before choosing a design, present 2–3 viable approaches with trade-offs. The recommended approach comes first, followed by alternatives. Include enough reasoning for the user to decide, but do not bury them in implementation detail before they approve the product direction.

## Design presentation

Once the direction is clear, present the design in sections. Cover these areas when relevant:

- Architecture and boundaries
- Components or files at a conceptual level
- Data flow and state ownership
- Error handling and recovery behavior
- Testing strategy and acceptance criteria

Ask after each section whether it looks right so far. If the user corrects direction, revise the section before moving on.

## Spec self-review

After writing `brainstorm.md`, review it with fresh eyes before invoking `workflow-brainstorm-review`:

1. **Placeholder scan** — remove `TBD`, `TODO`, incomplete sections, and vague requirements.
2. **Internal consistency** — make sure scope, approach, design, and risks do not contradict each other.
3. **Scope check** — confirm this is focused enough for one downstream implementation plan; decompose if not.
4. **Ambiguity check** — if a requirement could be interpreted two ways, choose one explicitly or record it as an open question.

Fix issues inline. This author self-review does not replace `workflow-brainstorm-review`.

## Visual companion

A visual companion is optional and per-question, not a separate mode. Use it only when seeing the option is better than reading about it:

- UI mockups, wireframes, layout comparisons, visual hierarchy, or polish decisions
- Architecture diagrams, flowcharts, state machines, or entity relationships
- Side-by-side visual designs where spatial relationships matter

Use terminal text for requirements, scope, trade-offs, and technical decisions. A UI topic is not automatically a visual question; use visuals only when they improve understanding.

When a visual companion is useful, offer it once for consent in its own message. Do not combine that offer with a clarifying question. If the user declines or the environment has no companion available, continue text-only.

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
