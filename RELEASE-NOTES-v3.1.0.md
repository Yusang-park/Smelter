# Smelter v3.1.0 — `/fix` speed/quality balance + v3 mode simplification

Released 2026-04-22.

## Highlights

Smelter v3 + v3.1 collapse the legacy 6-mode system into a lean 5-mode set, consolidate configuration into a single file, and add runtime pipeline selection so `/fix` no longer drags trivial bug repairs through the full 11-skill chain.

- **5 modes** (was 6): `think` · `fix` · `implement` · `investigate` · `verify`. `/plan` renamed to `/think`; `/simple-fix` folded into `/fix` via magic keyword.
- **Single-file config**: `modes/workflow.yaml` replaces the former three-file split.
- **Target-type pipeline dispatch**: `/fix` picks `minimal` / `light` / `medium` at runtime based on `target_type` + scope signals.
- **2-round mid-pipeline reviews**: cuts ~4 agent dispatches per `/fix` run.
- **Commit gate**: `git commit` blocked until `workflow-human-check` passes. Shell-unwrap matcher catches `bash -c`, env prefix, absolute path.
- **Visual artifact rendering**: `workflow-human-check` opens every screenshot / video via the `Read` tool inline before the user decision.

---

## Breaking changes (v2 → v3)

| v2 | v3 | Migration |
|---|---|---|
| `/plan` command | `/think` | Rename references. No auto-alias. |
| `/simple-fix` command | `/fix` + magic keyword (`typo` / `dialogue` / `css`) | Remove `/simple-fix` calls; rely on keyword detection. |
| `modes/{fix,implement,investigate,verify,plan,simple_fix}.json` | `modes/workflow.yaml` | 6 files → 1. Loader auto-reads. |
| `modes/{skills,pipelines,modes}.yaml` (v3 interim split) | `modes/workflow.yaml` (v3.1 unified) | If you had the split, delete and use the unified file. |
| `state-schema.mjs::MODES` included `plan` + `simple_fix` | MODES now `[think, fix, implement, investigate, verify]` | Existing state files with `mode: plan` or `mode: simple_fix` fail validation. Run `/cancel hard` and re-enter. |
| Every review skill `min_verification_rounds: 3` | Mid reviews `2`, terminal reviews `3` | No code migration needed. |

---

## New in v3.1

### Target-type pipeline dispatch

`/fix` now picks its pipeline at runtime:

| target_type | Pipeline | Skills | Use case |
|---|---|---|---|
| `typo` / `dialogue` | `minimal` | 4 | investigate → coding → e2e → human-check. TDD + E2E exempt for copy changes. |
| `bug_fix` (≤3 files, 1 surface) | `light` | 8 | Skip tasker + team-code-review. |
| `bug_fix` (complex) / `extend_existing` | `medium` | 11 | Full chain minus brainstorm. |
| `new_feature` / `refactor` / `migration` | `upgrade_required` | — | User prompted to switch to `/implement` or `/think`. |

Selection happens twice:

1. **Prompt-time** via `applyMagicKeywords(prompt, modeCfg, state)` — scans for `typo`/`dialogue`/`css`/etc, applies `set.target_type` + `set.exempt.*`.
2. **Post-investigate** via `skill-stage-transition.mjs` — reads `investigation.md` / `tasks.md` frontmatter (`target_type`, `file_count`, `surface`) and re-runs `selectPipeline()`. Narrows `allowed_skills` while preserving `completed_stages`.

### Commit gate

`pre-tool-enforcer.mjs` adds a `PreToolUse:Bash` rule that blocks `git commit` when:
- State mode is `fix` or `implement`, AND
- No `workflow-human-check` pass event exists in `state.events[]`

The `looksLikeGitCommit(command)` matcher handles shell-wrapped invocations:
- `bash -c 'git commit'` / `sh -c "... git commit ..."`
- `/usr/bin/git commit` / `./git commit`
- `FOO=1 git commit` (env prefix)
- `git -C /dir commit`
- chained operators (`;`, `&&`, `||`, `|`, `$(…)`, backtick)
- quote-wrapped forms (single/double)

**Fail-CLOSED**: if the active pointer exists but `state.json` is unreadable, the gate blocks rather than falls through. Prevents bypass via state corruption.

Rollback: operator creates `.smt/state/skill-gate.off` sentinel (documented in workflow.md). Agents cannot create this sentinel — pre-tool-enforcer blocks Write/Edit/MultiEdit under that path.

### Visual artifact rendering

`workflow-human-check/SKILL.md` now mandates opening every `.png`/`.jpg`/`.webm`/`.pdf` artifact via the `Read` tool before `AskUserQuestion`. Users see the output inline in the terminal; `complete` vs `rework` decisions are grounded in actual visual evidence, not file paths.

### Korean magic-keyword aliases

`오타` (typo) and `대화` (dialogue) added to `workflow.yaml::modes.fix.magic_keywords`. Works alongside existing ASCII keys. Non-ASCII matching uses substring (CJK has no `\b` boundary).

### Verification round split

New `verification_rounds` block in `workflow.yaml`:

```yaml
verification_rounds:
  mid_pipeline: 2   # brainstorm-review, investigate-review, tasker-review, agent-review
  terminal: 3       # e2e-review, team-code-review, human-check
```

Mid-pipeline reviews drop the edge-case round (kept omission + contradiction) for speed. Terminal gates keep full 3-round enforcement.

