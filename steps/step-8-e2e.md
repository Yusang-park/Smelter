# Step 8: E2E Validation

## Goal
Exercise the real interface end-to-end in the actual runtime surface. Capture artifacts for human review.

## Rule
E2E does **not** mean writing or running only automated test code. It means real validation using the actual surface in a separate execution context and preserving evidence.

Passing examples:
- launching a separate terminal/session and exercising the command, hook, UI, or API directly
- taking screenshots, saving logs, or preserving command output artifacts
- running Playwright against a live app and saving screenshots/video/traces
- making direct API calls against a real server and saving responses

Non-examples:
- only adding unit/integration tests
- only running an existing test file without direct runtime validation
- claiming E2E based solely on code inspection

## Actions
Surface-based routing:
- **UI** → Playwright + real dev server. Save screenshots/video/trace to `.smt/features/<slug>/artifacts/`
- **CLI** → launch a separate terminal/session, run the real command, and save stdout/stderr transcript or screenshot
- **API** → run the real server, make direct HTTP calls (`curl`, client, or equivalent), and save request/response artifacts
- **Hook script** → invoke the hook through a real subprocess/terminal flow with representative stdin and save the actual stdout/stderr output as evidence
- **Library** → validate through the real consuming surface; library-only test code is not sufficient for E2E

## Artifact requirement
Store human-reviewable evidence under `.smt/features/<slug>/artifacts/` whenever the surface allows it. Examples: screenshots, Playwright traces, captured terminal logs, API responses.

## Skip condition
CSS/i18n/typo/dialogue with no user-visible behavior change → skip E2E.

## Agents
- `qa-tester` (sonnet) for critical user flows

## Gate signal (REQUIRED — you must write this)
Set `signals.e2e_pass = true` (atomic Read→Write — see `steps/step-4-tdd.md`).

`true` only when real surface validation has been performed, artifacts/evidence saved, and no visible regressions were found. `false` → route to step-5.

**If skipped (exempt surface):** set `e2e_pass: true` with a note in `decisions.md`.

## Next
- `/feat` → step-9 (Team Code Review)
- `/qa` → step-10 (Human Review)
