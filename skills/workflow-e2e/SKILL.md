---
name: workflow-e2e
version: 2.3.0
type: workflow
consumes: src/** built
produces: "artifacts/ (video, screenshots, logs)"
default_pattern: A
default_agent: qa-tester
supports_patterns: [A]
can_delegate_to: [e2e-testing-patterns]
gate:
  postcondition:
    - artifacts_exist: true
    - build_clean: true
    - scoped_tests_pass: true
surface_mapping:
  UI: "Playwright (browser)"
  CLI: "subprocess stdin/argv/exit_code"
  HTTP_API: "real server + curl/fetch"
  Database: "real or in-process test DB"
  Hook: "stdin JSON → stdout JSON"
exempt_if_surface: [style, typography, typo, dialogue]
---

# workflow-e2e

Verifies user scenarios at the real interface. Runner selection depends on the surface.

## 5-Surface Mapping

| Surface | Real interface | Runner |
|---------|----------------|--------|
| UI/Frontend | Browser | Playwright |
| CLI/Script | stdin, argv, exit code | subprocess |
| HTTP API | HTTP endpoints | real server + curl/fetch |
| Database | Real DB queries | real / in-process test DB |
| Hook script | stdin JSON → stdout JSON | `cat payload \| node hook.mjs` |

## Artifacts (required)

In `.smt/features/<slug>/artifacts/`:
- Frontend: **video recording + screenshots**
- Backend/API: **log files**
- Hook: **saved input/output samples**

## Constraints

- No modification or deletion of PROD data (explicit user permission required)
- When login is needed, use `E2E_TEST_ID` / `E2E_TEST_PW` from `.env`
- When data is missing, ask the user to insert it

## Scoped execution (principle 8)

```bash
# Only specs related to changed files
npx playwright test <changed_specs>
```

Full regression is run only in `workflow-human-check`.

## Fail routing (producer)

- `assertion`/`build`/`typecheck` → `workflow-coding`