---

## New in v3 (prior)

- **Unified workflow config** — single `modes/workflow.yaml` (v3.0 split into 3 files, consolidated in v3.1).
- **E2E Infra Preflight** section in `workflow-e2e/SKILL.md` — when Playwright / harness is absent, route to `workflow-coding` to install before scenarios run. New `cause: e2e_infra_missing`.
- **E2E Visual Inspection** section in `workflow-e2e-review/SKILL.md` — every screenshot opened, ≥3 video frames sampled, visual discrepancies emit `cause: visual_mismatch` → loops back to `workflow-coding`.
- **TARGET_TYPE_ENUM** extended with `typo`, `dialogue` for magic-keyword dispatch.
- **CAUSE_ENUM** extended with `visual_mismatch`, `e2e_infra_missing`.
- **Mode classifier** (`mode-classifier.mjs`) — `EXPLICIT_COMMANDS` + `MODES_WHITELIST` trimmed to v3 canonical set.
- **Legacy removal** — all references to `/plan` and `/simple-fix` deleted from `keyword-detector.mjs`, `subagent-classifier.mjs` prompt, `session-end.mjs`, command files, docs.
- **`applyMagicKeywords` wire-up** — prompt-time keyword match finally consumed by the loader. Previous versions defined the keywords but never applied them.

---

## Bug fixes (v3.1)

- **CJK keyword matching** — `\b` word-boundary failed on Korean characters (no transition between `\W`s). Now ASCII keywords use `\b`, non-ASCII use substring.
- **`keyword-detector.mjs::main()` guard** — without `import.meta.url === process.argv[1]`, importing the module (for test unit coverage) would execute `main()`, read `/dev/stdin`, and hang under `node --test`.
- **`isTranscriptPaste`** — now counts total pattern occurrences, so two `⏺` bullets alone trigger the heuristic (was distinct-pattern count).
- **`extractExplicitHarnessCommand` regex** — `[\s\S]*` instead of `.*` so `/fix` + multi-line pasted transcript matches the slash command.
- **Documentation backticks** — JSDoc in `pre-tool-enforcer.mjs` caused JS parse error; stripped.
- **`completed_stages` preservation** — pipeline re-selection preserves all completed stages, even those absent from the new pipeline. Audit trail stays intact.
- **`file_count` type guard** — `Number.isFinite(x) && x >= 0` (was `typeof === 'number'`, which accepts NaN and Infinity).

---

## Deferred (known gaps)

- **Reshape-event gate** — original duplicate-skill-invocation bug. Design complete in `.smt/features/smelter-v3-duplicate-skill-fix/task/brainstorm.md`; no code yet. v3.1 target-type dispatch reduced the pain point but does not close the gate.
- **E2E infra auto-install** — SKILL.md prose only. No runtime code that actually executes `npm install -D @playwright/test`.
- **`upgrade_required` escalation UX** — returns sentinel but no user-visible prompt. Falls back to default pipeline silently.

---

## Accepted LOW risks

- `looksLikeGitCommit` matches inside quoted-echo strings (`echo "... git commit ..."`). Advisory block; user can remove quoted string and retry.
- Pre-v3.1 state files without `events[]` get commit-blocked until `/cancel hard`.
- Concurrent PostToolUse writes to `allowed_skills` race (mitigated by session-isolation contract).
- Non-ASCII substring collision potential (no current collision; add guard if magic keywords grow).

---

## Verification

| Suite | Pass |
|---|---|
| `node --test` bundle | 129/129 |
| `auto-confirm` | 117/117 |
| `workflow-scenarios` | 119/119 |
| `mode-classifier` | 39/39 |
| Hook-surface E2E (v3.1) | 7/7 |
| **Total** | **411/411** |

Pattern B Dual Adversarial agent-review: PASS. Pattern B 95% consensus team-code-review: **98%** (advocate 97 + arbitrator 98 > critic 80 blockers downgraded to LOW risks).

---

## Files changed

~60 files, ~2,500 lines added / ~700 removed across:

- `modes/workflow.yaml` (new unified config)
- `modes/*.json` (6 files deleted)
- `commands/{think,fix,implement,investigate,verify}.md` + `commands/queue.md`
- `commands/{plan,simple-fix}.md` (deleted)
- `scripts/{keyword-detector,mode-classifier,state-schema,state-validator,pre-tool-enforcer,skill-stage-transition,auto-confirm,session-end}.mjs`
- `scripts/lib/{workflow-loader,subagent-classifier}.mjs` + `lib/__fixtures__/mode-classifier-stub.mjs`
- `skills/workflow-{e2e,e2e-review,human-check,brainstorm-review,investigate-review,tasker-review,agent-review}/SKILL.md`
- `document/{workflow.md,workflow.ko.md,implementation.md}`
- `README.md`, `README.ko.md`

## Upgrade steps

1. Pull main, run `node scripts/dev-install.mjs` (or wait for marketplace auto-update).
2. For any in-flight v2 state files with `mode: plan` or `mode: simple_fix`: `/cancel hard` to clear, re-enter with `/think` or `/fix`.
3. If you relied on `/plan` or `/simple-fix` aliases: switch to `/think` and `/fix` + magic keyword.

---

Smelter v3.1 is fully backward-incompatible with v2 at the mode name level, but all workflow-* skills retain their contracts. Existing feature directories remain readable; only the mode enum changed.
