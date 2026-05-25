---
name: workflow-human-check
description: Final Smelter human approval gate for evidence review, completion decisions, commit approval, or rework routing.
version: 0.55
type: workflow
consumes: all artifacts + team_review.md
produces: user decision (rework | complete-commit-current | complete-new-branch-pr | hold | upgrade)
default_pattern: User
supports_patterns: [User]
halts_session: true
gate:
  postcondition:
    - user_decision: "rework | complete-commit-current | complete-new-branch-pr | hold | upgrade"
---

# workflow-human-check

Final user review. This is the only allowed halting point. No task is complete until the user chooses one of the `complete-*` actions here.

Announce: `I'm using workflow-human-check to render the summary report and collect the user's complete / rework / hold / upgrade decision.`

Use native `AskUserQuestion` for the decision. Plain-text menus such as `Decide: complete / rework / hold / upgrade?` are invalid and will be rejected by the Stop hook.

If the runtime has not loaded the deferred tool schema yet, first load it with `ToolSearch("select:AskUserQuestion")`, then invoke `AskUserQuestion`. Do not fall back to prose unless the user explicitly says native tools are unavailable.

## Required Evidence

- Diff scope: `<N files changed, +X/-Y lines>` plus top paths.
- Test/typecheck results with scoped/full label.
- E2E artifacts and review results when required.
- Risks/open items from review artifacts.
- Visual artifacts rendered inline via `Read` before asking: png/jpg/gif/webp, video representative frame/path, pdf.

## Report Format

Write a concise Markdown report and `results.md` under the canonical task directory. Use tables for scannability.

Summary table:

| Field | Value |
|---|---|
| Feature | `<slug>` |
| Task | `<title> - user-facing before/after or concrete failure fixed` |
| Mode | `<mode>` |
| Stages | `<completed workflow skills>` |

Artifacts table:

| Kind | Path / Summary |
|---|---|
| Visual | `<path>` / `(none)` / `MISSING - required` |
| Log | `<path>` / `(none)` / `MISSING - required` |
| Diff | `<N files changed, +X/-Y lines> · top 3 paths · +M more` |

Verification table:

| Check | Result |
|---|---|
| TDD/typecheck | `<pass/fail + command>` · `scope: scoped|full` |
| E2E | `<surface + pass/fail + artifacts>` · `scope: scoped|full` |

Risks: bullets only, severity `[LOW|MEDIUM|HIGH|CRITICAL]`, omit if empty.

## Issue-First Decision Gate

Before asking for completion, read `verify_report.md`, `agent-review.md`, `e2e-review.md`, `team_review.md`, and `results.md` when present. Treat these as unresolved findings: any `fail` verdict, missing required artifact/evidence, unchecked acceptance item, `MEDIUM|HIGH|CRITICAL` risk, or a user-visible blocker such as a deploy gate.

If unresolved findings exist, summarize them first with file/artifact anchors, then ask one problem-focused AskUserQuestion. Do not offer complete-commit-current or complete-new-branch-pr in this question. Use exactly these options and no free-form catch-all:

1. `rework` - create `active_feedback`, route to the producer skill named by the finding.
2. `hold` - record blocked/paused status with the unresolved findings.
3. `upgrade` - move to `/fix`, `/implement`, or `/brainstorm` when the finding needs a stronger mode.

This applies to every mode, including `/verify` after a previous human-check. A fresh verification that finds missed work must ask about the missed work, not present commit choices.

## Completion Decision

Only when there are no unresolved findings, ask one native `AskUserQuestion` with exactly these options and no free-form catch-all:

1. `rework` - create `active_feedback`, route to target skill.
2. `complete-commit-current` - finalize, then `git commit` on the current branch.
3. `complete-new-branch-pr` - finalize, create a new branch, commit, push with upstream, then run `gh pr create`.
4. `hold` - record blocked/paused status.
5. `upgrade` - move to a stronger mode and re-enter the proper skill.

Do not paraphrase option labels. Do not ask a free-form “continue?” question. Do not ask a second git-options question. Do not render the options as Markdown/plain text; the decision must be collected through native `AskUserQuestion`.

## Complete Path

On either `complete-*` action, write non-empty `results.md`. `finalize-human-check.mjs` observes that write for `fix`, `implement`, and `infra`, then records the `workflow-human-check` pass event and `completed_stages` entry. Do not edit `.state.json` yourself.

For `complete-commit-current`, after finalize evidence exists:

1. Run `git status --short`.
2. Add only relevant files for this task.
3. Run `git commit` with the repository's `<type>: <description>` style.
4. Run `git status --short` to verify.

For `complete-new-branch-pr`, after finalize evidence exists:

1. Run `git status --short`.
2. Create/switch to a new task-named branch derived from the feature slug; if it already exists, use a unique suffix.
3. Add only relevant files for this task.
4. Run `git commit` with the repository's `<type>: <description>` style.
5. Push with upstream and run `gh pr create` with a concise title and summary.
6. Return the PR URL.

Never commit before the finalize pass shape exists. Never push, PR, merge, delete branches, or discard unless the user explicitly chooses `complete-new-branch-pr` or separately requests it.

## Terminal Routing

| Decision | Next action |
|---|---|
| `complete-commit-current` | write `results.md`, let finalize hook pass, then `git commit` locally |
| `complete-new-branch-pr` | write `results.md`, let finalize hook pass, create/switch to a new task branch, push, then `gh pr create` |
| `rework` | add unresolved feedback and route to target skill |
| `hold` | stop with blocked/paused status |
| `upgrade` | transition mode and continue |
