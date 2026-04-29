# Release Notes

> Canonical release log. Korean translation: [`RELEASE_NOTES.ko.md`](RELEASE_NOTES.ko.md).
> Smelter release tags use the `0.*` line. `codex-for-claude-code` is versioned independently.

## v0.55.0 — Workflow Runtime Hardening
**Released**: 2026-04-29

### Highlights

- `workflow-write-test` now frames RED tests as executable specifications using Specification by Example / BDD / ATDD principles.
- Coding-entry gates now require executable specification RED evidence instead of generic TDD wording.
- `workflow-e2e` and `workflow-e2e-review` now require opened visual artifacts plus viewport or bounding-box evidence for UI placement checks.
- Semble MCP replaces Serena in repo configuration, permissions, ignore rules, and stage-gate assumptions.
- Prompt routing now recognizes high-confidence feature modification requests as `/implement` and focused visual `/fix` hints such as `border`, `outline`, `ring`, and `테두리` as design work.
- Phase-block auto-confirm recovery, stale read-first reminders, removed skill-injector assertions, and retired Serena MCP stage-gate behavior are covered by regression tests.

### Compatibility Notes

- Current package/plugin/workflow schema version: `0.55.0` / `0.55`.
- The task artifact shape remains the compact checklist introduced in `v0.51`; its `schema_version` is now `0.55`.
- `fix_simple` still skips tasker stages for text/design work; the default `fix` path keeps compact tasker and tasker-review records.

### Verification

- Focused workflow/runtime regression tests cover schema loading, compact task artifacts, prompt routing, visual E2E review, phase gates, and hook cleanup.

## v0.51.0 — Workflow Source Of Truth And Compact Fix Flow
**Released**: 2026-04-28

### Highlights

- `modes/workflow.yaml` is now the workflow topology source of truth for skills, pipelines, modes, target-type routing, transition adoption, verification rounds, and command aliases.
- Hooks execute workflow config instead of carrying mode-specific workflow branches. Command-to-mode resolution and read/write mode classification now derive from `workflow.yaml`.
- `/explore → /fix|/implement` reuses completed discovery through `transition_adoptions` only when artifact evidence validates. Agent prose is never enough to skip investigation.
- `/fix` now records compact `tasks.md` and `tasks-review.md` scope records before test/coding stages, keeping scope, omissions, verification, and team-runtime evidence without verbose planning overhead.
- `workflow-human-check` now exposes explicit terminal actions: `complete-commit-current` and `complete-new-branch-pr`, with no second Git-options prompt.
- RED-test recovery, TDD exemption handling, and stale session-pointer handling were tightened across the write-test, coding, E2E, and human-check gates.

### Compatibility Notes

- At v0.51 release time, package/plugin/workflow schema version was `0.51.0` / `0.51`.
- `fix` pipeline now includes tasker and tasker-review before write-test.
- `fix_simple` still only applies to `text` and `design` surfaces and now runs directly as investigate → coding → E2E → human-check.
- `transition_adoptions` is declarative. Add future cross-mode reuse in `modes/workflow.yaml`, not inside individual hooks.

### Verification

- `node --test scripts/*.test.mjs scripts/lib/*.test.mjs` passed: 464 tests, 0 failed.
- QA agent review passed after documentation corrections.

## v0.4.1 — Infra Workflow And Hook Recovery Rollup
**Released**: 2026-04-27

- Added `/infra` for cloud/resource/IaC operations with inventory-first planning, destructive-risk review, execution evidence, verification handoff, and human-check gating.
- Added `workflow-infra-plan`, `workflow-infra-plan-review`, and `workflow-infra-execute` to the workflow registry and artifact routing.
- Tightened agent-driven recovery: slash-prefixed command skills normalize correctly, hook scripts share effective session-id fallback, and stale active state is less likely to block scoped writes.
- Kept prompt/context overhead bounded with compact state-write contracts, terminal reminders, and prompt-budget regression coverage.

## v0.4.0 — Explore Mode And Deterministic Contract Runtime
**Released**: 2026-04-26

- User-facing read-only mode is `explore`; command entry is `/explore`.
- Runtime contract is `UserMode → TaskType → Step → Guard`.
- Retired command spellings are not accepted as aliases or fallback entries.

## Prior 0.* Milestones

Historical development entries before `v0.4.0` are retained as implementation history in `document/implementation.md` and `document/implementation-v2.md`.
