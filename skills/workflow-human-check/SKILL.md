---
name: workflow-human-check
version: 0.4.1
type: workflow
consumes: all artifacts + team_review.md
produces: user decision (rework | complete | hold | upgrade)
default_pattern: User
supports_patterns: [User]
halts_session: true
gate:
  postcondition:
    - user_decision: "rework | complete | hold | upgrade"
---

# workflow-human-check

Final user review. This is the only allowed halting point. No task is complete until the user chooses `complete` here.

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

## User Decision

Ask one native `AskUserQuestion` with exactly these options and no free-form catch-all:

1. `rework` - create `active_feedback`, route to target skill.
2. `complete` - finalize and auto-commit locally.
3. `hold` - record blocked/paused status.
4. `upgrade` - move to a stronger mode and re-enter the proper skill.

Do not paraphrase option labels. Do not ask a free-form “continue?” question. Do not ask a second git-options question. Do not render the options as Markdown/plain text; the decision must be collected through native `AskUserQuestion`.

## Complete Path

On `complete`, write non-empty `results.md`. `finalize-human-check.mjs` observes that write for `fix`, `implement`, `infra`, and `dobby`, then records the `workflow-human-check` pass event and `completed_stages` entry. Do not edit `.state.json` yourself.

After finalize evidence exists, auto-commit locally:

1. Run `git status --short`.
2. Add only relevant files for this task.
3. Run `git commit` with the repository's `<type>: <description>` style.
4. Run `git status --short` to verify.

Never commit before the finalize pass shape exists. Never push, PR, merge, delete branches, or discard unless the user explicitly asks for it.

## Terminal Routing

| Decision | Next action |
|---|---|
| `complete` | write `results.md`, let finalize hook pass, then `git commit` locally |
| `rework` | add unresolved feedback and route to target skill |
| `hold` | stop with blocked/paused status |
| `upgrade` | transition mode and continue |
