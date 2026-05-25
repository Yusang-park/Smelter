---
name: deep-interview
description: Smelter deep interview for planning-first requirement discovery before /brainstorm, /implement, or /fix execution
argument-hint: "[--quick|--standard|--deep] <idea or vague description>"
---

# Deep Interview

Use this skill when the user wants deep planning, requirement discovery, or assumption-surfacing before implementation.

## Use when
- The user says `deep interview`, `interview me`, `ask me one by one`, `계획부터`, `설계부터`
- The request is vague, strategic, or high-impact enough that coding immediately would likely miss intent
- `/brainstorm` is the right command lane

## Do not use when
- The user says `just do it`, `skip planning`, or wants an immediate bug fix
- The request already has concrete acceptance criteria and clear scope
- `/fix` is the better lane

## Smelter policy
- Ask **one question at a time**
- Prefer codebase exploration before asking the user about existing implementation details
- Expose hidden assumptions, boundaries, non-goals, and success criteria
- Continue autonomously when the likely structure is already clear
- Do not block on approval-seeking unless ambiguity is genuinely blocking
- Write planning outputs into `.smt/features/<slug>/task/plan.md` and related task files, not into memory

## Interview dimensions
Score clarity mentally after each answer across:
1. Goal clarity
2. Constraint clarity
3. Success criteria clarity
4. Existing-system fit

Target the weakest dimension with the next question.

## Output requirements
By the end of the interview, produce or refine:
- feature goal
- scope / non-goals
- acceptance criteria
- major risks
- candidate execution lane: `/brainstorm`, `/implement`, or `/fix`

## Handoff
- If deep planning is complete, route back into Smelter planning state and continue toward execution.
- If the user wants planning only, stop after `.smt` planning artifacts are updated.
- If the user wants execution, route to `/brainstorm`, `/implement`, or `/fix` based on the clarified scope.
