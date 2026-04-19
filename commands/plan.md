# Smelter: /plan — Deep Planning Command

Run the `plan` mode on $ARGUMENTS. Use for new features, large refactors, and architectural work where planning must precede code.

Backed by `modes/plan.json`. Allowed workflow skills: `workflow-brainstorm`, `workflow-brainstorm-review`, `workflow-investigate`, `workflow-investigate-review`, `workflow-tasker`, `workflow-tasker-review`.

**Core rule: agents do not memorize — agents read files.**

## Task
$ARGUMENTS

## Protocol

1. `scripts/state-schema.mjs` seeds `.smt/features/<slug>/task/<task>.state.json` with `mode: plan`.
2. Entry skill is `workflow-brainstorm` with `depth: deep` — full requirement discovery interview.
3. Flow: brainstorm → brainstorm-review → investigate → investigate-review → tasker → tasker-review → **mode transition to `/implement`**.
4. `workflow-brainstorm-review` and `workflow-investigate-review` support the **reshape edge** — either can route back to `workflow-brainstorm` if discovery reshapes the scope.
5. All three review skills (brainstorm-review, investigate-review, tasker-review) run **Multi-Pass Verification** (3 rounds: omission / contradiction / edge_case, per spec §9-3).

## Deep interview behavior

- One question at a time; assumption-seeking.
- Spawn `explore` agent for codebase facts; reserve questions for user preferences and unresolved product intent (adaptive context gathering).
- Never ask multiple questions in one message.

## Output structure

```
{PROJECT_ROOT}/.smt/features/<slug>/
├── task/
│   ├── plan.md                   ← Queue, Approaches, target_type
│   ├── <task-name>.md            ← individual task (atomic, agent-readable)
│   └── <task-name>.state.json    ← machine state (v2.4.1 schema)
├── decisions.md
└── artifacts/
```

## Brainstorm depth

`workflow-brainstorm` runs with `depth: deep` in `/plan`:
- 5+ clarifying questions minimum
- Stakeholder perspectives enumerated (Pattern D: moderator + product/engineering/design personas)
- Acceptance criteria made explicit
- Out-of-scope items listed

## Scope — what /plan does NOT do

- No TDD, implementation, agent-review, e2e, team-code-review, human-check. Those belong to `/implement` or `/fix`.
- No code edits outside `.smt/`.

## Exit

After `workflow-tasker-review` passes, present:

```
[1] /implement  — proceed to lightweight implementation (default)
[2] /fix        — plan was for a bug repair (unusual)
[3] hold        — archive the plan, implement later
```

## Quality criteria

- 80%+ claims cite file/line references
- 90%+ acceptance criteria are testable
- No vague terms without metrics
- No `{{...}}` placeholders

## Iron Law

- Iron Law #6 (workflow whitelist): `plan` mode cannot invoke coding/e2e/review skills. Attempts route to user for mode upgrade.
- Iron Law #3 (no self-failure): brainstorm cannot declare "I don't have enough info to plan" — must ask user.
- Brainstorm and Investigate are bidirectional (reshape); both are discovery steps and may iterate until tasker has a stable basis.

## Auto-routing note

Mode classifier patterns that trigger `/plan`: "design X", "plan Y", "refactor Z", "new feature", "architecture for", Korean equivalents. Explicit `/plan` overrides.
