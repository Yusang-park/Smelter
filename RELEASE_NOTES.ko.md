# 릴리즈 노트

> 이 문서는 [`RELEASE_NOTES.md`](RELEASE_NOTES.md)의 한국어 번역본입니다.
> Smelter 릴리즈 태그는 `0.*` 라인을 사용합니다. `codex-for-claude-code`는 독립 버전입니다.

## v0.55.0 — Workflow Runtime Hardening
**릴리즈**: 2026-04-29

### 핵심 변경

- `workflow-write-test`는 이제 Specification by Example / BDD / ATDD 원칙에 따라 RED 테스트를 실행 가능한 스펙으로 다룹니다.
- Coding 진입 gate는 일반 TDD 표현 대신 실행 가능한 스펙 RED 증거를 요구합니다.
- `workflow-e2e`와 `workflow-e2e-review`는 UI 위치 검증 시 열린 visual artifact와 viewport 또는 bounding-box 증거를 요구합니다.
- Repo 설정, 권한, ignore rule, stage-gate 가정에서 Serena 대신 Semble MCP를 사용합니다.
- Prompt routing은 명확한 기능 수정 요청을 `/implement`로, `border`, `outline`, `ring`, `테두리` 같은 visual `/fix` 힌트를 design 작업으로 분류합니다.
- Phase-block auto-confirm recovery, stale read-first reminder, 제거된 skill-injector 검증, retired Serena MCP stage-gate 동작을 regression test로 고정했습니다.

### 호환성 메모

- 현재 package/plugin/workflow schema 버전: `0.55.0` / `0.55`.
- Task artifact 형태는 `v0.51`의 compact checklist를 유지하되 `schema_version`은 `0.55`입니다.
- `fix_simple`은 text/design 작업에서 계속 tasker stage를 건너뛰며, 기본 `fix` path는 compact tasker와 tasker-review 기록을 유지합니다.

### 검증

- Schema loading, compact task artifact, prompt routing, visual E2E review, phase gate, hook cleanup을 focused workflow/runtime regression test로 검증했습니다.

## v0.51.0 — Workflow Source Of Truth와 Compact Fix Flow
**릴리즈**: 2026-04-28

### 핵심 변경

- `modes/workflow.yaml`이 skills, pipelines, modes, target-type routing, transition adoption, verification rounds, command aliases의 단일 workflow topology source of truth입니다.
- Hook은 mode-specific workflow 분기를 직접 들고 있지 않고 workflow config를 실행합니다. command→mode 해석과 read/write mode 판정도 `workflow.yaml`에서 파생합니다.
- `/explore → /fix|/implement`는 `transition_adoptions` 정책과 artifact evidence가 검증될 때만 완료된 discovery를 재사용합니다. Agent prose만으로 investigation을 skip할 수 없습니다.
- `/fix`는 test/coding 전에 compact `tasks.md`, `tasks-review.md` 범위 기록을 남깁니다. 긴 planning 문서 없이 scope, omissions, verification, team-runtime evidence를 보존합니다.
- `workflow-human-check`는 `complete-commit-current`, `complete-new-branch-pr` 명시 terminal action을 제공합니다. 두 번째 Git 옵션 질문은 없습니다.
- RED-test recovery, TDD exemption 처리, stale session pointer 처리를 write-test, coding, E2E, human-check gate 전반에서 강화했습니다.

### 호환성 메모

- v0.51 릴리즈 당시 package/plugin/workflow schema 버전은 `0.51.0` / `0.51`이었습니다.
- `fix` pipeline은 write-test 전에 tasker와 tasker-review를 포함합니다.
- `fix_simple`은 계속 `text`, `design` 표면에만 적용되며 이제 investigate → coding → E2E → human-check로 바로 진행합니다.
- `transition_adoptions`는 선언형입니다. 향후 cross-mode reuse는 개별 hook이 아니라 `modes/workflow.yaml`에 추가합니다.

### 검증

- `node --test scripts/*.test.mjs scripts/lib/*.test.mjs` 통과: 464 tests, 0 failed.
- QA agent review는 문서 보정 후 통과했습니다.

## v0.4.1 — Infra Workflow와 Hook Recovery Rollup
**릴리즈**: 2026-04-27

- Cloud/resource/IaC 작업용 `/infra`를 추가했습니다. Inventory-first plan, destructive-risk review, execution evidence, verification handoff, human-check gate를 사용합니다.
- `workflow-infra-plan`, `workflow-infra-plan-review`, `workflow-infra-execute`를 workflow registry와 artifact routing에 추가했습니다.
- Slash-prefixed command skill 정규화, hook 공통 effective session-id fallback, stale active state 완화로 agent-driven recovery를 강화했습니다.
- Compact state-write contract, terminal reminder, prompt-budget regression coverage로 prompt/context overhead를 제한했습니다.

## v0.4.0 — Explore Mode와 Deterministic Contract Runtime
**릴리즈**: 2026-04-26

- 사용자-facing read-only mode는 `explore`, command entry는 `/explore`입니다.
- Runtime contract는 `UserMode → TaskType → Step → Guard`입니다.
- Retired command spelling은 alias/fallback으로 허용하지 않습니다.

## 이전 0.* Milestones

`v0.4.0` 이전 개발 기록은 `document/implementation.md`와 `document/implementation-v2.md`에 구현 이력으로 보관합니다.
