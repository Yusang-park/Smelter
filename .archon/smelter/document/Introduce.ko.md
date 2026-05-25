---
title: Smelter — 철학과 방향 (한국어)
type: translation
lang: ko
base: document/Introduce.md
tags: [smelter, philosophy, workflow, skill-composition, korean]
updated: 2026-04-28
---

> 이 문서는 [`document/Introduce.md`](Introduce.md) (영문 canonical)의 한국어 번역본입니다.
> 영문이 항상 최신입니다.

# Smelter — 철학과 방향

> "실제 인간 개발자의 워크플로우를 자동화한다."

Smelter는 Claude Code 설정 레이어가 아니다. PM으로부터 업무 수령 → 조사 → 기획 → TDD → 구현 → 검증 → 리뷰 → 배포라는 **실제 팀 소프트웨어 개발 프로세스**를 모델링하고 Claude Code가 이를 실행하도록 조율하는 **워크플로우 엔진**이다.

---

## 1. 스킬 조합

Smelter는 원자 단위의 **workflow 스킬** (`workflow-*`)을 모드로 조합한다:

| 모드 | 진입 스킬 | 용도 |
|------|-----------|------|
| `fix` | `workflow-investigate` | 버그 / 로직 수리 |
| `explore` | `workflow-investigate` | 정적 조사 (맥락·근거 파악) |
| `verify` | `workflow-verify` | 비수정 검증 (테스트 + 정적 점검 + E2E) |
| `brainstorm` | `workflow-investigate` (deep) → `workflow-brainstorm` | 신규 기능 / 리팩토링, 기획 우선 |
| `implement` | `workflow-investigate` → `workflow-implementation-plan` | 기존 코드 기반 구현 계획과 빌드 |

각 스킬은 계약 (`consumes`, `produces`, `gate`)을 선언한다. 실패는 **producer chain**으로 라우팅 — 재시도 없음, 회피 없음, 자기 포기 없음. `document/workflow.md` §5 참조.

---

## 2. 에이전트는 기억하지 않는다 — 에이전트는 파일을 읽는다

모든 plan, 결정, 실행 상태는 `.smt/` 하위 디스크에 존재:

```
.smt/
├── features/
│   └── <feature-slug>/
│       ├── task/
│       │   ├── plan.md                   ← feature 목표, 범위, acceptance criteria
│       │   ├── <task-name>.md            ← 사람이 읽는 작업 기록
│       │   └── <task-name>.state.json    ← 기계 상태 (v0.55 스키마)
│       ├── decisions.md
│       └── artifacts/                    ← e2e 영상, 스크린샷, 로그
└── state/                                ← 전역 세션 상태
```

결과:
- 현재 목표와 범위가 파일로 고정.
- 대기 task와 상태가 명시 추적.
- 계획 개정이 덮어쓰기 아닌 누적.
- 문서 간 상호 참조 보존.
- 검증 증거는 파일 기반, 에이전트 주장 아님.

---

## 3. 고정 역할 에이전트 구조

| 에이전트 | 1차 역할 | 하지 않음 |
|---------|---------|-----------|
| `planner` | 기획 상태, 범위, acceptance criteria, task 분할 | 구현, 최종 검증 |
| `executor` | 할당된 task의 구체 코드 변경 | 재기획, 아키텍처 결정, 최종 승인 |
| `architect` | 아키텍처 리뷰, 디버깅 분석, 구현 검증 | 구현, plan 생성 |
| `tdd-guide` | Test-first 워크플로우, RED/GREEN 훈련 | feature 소유, 최종 feature 승인 |
| `code-reviewer` | 품질 / 보안 / 유지보수성 독립 리뷰 | 구현, 범위 확장 |
| `security-reviewer` | 취약점 / 권한 / 데이터 노출 리뷰 | 구현 |
| `qa-tester` | E2E 실행, artifact 캡처 | 구현 |
| `aggregator` | Pattern C 병렬 결과 merge | 의사결정, 충돌 해결 |
| `conflict-resolver` | aggregator 병합 실패 중재 | 최초 저작 |
| `critic-watchdog` | 실시간 Iron Law 규칙 강제 | 읽기 전용 관찰 이외의 모든 것 |
| `debugger` | Stall 진단 (Cascade L1) | 쓰기 action |

각 에이전트는 명확한 1차 역할을 가지며 필요 시에만 인계.

---

## 4. 다층 검증

Smelter는 "실행 후 완료"를 받아들이지 않는다. 출력은 여러 독립 검증을 거쳐 **재제련** 된다:

- **Multi-Pass Verification (§9-3)**: 모든 review 스킬은 pass 선언 전 2 라운드(omission / contradiction) 수행.
- **Pattern B Dual Adversarial (agent-review)**: `code-reviewer` + `security-reviewer` 병렬 실행; `arbitrator` merge.
- **Pattern B 95% Consensus (team-code-review)**: advocate / critic / arbitrator가 합의 도달까지 iterate.
- **Critic Watchdog (§12-8)**: 11 규칙 hook 레이어가 구현 중 Iron Laws 상시 강제.
- **Human Check (§10)**: Video / Log / Diff 리포트로 최종 사용자 게이트.

---

## 5. Iron Laws (8개)

`document/workflow.md` §0 참조. 8개의 양보 불가 원칙:

1. 실패 후 halt 금지 — 사용자 stop만 세션 종료.
2. 회피 금지 — fail은 해소해야 하며 "known limit"으로 재분류 불가.
3. 자기 실패 선언 금지 — 스킬은 "can't do it" 출력 불가.
4. 재시도 없음 — 맹목 재실행 대신 producer chain 라우팅.
5. 파일이 진실 — 완료는 postcondition 파일이 결정, 에이전트 주장 아님.
6. Workflow whitelist는 사용자 결정 — mode upgrade는 명시 사용자 동의 필요.
7. 독립 queue, 공유 세션, specialist 할당 — task queue는 절대 혼선 안 됨; 세션 컨텍스트는 task 간 공유 가능.
8. Scoped testing — `workflow-human-check` 이전에는 변경 surface 테스트만 실행.

---

## 6. 진입점

| 사용자 입력 | Mode classifier 라우팅 |
|-------------|------------------------|
| "text fix", "CSS", "rename", "typo", "translation" | surface exemption이 적용된 `fix` |
| "bug", "error", "not working", "broken" | `fix` |
| "analyze", "investigate", "how does X work" | `explore` |
| "테스트 해봐", "점검해", "run tests" | `verify` |
| "design", "plan", "refactor", "new feature" | `brainstorm` |
| "build", "add", "implement", "extend" | `implement` |
| 불명확 | `fix` (안전 기본값) |

