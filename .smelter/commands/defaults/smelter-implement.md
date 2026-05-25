# Smelter: /implement — Feature Development

Run the `implement` mode on $ARGUMENTS. Use for building features on top of existing code, extensions, or incremental additions. `/brainstorm` is PM/product planning; `/implement` is code-based implementation planning and execution. The experience follows superpowers writing-plans and subagent-driven development: map files first, create bite-sized TDD steps with exact commands, then execute with fresh focused implementation contexts and review checkpoints.

Backed by the Smelter-native `smelter-implement` workflow. Pipeline: `full` for all implement work. `target_type` remains context for planning, not a state-machine branch.

## Task
$ARGUMENTS

## Protocol

1. Smelter creates a workflow run and `$ARTIFACTS_DIR`.
2. Entry node uses `workflow-investigate` — gather current codebase evidence first.
3. `workflow-implementation-plan` turns investigation into a code-level plan. It decides reuse vs new technology, surfaces real trade-offs, records user decisions when choices matter, and reuses an existing feature plan directly when `extend_existing` is sufficient.
4. Flow: investigate → investigate-review → implementation-plan → implementation-plan-review → write-test → coding → agent-review → e2e → e2e-review → team-code-review → human-check.
5. Review skills run **Multi-Pass Verification** with the global 2-round policy.

## No Premature Requirement-Gap Halt

For repo-local names, package names, command names, model ids, wrapper names, and paths mentioned by the user, do **not** halt or ask for clarification before local evidence search. First search the current workspace with `Glob`/`Grep`/`Read` using reasonable variants: exact text, dashed forms, underscored forms, spaced forms, and nearby domain nouns. Only ask the user after documenting that local search found no target or found multiple incompatible targets that cannot be disambiguated from files.

## Magic-keyword branches

- `extend` / `add to` / `덧붙여` → `target_type: extend_existing`; implementation-plan prefers the existing feature's plan/pattern when sufficient.
- `css` / `style` / `i18n` → `workflow-write-test` TDD-exempt flag.

## When to use /implement vs /brainstorm

| Signal | Mode |
|--------|------|
| "Extend existing feature with X" | /implement |
| "Add new feature on top of Y" | /implement |
| "Rework / rewrite / re-architect" | /brainstorm (then /implement) |
| "Greenfield / new product" | /brainstorm (then /implement) |

`target_type` declared by `workflow-investigate` or `workflow-implementation-plan`:
`extend_existing` / `new_feature` / `refactor` / `bug_fix` / `migration`.

## Implementation planning contract

- `implementation-plan.md` must include exact files to create/modify, responsibilities, task queue, TDD test steps, commands to run, and expected outcomes.
- Each queue item should be small enough for an isolated executor to complete and verify without inheriting session history.
- If the plan has independent tasks, `workflow-coding` may use fresh executor contexts per task, followed by Smelter's existing review chain.

## Iron Law

- Iron Law #4 (no retry): failures route through the next Smelter node or explicit rework, not hidden state mutation.
- Iron Law #7: queues are independent per task; specialist agents may be assigned by tasker.
- Scoped testing only (spec §14-3) — no repo-wide `pnpm test` before `workflow-human-check`.

## Auto-routing note

Mode classifier patterns that trigger `/implement`: "build X", "add X", "implement X", "make X", Korean equivalents. Explicit `/implement` overrides.
