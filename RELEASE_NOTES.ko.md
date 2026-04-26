# 릴리즈 노트

> 이 문서는 [`RELEASE_NOTES.md`](RELEASE_NOTES.md)의 한국어 번역본입니다.
> Smelter 릴리즈 태그는 이제 `0.*` 라인을 사용합니다.

## v0.4.1 — Infra Workflow와 Hook Recovery Rollup
**릴리즈**: 2026-04-27

### 변경 사항

- 현재 package, plugin, marketplace, workflow schema, workflow skill frontmatter 버전은 `0.4.1`입니다.
- Cloud/resource/IaC 작업용 `/infra`를 추가했습니다. Inventory-first plan, destructive-risk review, execution evidence, verification handoff, human-check gate를 사용합니다.
- `workflow-infra-plan`, `workflow-infra-plan-review`, `workflow-infra-execute`를 workflow registry와 artifact routing에 추가했습니다.
- Agent-driven recovery를 강화했습니다. Slash-prefixed command skill 정규화, hook 공통 effective session-id fallback, stale active state write-block 완화가 포함됩니다.
- Compact state-write contract, terminal reminder, prompt-budget regression coverage로 prompt/context overhead를 제한합니다.

### 검증

- Regression coverage는 infra pipeline/config, hook registration, prompt budget, RED recorder behavior, stage transition, workflow contract, state/permission guard를 포함합니다.

## v0.4.0 — Explore Mode와 결정적 Contract Runtime
**릴리즈**: 2026-04-26

### 변경 사항

- 현재 package, plugin, marketplace, workflow schema, skill frontmatter, workflow-support agent frontmatter 버전은 `0.4.0`입니다.
- 사용자-facing read-only 모드는 `explore`, 명령은 `/explore`입니다.
- retired read-only command spelling은 alias/fallback으로 허용하지 않습니다.
- discovery artifact와 review contract를 위해 실행 스킬 이름은 계속 `workflow-investigate`입니다.
- Runtime contract는 `UserMode → TaskType → Step → Guard`입니다: `explore → read`, `brainstorm → design`, `verify → verify`, `implement/fix → write`, `dobby → freeform`.
- retired entry의 command docs를 제거하고 README, command docs, workflow docs, agent instructions를 6개 canonical command 기준으로 갱신했습니다.
- 릴리즈/metadata tag는 `0.*` 시리즈로 정규화했습니다. 이전 `2.*`, `3.*`, `4.*` metadata label은 더 이상 current-facing이 아닙니다.

### Canonical Commands

| Command | Mode | Task type | Entry skill |
|---------|------|-----------|-------------|
| `/brainstorm` | `brainstorm` | `design` | `workflow-brainstorm` |
| `/implement` | `implement` | `write` | `workflow-investigate` → `workflow-implementation-plan` |
| `/fix` | `fix` | `write` | `workflow-investigate` |
| `/explore` | `explore` | `read` | `workflow-investigate` |
| `/verify` | `verify` | `verify` | `workflow-verify` |
| `/dobby` | `dobby` | `freeform` | `workflow-human-check` |

### 검증

- Focused migration suites 통과: contract, classifier, workflow loader, state seeder, keyword detector, workflow scenarios, state-contract injector, pre-tool enforcer.
- 전체 검증은 `npm test`, `npm run typecheck`, `npm run test:engine`, `node scripts/session-end.mjs`를 포함합니다.

## 이전 0.* Milestones

`v0.4.0` 이전 개발 기록은 `document/implementation.md`와 `document/implementation-v2.md`에 구현 이력으로 보관합니다. 해당 문서는 pre-`v0.4.0` command name과 state shape을 설명할 수 있으며, 현재 user-facing 릴리즈 태그가 아닙니다.
