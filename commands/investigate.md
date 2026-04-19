# Smelter: /investigate — Investigation-Only Mode

Run the `investigate` mode on $ARGUMENTS. Use to explore the codebase, understand current behavior, or diagnose an issue without committing to a fix or plan.

Backed by `modes/investigate.json`. Allowed workflow skills: `workflow-investigate`, `workflow-investigate-review`.

## Task
$ARGUMENTS

## Protocol

1. `scripts/state-schema.mjs` seeds `.smt/features/<slug>/task/<task>.state.json` with `mode: investigate`.
2. Entry skill is `workflow-investigate`. Default pattern **C (Parallel)** — investigations split by area (DB / API / UI / security / other) and run in parallel.
3. `workflow-investigate-review` runs **Multi-Pass Verification** (3 rounds: omission / contradiction / edge_case, per spec §9-3).
4. Terminal state: user chooses next mode — `/fix`, `/plan`, or free chat. **No automatic transition.**

## Exit options

After `workflow-investigate-review` passes, present the user with:

```
[1] /fix         — proceed with a fix based on the investigation
[2] /plan        — plan a larger change or refactor
[3] /implement   — implement a feature discovered as needed
[4] continue     — keep exploring (stay in investigate)
[5] done         — archive findings, end session
```

## Iron Law

- Iron Law #6: Mode transitions require user decision. DO NOT auto-advance to `/fix` or `/plan`.
- Iron Law #2 (evasion): DO NOT conclude the investigation with speculation. All claims in `investigation.md` must be file-backed.

## Auto-routing note

Mode classifier patterns that trigger `/investigate`: "look into", "analyze", "how does X work", "investigate", "explore", Korean equivalents. Explicit `/investigate` overrides.
