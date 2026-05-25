# Testing Requirements

Coverage: **80% minimum**. Required: unit + integration + E2E.

## E2E Principle

**Test the real interface. Never mock the system under test.**

| Component | Real Interface | How |
|-----------|---------------|-----|
| CLI/hook script | stdin→stdout, exit code | `echo payload \| node script.mjs`, assert JSON output |
| HTTP API | HTTP endpoints | Spin up real server, curl/test client |
| Library/module | Public API | Call exports with real deps, no mocks |
| UI/frontend | Browser | Playwright vs real dev server |
| Database layer | Real DB queries | Real or in-process test DB — no query mocks |
| Config/settings | CLI or env behavior | Change real env/file, run real process |

**Mock OK:** external third-party services (payment, email, OAuth).
**Mock NOT OK:** the component you just changed, or any internal layer below it.

## TDD Workflow (Mandatory)

1. Write test (RED — must fail) → run to confirm failure
2. Write minimal impl (GREEN — must pass) → run to confirm pass
3. Refactor → verify coverage 80%+

## Test Level Decision

1. User-visible interface changed? → **E2E required**
2. Module boundary (exported API) changed? → **Integration required**
3. Internal helper only? → Unit sufficient

## Agents

- **tdd-guide** — proactive; enforces write-tests-first
- **qa-tester** — E2E via real interface
