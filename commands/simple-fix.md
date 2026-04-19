# Smelter: /simple-fix — Trivial Value Substitution

Run the `simple_fix` mode on $ARGUMENTS. Use for explicit text/CSS/constant changes where the value swap is obvious and no logic flow changes.

Backed by `modes/simple_fix.json`. Allowed workflow skills: `workflow-coding`, `workflow-e2e`, `workflow-human-check`.

## Task
$ARGUMENTS

## Protocol

1. `scripts/state-schema.mjs` seeds `.smt/features/<slug>/task/<task>.state.json` with `mode: simple_fix`.
2. Entry skill is `workflow-coding`. No investigation, no tasker, no TDD.
3. `workflow-e2e` (visual / surface check) follows, then `workflow-human-check`.
4. If `workflow-human-check` detects logic flow change or broader impact, it proposes **mode upgrade to `fix`**.

## Surface-based exemption (auto-applied)

| Surface | E2E | TDD |
|---------|-----|-----|
| CSS / style / typography | visual diff only | exempt |
| i18n / copy-only | snapshot | exempt |
| Constant / literal swap | smoke | exempt |
| Typo in comments/docs | none | exempt |
| Pure dialogue (no code) | none | exempt |

When exempt, record `TDD: exempt (<reason>)` in `features/<slug>/decisions.md`.

## Iron Law

- Iron Law #6: `simple_fix.allowed_skills` does NOT include investigate, tasker, or write-test. If the change turns out to need them, DO NOT silently bypass — request mode upgrade.
- Iron Law #2 (evasion): DO NOT classify a logic change as "trivial" to stay in simple_fix. Escalate.
- Iron Law #4 (no retry): failures route via producer chain (`route-on-fail.mjs`), not blind re-runs.

## Auto-routing note

Commands are hints. The mode classifier (`scripts/mode-classifier.mjs`) auto-selects `simple_fix` when the user's natural-language request matches patterns like "text change", "CSS", "rename", "typo", "translation". Explicit `/simple-fix` overrides the classifier.
