# Step 8: E2E Validation

## Goal
Exercise the real interface end-to-end. Capture artifacts for human review.

## Actions
Surface-based routing:
- **UI** → Playwright against real dev server. Video + screenshots → `.smt/features/<slug>/artifacts/`
- **CLI** → subprocess. Assert exit code + stdout/stderr
- **API** → real server. curl/supertest assertions
- **Hook script** → stdin JSON pipe → assert stdout JSON
- **Library** → real dependencies (no mocking the system under test)

## Skip condition
If change surface is CSS/i18n/typo/dialogue AND no user-visible behavior change, skip E2E.

## Agents
- `qa-tester` (sonnet) — for critical user flows

## Gate
- All E2E artifacts saved
- Exit/status assertions pass
- No visible regressions in video (UI) or logs (CLI/API)

## On fail
→ step-5 (implementation bug)

## Next
→ step-9 (Team Code Review) in feat mode
→ step-10 (Human Review) in qa mode
