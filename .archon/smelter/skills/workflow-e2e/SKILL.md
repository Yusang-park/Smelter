---
name: workflow-e2e
description: Run Smelter real-interface E2E checks and capture concrete evidence for user-visible behavior.
version: 0.55
type: workflow
consumes: src/** built
produces: "artifacts/ (video, screenshots, logs, trace, io-samples)"
default_pattern: A
default_agent: qa-tester
supports_patterns: [A]
can_delegate_to: [e2e-testing-patterns]
gate:
  postcondition:
    - artifacts_exist: true
    - build_clean: true
    - scoped_tests_pass: true
    - real_interface_invoked: true
    - no_interface_mocks: true
    - per_surface_artifact_present: true
    - effect_observed: true
    - e2e_infra_present: true
surface_mapping:
  UI: "Playwright real browser"
  CLI: "subprocess stdin/argv/exit_code"
  HTTP_API: "real server + curl/fetch"
  Database: "real or in-process test DB"
  Hook: "stdin JSON -> stdout JSON"
exempt_if_surface: [style, typography, typo, dialogue]
---

# workflow-e2e

Drive the real interface and save artifacts proving the target effect happened. Test-runner stdout alone is not E2E.

Announce: `I'm using workflow-e2e to drive the real interface and capture artifacts proving the target effect materialized.`

## Surface Contract

| Surface | Real interface | Required artifact |
|---|---|---|
| UI | Playwright real browser | video + screenshot + console log |
| CLI/script | real subprocess | argv/stdin/stdout/stderr/exit transcript |
| HTTP API | real server on a port | request/response log + follow-up observation |
| Database | real compatible DB engine | SQL log + SELECT/readback evidence |
| Hook | actual stdin/stdout pipe | input JSON + output JSON + exit code |

No mocks for the interface under test. No dry-run. No handler-only calls when the real surface is browser, shell, HTTP, DB, or hook I/O.

## Execution Checklist

1. Identify affected surfaces from state, diff, and plan.
2. Verify the required harness exists. If missing, record `cause: e2e_infra_missing` and route to `workflow-coding` to install/configure it; do not skip E2E.
3. Build/run prerequisite scoped tests.
4. Run the real scenario through the real interface.
5. Save artifacts under `.smt/features/<slug>/artifacts/`.
6. Assert both acknowledgement and effect. Ack-only signals (toast, 2xx, exit 0, banner) are insufficient unless the effect is a local UI toggle.
7. For UI layout/position requirements, assert the target element's bounding box against the viewport, then save the screenshot/video proving it.
8. Record scenario evidence with non-empty references.

## Effect Evidence

- UI: DOM state or screenshot diff proving the target state changed; for placement, include bounding box + viewport assertion.
- API: follow-up GET/list query or DB SELECT confirming state.
- CLI: follow-up command or filesystem diff showing the result.
- DB: SELECT reads back the inserted/updated value.
- Hook: stdout JSON parses and matches expected shape.
- Local UI toggle: absence/presence is the effect; declare it explicitly.

## Credentials

If auth/API secrets are required, ask the user to populate `.env.e2e` with only needed `E2E_*` keys. Never read `.env`, echo secrets, fabricate credentials, or stub auth to pass.

## Forbidden

- Claiming pass with zero artifacts.
- Treating unit/integration runner output as E2E.
- Using mocks/stubs for the exercised interface.
- Skipping because infra is absent.
- Using ack-only evidence for durable effects.

## Terminal State

On pass, invoke `workflow-e2e-review`. On gate fail, route to the producer (`workflow-coding`) with cause and artifact evidence.
