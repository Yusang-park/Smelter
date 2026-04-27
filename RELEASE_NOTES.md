# Release Notes

> Canonical release log. Korean translation: [`RELEASE_NOTES.ko.md`](RELEASE_NOTES.ko.md).
> Smelter release tags use the `0.*` line. `codex-for-claude-code` is versioned independently.

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

- Current package/plugin/workflow schema version: `0.51.0` / `0.51`.
- `fix` pipeline now includes tasker and tasker-review before write-test.
- `fix_simple` still only applies to `text` and `design` surfaces, but also records compact tasker artifacts before coding.
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
