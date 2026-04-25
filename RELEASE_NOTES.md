# Release Notes

> Canonical release log. Korean translation: [`RELEASE_NOTES.ko.md`](RELEASE_NOTES.ko.md).
> Smelter release tags now use the `0.*` line.

## v0.4.0 — Explore Mode And Deterministic Contract Runtime
**Released**: 2026-04-26

### Changes

- Current package, plugin, marketplace, Codex companion manifests, workflow schema, skill frontmatter, and workflow-support agent frontmatter version is `0.4.0`.
- User-facing read-only mode is now `explore`; command entry is `/explore`.
- The retired read-only command spelling is not accepted as an alias or fallback.
- `workflow-investigate` remains the executor skill name for discovery artifacts and review contracts.
- Runtime contract is `UserMode → TaskType → Step → Guard`: `explore → read`, `brainstorm → design`, `verify → verify`, `implement/fix → write`, `dobby → freeform`.
- Removed command docs for retired entries and refreshed README, command docs, workflow docs, and agent instructions around the six canonical commands.
- Release and metadata tags are normalized to the `0.*` series; older user-facing `2.*`, `3.*`, and `4.*` metadata labels are no longer current-facing.

### Canonical Commands

| Command | Mode | Task type | Entry skill |
|---------|------|-----------|-------------|
| `/brainstorm` | `brainstorm` | `design` | `workflow-brainstorm` |
| `/implement` | `implement` | `write` | `workflow-investigate` → `workflow-implementation-plan` |
| `/fix` | `fix` | `write` | `workflow-investigate` |
| `/explore` | `explore` | `read` | `workflow-investigate` |
| `/verify` | `verify` | `verify` | `workflow-verify` |
| `/dobby` | `dobby` | `freeform` | `workflow-human-check` |

### Verification

- Focused migration suites passed: contract, classifier, workflow loader, state seeder, keyword detector, workflow scenarios, state-contract injector, and pre-tool enforcer.
- Full verification should include `npm test`, `npm run typecheck`, `npm run test:engine`, and `node scripts/session-end.mjs`.

## Prior 0.* Milestones

Historical development entries before `v0.4.0` are retained as implementation history in `document/implementation.md` and `document/implementation-v2.md`. They describe pre-`v0.4.0` command names and state shapes and are not current user-facing release tags.
