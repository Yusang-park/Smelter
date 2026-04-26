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

Use the native clickable question mechanism when available; otherwise present exactly these options and wait:

1. `rework` - create `active_feedback`, route to target skill.
2. `complete` - finalize, then offer git options.
3. `hold` - record blocked/paused status.
4. `upgrade` - move to a stronger mode and re-enter the proper skill.

Do not paraphrase option labels. Do not ask a free-form “continue?” question.

## Complete Path

On `complete`, write non-empty `results.md`. `finalize-human-check.mjs` observes that write for `fix`, `implement`, and `infra`, then records the `workflow-human-check` pass event and `completed_stages` entry. Do not edit `.state.json` yourself.

After finalize evidence exists, offer git options:

1. `commit-local`
2. `push-pr`
3. `keep-as-is`
4. `discard` only after exact typed confirmation `discard`

Never commit before the finalize pass shape exists. Never push, PR, merge, delete branches, or discard unless the user explicitly chooses it.

## Terminal Routing

| Decision | Next action |
|---|---|
| `complete` | write `results.md`, let finalize hook pass, then git option |
| `rework` | add unresolved feedback and route to target skill |
| `hold` | stop with blocked/paused status |
| `upgrade` | transition mode and continue |
