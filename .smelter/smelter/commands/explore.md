# Smelter: /explore — Read-Only Exploration Mode

Run the `explore` mode on $ARGUMENTS. Use it to explore the codebase, understand current behavior, or diagnose an issue without committing to a fix or plan.

The user mode is `explore`; the executor skill remains `workflow-investigate`. Allowed workflow skills: `workflow-investigate`, `workflow-investigate-review`.

## Task
$ARGUMENTS

## Protocol

1. `scripts/state-schema.mjs` seeds `.smt/features/<slug>/task/<task>.state.json` with `mode: explore` and `task_type: read`.
2. Entry skill is `workflow-investigate`. Default pattern **C (Parallel)** — exploration can split by area (DB / API / UI / security / other).
3. `workflow-investigate-review` runs Multi-Pass Verification for omissions and contradictions.
4. Terminal state: user chooses next mode — `/fix`, `/brainstorm`, `/implement`, or free chat. No automatic write-mode transition.

## Exit Options

After `workflow-investigate-review` passes, ask the user which exit to take.

MANDATORY: use native `AskUserQuestion` for this choice. If the deferred schema is not loaded, first load `ToolSearch("select:AskUserQuestion")`, then invoke `AskUserQuestion`. Plain-text menus, Markdown tables, and prose option lists are invalid; do not render them as the decision UI.

- `/fix` — proceed with a fix based on the findings
- `/brainstorm` — plan a larger change or refactor
- `/implement` — implement a feature discovered as needed
- `continue` — keep exploring in `explore` mode
- `done` — archive findings and end the session

## Iron Law

- Mode transitions require user decision. Do not auto-advance to `/fix`, `/brainstorm`, or `/implement`.
- Do not conclude exploration with speculation. Claims in `investigation.md` must be file-backed.

## Auto-Routing Note

Natural-language prompts such as "look into", "analyze", "how does X work", "investigate", "explore", and Korean equivalents route to `/explore`. The retired investigate command is not an alias.
