---
title: Smelter Workflow (한국어)
type: translation
lang: ko
base: document/workflow.md
tags: [smelter, workflow, skill-composition, producer-routing, tdd, e2e, auto-confirm, korean]
status: translation
version: 2.4.1
created: 2026-04-19
updated: 2026-04-20
---

> **Note**: 이 문서는 `document/workflow.md` (English canonical) 의 한국어 번역본입니다.
> 원본이 항상 최신이며, 번역과 상충 시 원본을 따릅니다.

# Smelter Workflow — Skill-Composition Model

> Smelter는 **Skill을 조합**하여 모드를 구성한다. 각 스킬은 자기 contract (`consumes` / `produces` / `gate`)를 선언하고, 실패 시 **producer chain**으로 라우팅된다.
> **Workflow 스킬** (`workflow-*` 접두사)만 mode whitelist의 제약을 받으며, 일반 유틸리티 스킬은 자유롭게 사용 가능하다.

---

## 0. 핵심 원칙 (Iron Laws)

| # | 원칙 | 의미 |
|---|------|------|
| 1 | **절대 정지 금지** | 에이전트는 "실패 후 멈춤"을 선언할 수 없다. 유일한 정지 조건은 **사용자의 명시적 stop** (섹션 11 auto-confirm hook 참고). |
| 2 | **회피 금지** | fail을 "known limit"으로 퉁치거나 자기선언 완료 불가. 문제를 해결할 때까지 producer chain으로 재라우팅한다. |
| 3 | **자기 포기 금지** | 스킬은 "못하겠음"을 출력할 수 없다. `result ∈ { pass, fail }`만 허용. |
| 4 | **재시도 없음** | 동일 동작의 기계적 재실행(`max_retry`) 개념을 삭제한다. 대신 producer로 라우팅하여 **상류 원인을 수정 후** 복귀. 이는 재시도가 아니라 전진. |
| 5 | **파일이 진실** | 스킬 완료는 **파일 검증 가능한 postcondition**으로만 인정. 에이전트 자기선언 금지. |
| 6 | **Workflow whitelist는 사용자 결정** | `workflow-*` 스킬만 mode의 `allowed_skills`에 제약받는다. 현재 모드가 허용하지 않는 workflow 스킬이 필요해지면 에이전트가 판단하지 않고 **사용자에게 mode upgrade 요청**. 일반 유틸리티 스킬(`ui-ux-pro-max`, `copywriting`, `claude-api` 등)은 **제약 없이 자유 사용**. |
| 7 | **독립 큐, 공유 세션, 전문가 할당** | Task의 **Queue**는 독립 관리. 같은 세션에서 **여러 task 공유 진행** 허용. Task는 **specialist agent** (frontend, backend, security 등) 할당 가능. **Team Agent** (다중 에이전트 협업) 지원. |
| 8 | **스코프 테스트** | 변경 파일과 연관된 테스트만 실행. 전체 회귀는 `workflow-human-check`에서 명시적으로만. |

---

## 1. 실행 모델

### 1-1. 구조

```
┌─────────────┐     ┌──────────┐     ┌───────────────────┐
│   Command   │ ──▶ │   Mode   │ ──▶ │  workflow-* Skill │
│  (사용자)    │     │whitelist │    │   (atomic)        │
└─────────────┘     └──────────┘     └───────────────────┘
                                              ▲
                                              │ (whitelist 무관)
                                     ┌─────────────────────┐
                                     │  Utility Skills     │
                                     │  (ui-ux-pro-max,    │
                                     │   copywriting, ...) │
                                     └─────────────────────┘
```

- **Command**: 사용자 진입점 (힌트, 자동 분기 우선)
- **Mode**: 허용된 `workflow-*` 스킬 집합 + 초기 스킬
- **Workflow Skill**: `workflow-*` 접두사. mode whitelist 대상. 상태 변경 수반.
- **Utility Skill**: 접두사 없음. 자유 사용. 상태 변경 없음.

### 1-2. Commands & 자동 분기

Commands는 **힌트**이며, 기본 원칙은 **사용자 입력 기반 자동 분기**. 사용자가 명시적으로 커맨드를 호출해도 되지만, 자연어 입력을 받았을 때 엔트리 시점에 자동 분류한다.

#### 자동 분기 테이블

| 입력 패턴 (자연어) | 분기 모드 | 명시 커맨드 |
|-------------------|-----------|-------------|
| "파악해", "분석해", "어떻게 되어있어?", "조사해", "검증해", "확인해", "체크해" | `investigate` | `/investigate` |
| "테스트 해봐", "점검해", "돌려봐", "실행해", "run tests", "health check" | `verify` | `/verify` |
| "만들거야", "리팩토링할거야", "설계해", "기획해" | `plan` | `/plan` |
| "~만들어줘", "~추가해줘", "~구현해줘" | `implement` | `/implement` |
| "텍스트 수정", "이름 바꿔", "색깔 변경", "css", "오타", "번역" | `simple_fix` | `/simple-fix` |
| "버그", "문제", "에러", "작동 안 해", "고쳐줘" | `fix` | `/fix` |
| 불명확 | `fix` (안전 기본값) | — |

**원칙**:
- 분기 판단은 **엔트리 시점에만** 수행. 워크플로우 중간 모드 변경은 사용자 결정 (upgrade gate).
- 자동 분기는 **패턴 매칭 규칙 기반**이며, LLM 추론에 맡기지 않는다 (회피 금지 원칙).
- 사용자가 `/fix` 등 명시 커맨드를 입력하면 자동 분기를 **오버라이드**한다.

#### 모드 요약

| Mode | 진입 스킬 | 용도 |
|------|---------|------|
| `simple_fix` | `workflow-coding` | 텍스트/CSS/상수 등 명확한 값 치환 |
| `fix` | `workflow-investigate` | 버그·문제 수정. 로직/흐름 변경 필요. |
| `investigate` | `workflow-investigate` | 정적 파악만 수행 (맥락·근거). 이후 mode transition. |
| `verify` | `workflow-verify` | 비수정 검증 (테스트·점검·E2E 인터페이스). 단일 리포트 산출. |
| `plan` | `workflow-brainstorm` (deep) | 신규 기능·리팩토링 기획 우선 |
| `implement` | `workflow-brainstorm` (light) | 기존 코드 기반 경량 구현 |

### 1-3. Magic Keyword

자연어 내에 포함되면 스킬 플래그를 세팅한다. (자동 분기와 별개로 surface 기반 제약을 전달)

| 키워드 | 동작 |
|--------|------|
| `css`, `style`, `텍스트`, `i18n`, `typo`, `dialogue` | `workflow-write-test` TDD 면제 플래그 auto-set (surface-based exemption) |
| `extend`, `add to`, `덧붙여` | `implement`의 `workflow-brainstorm` 단계 **skip** |
| `fix`, `bug`, `버그`, `문제` | `fix` 모드 유도 (`/simple-fix` 진입 중에도 interface 변경 감지 시 mode upgrade 제안) |

### 1-4. Workflow Skills vs Utility Skills

Smelter에는 두 종류의 스킬이 있다. Mode 제약은 **workflow 스킬에만 적용**.

#### workflow-* 스킬 (mode whitelist 대상, 13개)

- `workflow-brainstorm`, `workflow-brainstorm-review`
- `workflow-investigate`, `workflow-investigate-review`
- `workflow-tasker`, `workflow-tasker-review`
- `workflow-write-test`, `workflow-coding`
- `workflow-agent-review`
- `workflow-e2e`, `workflow-e2e-review`
- `workflow-team-code-review`
- `workflow-human-check`

특징:
- Mode의 `allowed_skills`에 선언된 것만 실행
- `state.json` 갱신 (events, test_cycles 등)
- Producer chain 라우팅 대상
- 각 스킬은 `skills/<name>/SKILL.md`에 정의, contract 포함

#### 일반 유틸리티 스킬 (자유 사용)

예: `ui-ux-pro-max`, `copywriting`, `claude-api`, `test-driven-development`, `vercel-react-best-practices`, `e2e-testing-patterns`, 기타.

특징:
- Mode 제약 없이 언제든 호출 가능
- `state.json` 상태 변경 없음 (보조 도구)
- Producer chain 외부
- workflow 스킬 내부에서 자유롭게 호출 가능 (예: `workflow-coding`이 `ui-ux-pro-max`를 호출)

> **원칙**: `workflow-*`는 **작업 진행의 단위**, 유틸리티는 **도구**.

---

## 2. Task State Model

### 2-1. 파일 레이아웃

```
.smt/features/<feature-slug>/
├── task/
│   ├── plan.md                  ← 기능 목표·범위·acceptance criteria
│   ├── <task-name>.md           ← 사람이 읽는 작업 기록│   └── <task-name>.state.json   ← 기계 상태 (단일 출처)
├── decisions.md
└── artifacts/                   ← e2e 비디오·스크린샷·로그
```

### 2-2. State JSON 스키마

```json
{
  "task_id": "fix-empty-input-bug",
  "mode": "fix",
  "allowed_skills": [
    "workflow-investigate", "workflow-investigate-review",
    "workflow-tasker", "workflow-tasker-review",
    "workflow-write-test", "workflow-coding",
    "workflow-agent-review",
    "workflow-e2e", "workflow-e2e-review",
    "workflow-team-code-review",
    "workflow-human-check"
  ],
  "current_stage": "workflow-coding",
  "completed_stages": [
    "workflow-investigate",
    "workflow-investigate-review",
    "workflow-tasker",
    "workflow-tasker-review",
    "workflow-write-test"
  ],
  "created_at": "2026-04-19T10:00:00Z",
  "updated_at": "2026-04-19T10:45:00Z",
  "target_type": "bug_fix",
  "surface": ["ui"],
  "exempt": { "tdd": false, "e2e": false },
  "team_runtime": {
    "workflow-investigate": {
      "pattern": "A",
      "assigned_agents": [{ "id": "a1", "agent_type": "explore-medium", "status": "done" }]
    },
    "workflow-coding": {
      "pattern": "A",
      "assigned_agents": [{ "id": "a2", "agent_type": "executor", "status": "in_progress" }],
      "watchdog_enabled": true
    },
    "workflow-e2e": {
      "pattern": "A",
      "assigned_agents": [{ "id": "a3", "agent_type": "qa-tester", "status": "pending" }]
    },
    "workflow-agent-review": {
      "pattern": "B",
      "assigned_agents": [
        { "id": "a4", "agent_type": "code-reviewer", "status": "pending" },
        { "id": "a5", "agent_type": "security-reviewer", "status": "pending" }
      ],
      "aggregator": "arbitrator"
    },
    "workflow-team-code-review": {
      "pattern": "B",
      "assigned_agents": [
        { "id": "a6", "agent_type": "advocate", "status": "pending" },
        { "id": "a7", "agent_type": "critic", "status": "pending" },
        { "id": "a8", "agent_type": "arbitrator", "status": "pending" }
      ],
      "aggregator": "arbitrator"
    }
  },
  "events": [
    {
      "t": "2026-04-19T10:00:00Z",
      "skill": "workflow-investigate",
      "result": "pass",
      "declarer": "hook",
      "cause": null,
      "evidence": { "type": "file_present", "detail": "investigation.md created" }
    },
    {
      "t": "2026-04-19T10:20:00Z",
      "skill": "workflow-coding",
      "result": "fail",
      "declarer": "hook",
      "cause": "typecheck",
      "evidence": { "type": "exit_code", "detail": "tsc exit 2, 3 errors" }
    }
  ],
  "test_cycles": [
    {
      "t": "2026-04-19T10:30:00Z",
      "file": "src/lib/validator.test.ts",
      "action": "added_case",
      "case_name": "returns null when input is empty (bug #123)",
      "run_result": "fail",
      "error": "Expected null, got undefined"
    }
  ],
  "active_feedback": [
    {
      "id": "fb-001",
      "from": "workflow-human-check@2026-04-19T11:00:00Z",
      "target_skill": "workflow-coding",
      "text": "validation 로직이 너무 방어적. null 케이스만 필요.",
      "evidence_ref": "events[8]",
      "resolved": false
    }
  ],
  "sub_tasks": []
}
```

### 2-3. 새 task 초기화 규칙 (hook 강제)

- 새 `<task-name>.md` 생성 시 동일 basename의 `.state.json`을 아래 초기값으로 생성:
  - `current_stage: null`
  - `completed_stages: []`
  - `events: []`, `test_cycles: []`, `active_feedback: []`, `sub_tasks: []`
  - `team_runtime: {}` (tasker가 채움)
- 세션 내에서 여러 task를 오가도 **각 state.json만 참조**. active task는 `.smt/active_task` 심링크로 지시.

### 2-4. 토큰 최적화

- 프롬프트 주입 시 `events` 최근 **5개**만 포함
- `test_cycles`는 현재 `current_stage`와 관련된 파일만
- `active_feedback`는 `resolved: false`만
- 나머지는 디스크에 남으나 컨텍스트에 미포함

---

## 3. Workflow Skill Registry (14 skills)

> 스킬 정의는 **전역 1개소** (`skills/workflow-<name>/SKILL.md`). 모드 간 공유.

| # | Skill | Consumes | Produces | 비고 |
|---|-------|----------|----------|------|
| 1 | `workflow-brainstorm` | `<trigger_prompt>` | `brainstorm.md` | `depth: deep\|light` 파라미터 |
| 2 | `workflow-brainstorm-review` | `brainstorm.md` | `brainstorm_review.md` | pass/fail/reshape |
| 3 | `workflow-investigate` | `brainstorm.md` OR `<trigger_prompt>` | `investigation.md` | 기존 코드·데이터 조사 |
| 4 | `workflow-investigate-review` | `investigation.md` | `investigate_review.md` | pass/fail/reshape |
| 5 | `workflow-tasker` | `investigation.md` [+`brainstorm.md`] | `plan.md` (Queue + Approaches), `target_type`, `team_runtime` 초기 할당 | `target_type: new_feature\|refactor\|extend_existing\|migration\|bug_fix` |
| 6 | `workflow-tasker-review` | `plan.md` | `tasker_review.md` | side-effect 검토 포함. pass/fail/reshape |
| 7 | `workflow-write-test` | `plan.md` | `*.test.*` files (RED), `test_cycles` 엔트리 | surface-based 면제 적용 |
| 8 | `workflow-coding` | `*.test.*` (RED) OR `active_feedback` | `src/**` 파일 변경 | 실제 코드 구현 |
| 9 | `workflow-agent-review` | `src/**` diff | `agent_review.md`, `## Risks` 갱신 | Pattern B Dual Adversarial (code-reviewer + security-reviewer). "no security surface" 시 A로 격하. |
| 10 | `workflow-e2e` | `src/**` built | `artifacts/` (비디오·스크린샷·로그·transcript·io-samples) | **실제 인터페이스** 구동 강제 (UI=브라우저, CLI=subprocess, API=실 서버·네트워크, DB=실 엔진, Hook=실제 파이프). 테스트 러너 출력만으론 pass 불가. |
| 11 | `workflow-e2e-review` | `artifacts/` | `e2e_review.md` | 시나리오 충분성 검토 |
| 12 | `workflow-team-code-review` | 전체 변경 | `team_review.md` (severity 분류) | **다중 에이전트 95% 합의** |
| 13 | `workflow-verify` | 현 코드베이스 (no RED 요구) | `verify_report.md` (Phase 1 tests + Phase 2 static inspection + Phase 3 E2E) | `/verify` 모드 진입 스킬. 수정 없음. Multi-Pass 미사용 (리뷰 스킬 아님). |
| 14 | `workflow-human-check` | 모든 산출물 | 사용자 결정 (`rework` / `complete` / `hold` / `upgrade`) | 최종 게이트 |

### 3-1. Skill Contract 예시 (`skills/workflow-coding/SKILL.md`)

```yaml
---
name: workflow-coding
produces: src_files_changed
consumes: test_red_files  # OR active_feedback_target_coding
gate:
  - postcondition: "git diff --cached --name-only | grep -v '\\.test\\.'"
  - tdd_cycle: "test_cycles has action=added_case|modified_case + run_result=fail for this task"
default_agent: executor
can_delegate_to: [ui-ux-pro-max, copywriting, vercel-react-best-practices]
---
```

---

## 4. Mode Definitions

### 4-1. simple_fix (entry: `/simple-fix` 또는 자동 분기)

**allowed_skills**: `workflow-coding`, `workflow-e2e`, `workflow-human-check`

```
   ╭─────────────────╮     ╭──────────────╮     ╭──────────────────────╮
   │ workflow-coding │────▶│ workflow-e2e │────▶│ workflow-human-check │
   ╰─────────────────╯     ╰──────────────╯     ╰──────────────────────╯
           ▲                      │                        │
           │ fail                 │ fail                   │ rework
           │                      ▼                        │
           └──────────────────────┴────────────────────────┘
```

**특징**:
- 텍스트·CSS·상수 치환 전용
- TDD 면제 (surface-based auto-apply)
- interface 변경이 있으면 `workflow-e2e`는 반드시 수행
- 로직 변경이 감지되면 `workflow-human-check`에서 사용자에게 **mode upgrade to `fix` 제안**

### 4-2. fix (entry: `/fix` 또는 자동 분기)

**allowed_skills**: simple_fix의 3개 + `workflow-investigate`, `workflow-investigate-review`, `workflow-tasker`, `workflow-tasker-review`, `workflow-write-test`, `workflow-agent-review`, `workflow-e2e-review`, `workflow-team-code-review`

```
  ╭──────────────────────╮    ╭───────────────────────────╮    ╭─────────────────╮
  │ workflow-investigate │───▶│ workflow-investigate-review│───▶│ workflow-tasker │
  ╰──────────────────────╯    ╰───────────────────────────╯    ╰─────────────────╯
            ▲                         │ reshape                         │
            │ fail                    │                                 ▼
            └─────────────────────────┘                       ╭─────────────────────╮
                                                              │workflow-tasker-review│
                                                              ╰─────────────────────╯
                                                                      │ pass
                                                                      ▼
  ╭────────────────────╮   ╭─────────────────╮   ╭───────────────────────╮
  │ workflow-write-test│──▶│ workflow-coding │──▶│ workflow-agent-review │
  ╰────────────────────╯   ╰─────────────────╯   ╰───────────────────────╯
                                  ▲                        │ pass
                                  │ fail                   ▼
                                  │                ╭──────────────╮   ╭─────────────────────╮
                                  │                │ workflow-e2e │──▶│ workflow-e2e-review │
                                  │                ╰──────────────╯   ╰─────────────────────╯
                                  │                       ▲                     │ pass
                                  │                       │                     ▼
                                  │                       │          ╭────────────────────────╮
                                  │                       │          │workflow-team-code-review│
                                  │                       │          ╰────────────────────────╯
                                  │                       │                     │ pass
                                  │                       │                     ▼
                                  │                       │          ╭──────────────────────╮
                                  │                       │          │ workflow-human-check │
                                  │                       │          ╰──────────────────────╯
                                  │                       │                     │
                                  └───────────────────────┴─────────────────────┘
                                                  all fail → workflow-coding
```

### 4-3. investigate (entry: `/investigate` 또는 자동 분기)

**allowed_skills**: `workflow-investigate`, `workflow-investigate-review`

```
  ╭──────────────────────╮   ╭────────────────────────────╮   ╭──────────────────────╮
  │ workflow-investigate │──▶│ workflow-investigate-review│──▶│   mode_transition    │
  ╰──────────────────────╯   ╰────────────────────────────╯   ╰──────────────────────╯
            ▲                        │                         │       │       │
            │ fail                   │                         ▼       ▼       ▼
            └────────────────────────┘                       /fix   /plan  free_chat
```

**출구**: 사용자가 다음 모드 선택. 자동 전환 금지(사용자 확인 필수).

### 4-4. plan (entry: `/plan` 또는 자동 분기)

**allowed_skills**: `workflow-brainstorm`, `workflow-brainstorm-review`, `workflow-investigate`, `workflow-investigate-review`, `workflow-tasker`, `workflow-tasker-review`

```
  ╭─────────────────────╮      ╭────────────────────────────╮      ╭──────────────────────╮
  │ workflow-brainstorm │─────▶│ workflow-brainstorm-review │─────▶│ workflow-investigate │
  ╰─────────────────────╯      ╰────────────────────────────╯      ╰──────────────────────╯
           ▲                          │ ▲                                     │
           │ fail                     │ │ reshape                             │
           └──────────────────────────┘ └─────────────────────────────────────┤
                                                                              ▼
  ╭────────────────────────────╮    ╭─────────────────╮    ╭─────────────────────────╮
  │ workflow-investigate-review│───▶│ workflow-tasker │───▶│ workflow-tasker-review  │
  ╰────────────────────────────╯    ╰─────────────────╯    ╰─────────────────────────╯
              ▲                                                         │ pass
              │ fail                                                    ▼
              └─────────────────                              ╭──────────────────╮
                                                             │ mode_transition  │
                                                             ╰──────────────────╯
                                                                      │
                                                                      ▼
                                                                  /implement
```

**특징**:
- `workflow-brainstorm` (deep) → 기획 우선
- `workflow-brainstorm ↔ workflow-investigate` 양방향 (reshape edge)
- 최종 출구는 `/implement`

### 4-5. implement (entry: `/implement` 또는 자동 분기)

**allowed_skills**: plan + fix의 합집합 (13개 전체)

```
  ╭──────────────────────────╮    ╭────────────────────────────╮    ╭──────────────────────╮
  │ workflow-brainstorm(light)│───▶│ workflow-brainstorm-review │───▶│ workflow-investigate │
  ╰──────────────────────────╯    ╰────────────────────────────╯    ╰──────────────────────╯
           │  skip_if: extend               │ ▲                                 │
           └────────────────────────────────┘ │ reshape                         │
                                              └─────────────────────────────────┤
                                                                                ▼
                                                        [fix와 동일:
                                                         workflow-investigate-review
                                                          → workflow-tasker → ...
                                                          → workflow-human-check]
```

**특징**:
- `workflow-brainstorm(light)`: 프롬프트 기반 간단 인터뷰 (`depth: light`)
- `extend` 키워드 시 brainstorm 단계 skip
- 이후 흐름은 fix와 동일

---

## 5. Routing Rules

### 5-1. Producer Chain (기본 실패 라우팅)

```
workflow-brainstorm-review   ─fail─▶ workflow-brainstorm
workflow-investigate-review  ─fail─▶ workflow-investigate
workflow-tasker-review       ─fail─▶ workflow-tasker
workflow-write-test          ─fail─▶ workflow-tasker          (계획 재검토 필요)
workflow-coding              ─fail─▶ workflow-write-test      (RED cycle 불충족 시)
                                      OR workflow-tasker      (계획이 틀림)
workflow-agent-review        ─fail─▶ workflow-coding
workflow-e2e                 ─fail─▶ workflow-coding
workflow-e2e-review          ─fail─▶ workflow-coding
workflow-team-code-review    ─fail─▶ workflow-coding (medium/low)
                                      workflow-tasker (high/critical)
workflow-human-check         ─fail─▶ active_feedback[].target_skill (기본 workflow-coding)
```

### 5-2. Reshape Edge (review 스킬만 사용)

Review 스킬은 `result ∈ { pass, fail, reshape }` 출력 가능.
- `pass`: 다음 스킬로 전진
- `fail`: producer로 복귀 (원본 재작업)
- `reshape`: **더 상위 스킬로 복귀** (원본이 아닌, 범위 재설정)

예: `workflow-investigate-review`가 "조사 결과 범위가 달라짐"이라 판단 → `reshape → workflow-brainstorm`
(`reshape`는 evidence 필드에 근거 기록 필수. 자의적 선언 금지.)

### 5-3. Mode Whitelist 검증 (hook 강제)

**적용 대상**: `workflow-*` 접두사 스킬만. 유틸리티 스킬은 검증 생략.

라우팅 target이 `workflow-*`이고 `allowed_skills` 밖이면:

1. **Producer chain fallback**: 상류로 탐색, 가장 가까운 allowed skill로 대체
2. **Fallback 실패 시 에스컬레이션**: `workflow-human-check`의 "mode upgrade" 옵션으로 사용자 결정

### 5-4. Mode Upgrade

**방향**: 모두 허용 (양방향 포함)

```
simple_fix ──▶ fix ──▶ implement ──▶ plan
              ◀──     ◀──           ◀──
   (← 되돌아가기도 허용, 단 사용자 결정 필수)
```

**업그레이드 시 state.json 갱신**:
- `mode` 필드 치환
- `allowed_skills` 재계산
- `events`, `test_cycles`, `active_feedback`, `sub_tasks` **보존**

---

## 6. Fail Model

### 6-1. Fail 이벤트 구조 (고정 스키마)

```json
{
  "t": "ISO8601",
  "skill": "<workflow-* skill name>",
  "result": "fail",
  "declarer": "hook | user",
  "cause": "<fixed enum>",
  "evidence": { "type": "<fixed enum>", "detail": "<string>" }
}
```

### 6-2. Declarer 우선순위

| Declarer | 권한 | 적용 |
|----------|------|------|
| `hook` | 최우선 | typecheck, lint, test_run, build, file_absent, tdd_cycle |
| `skill` | ❌ **금지** | "못하겠음" 셀프 페일 불가 (원칙 3) |
| `user` | 최종 | `workflow-human-check`에서만 선언 가능 |

### 6-3. Cause Enum (고정)

| Cause | 적용 스킬 | 검증 방식 |
|-------|----------|----------|
| `typecheck` | workflow-write-test, workflow-coding, workflow-e2e | `tsc --noEmit` exit code |
| `lint` | workflow-write-test, workflow-coding | eslint exit code |
| `test_run` | workflow-coding, workflow-e2e, workflow-team-code-review | 테스트 러너 exit code |
| `build` | workflow-e2e | `npm run build` exit code |
| `assertion` | workflow-e2e | 테스트 어서션 실패 |
| `file_absent` | 모든 리뷰 스킬 | postcondition 파일 부재 |
| `tdd_cycle` | workflow-coding | test_cycles에 RED 엔트리 부재 |
| `review_reject` | workflow-human-check | 사용자 명시 거부 |
| `scope_mismatch` | workflow-tasker-review, workflow-team-code-review | 계획 vs 구현 불일치 |
| `side_effect` | workflow-tasker-review | 타 기능 영향 감지 |
| `security` | workflow-agent-review, workflow-team-code-review | 취약점 발견 |
| `insufficient_scenario` | workflow-e2e-review | 시나리오 커버리지 부족 |

### 6-4. Evidence Type Enum

| Type | 내용 |
|------|------|
| `exit_code` | 명령 exit code + stderr 요약 |
| `file_absent` | 기대 파일 경로 |
| `parse` | 로그·출력 파싱 결과 |
| `user_input` | 사용자 입력 원문 |
| `diff` | git diff 발췌 |

### 6-5. Fail 이후 동작

```
┌─────────────┐
│ skill fails │
└─────────────┘
       │
       ▼
[events append] ──▶ [producer lookup] ──▶ [whitelist check (workflow-* only)]
                                                │
                         ┌──────────────────────┤
                         ▼                      ▼
                   [producer 허용]          [producer 불허]
                         │                      │
                         ▼                      ▼
                   producer 스킬 실행     mode upgrade 제안 → 사용자
                         │                      │
                         └──────────────────────┘
                                   │
                                   ▼
                          [auto-confirm hook 개입]
                                   │
                                   ▼
                          워크플로우 전진 계속
                          (유일한 정지: 사용자 stop)
```

**원칙 1·2·4의 결합**: 에이전트는 producer chain을 따라 **무한히 전진 시도**. 루프 감지는 사용자의 역할. retry count 없음.

---

## 7. TDD Cycle Log

### 7-1. 구조

```json
"test_cycles": [
  {
    "t": "ISO8601",
    "file": "<test file path>",
    "action": "added_case | modified_case | unchanged",
    "case_name": "<describe/it text>",
    "run_result": "fail | pass",
    "error": "<stderr or null>"
  }
]
```

### 7-2. 기존 기능 수정 지원

- 기존 test file이 이미 존재해도 OK
- `action: added_case` 또는 `modified_case` 엔트리 필수
- `case_name`은 task 설명 또는 bug id와 문자열 매칭 (느슨)

### 7-3. TDD Gate (hook 강제)

**`workflow-coding` 진입 시**:
- 해당 task의 `test_cycles`에 `action ∈ {added_case, modified_case}` + `run_result: fail` 엔트리 최소 1개
- 없으면 `declarer: hook, cause: tdd_cycle` → `workflow-write-test`로 라우팅

**workflow-e2e / workflow-team-code-review 통과 시**:
- 최근 `run_result: pass` 확인

### 7-4. Surface-based Exemption
| Surface | TDD | E2E |
|---------|-----|-----|
| CSS / style / typography | ❌ 면제 | ❌ (시각검증만) |
| i18n / copy | ❌ 면제 | ❌ |
| Typo (주석·문서) | ❌ 면제 | ❌ |
| Pure dialogue (코드 無) | ❌ 면제 | ❌ |
| Bug fix (로직) | ✅ 필수 | ✅ if interface |
| 기존 기능 behavior 변경 | ✅ 필수 | ✅ if user-visible |
| 신규 로직 | ✅ 필수 | ✅ if interface |

**면제 시 기록**: `state.json.exempt` 필드 + `decisions.md`에 `TDD: exempt (<reason>)`.

---

## 8. Active Feedback Flow

### 8-1. 생성

review 스킬 실패 또는 `workflow-human-check`의 `rework` 결정 시:

```json
"active_feedback": [
  {
    "id": "fb-001",
    "from": "workflow-human-check@2026-04-19T11:00:00Z",
    "target_skill": "workflow-coding",
    "text": "validation 로직이 너무 방어적. null 케이스만 필요.",
    "evidence_ref": "events[8]",
    "resolved": false
  }
]
```

### 8-2. 소비

- 다음 실행 스킬(주로 `workflow-coding`)의 **프롬프트 컨텍스트에 주입**
- `resolved: false`인 것만 로드
- 스킬 완료 시 해당 id를 `resolved: true`로 마킹

### 8-3. 누적

- 복수 피드백 자동 누적 (리뷰 2회 이상)
- 해결되지 않은 피드백이 남아있으면 `workflow-team-code-review`에서 재확인

---

## 9. Review Skills (역할 분리)

| 스킬 | 시점 | 검토 대상 | 기본 Pattern / 수행자 | Fail 시 |
|------|------|----------|------|---------|
| `workflow-brainstorm-review` | brainstorm 직후 | 기획의 모호·모순 | **B Adversarial** (critic only) | workflow-brainstorm |
| `workflow-investigate-review` | investigate 직후 | 조사 누락·리스크 | **A Single** (explore-high) | workflow-investigate |
| `workflow-tasker-review` | tasker 직후 | 계획 side-effect, 범위 | **B Team Consensus** (95%) | workflow-tasker |
| `workflow-agent-review` | coding 직후, e2e 전 | 코드 품질·버그·보안·Risk 등록 | **B Dual Adversarial** (code-reviewer + security-reviewer) | workflow-coding |
| `workflow-e2e-review` | e2e 직후 | 시나리오 커버리지, 로그·비디오 검증 | **A Single** | workflow-coding |
| `workflow-team-code-review` | e2e-review 직후 | 전체 변경 홀리스틱 | **B Team Consensus** (advocate + critic + arbitrator) | severity 따라 workflow-coding/workflow-tasker |
| `workflow-human-check` | 최종 | 비즈니스 맥락·의도 부합 | **User** | active_feedback.target_skill |

> Pattern 상세는 섹션 12 참조. tasker가 per-skill 오버라이드 가능.

### 9-1. 95% 합의 프로세스 (Pattern B)

**기본 적용**: `workflow-team-code-review`, `workflow-tasker-review`
**승격 가능**: `workflow-agent-review`는 dual adversarial (투표 없이 병합), `workflow-brainstorm-review`는 critic-only 단일.

```
advocate  (긍정): 장점·올바른 결정 옹호
critic    (부정): 문제·엣지케이스 지적
arbitrator(중립): 종합·점수 계산

라운드 반복: 모든 에이전트 동의율 ≥ 95% 도달까지
```

### 9-2. Severity 분류 (team-code-review / human-check)

| Severity | 기준 | 라우팅 |
|----------|------|-------|
| `CRITICAL` | 데이터 손실, 보안 취약, 서비스 중단 | workflow-tasker (재설계) |
| `HIGH` | 주요 버그·엣지 누락 | workflow-tasker |
| `MEDIUM` | 마이너 버그·개선 | workflow-coding |
| `LOW` | 스타일·네이밍 | Risks 기록, 계속 |

`## Risks` 섹션은 task 문서에 유지.

### 9-3. Multi-Pass Verification (3-Round 강제)

> **모든 review 스킬은 3 라운드를 강제**로 거친다. 각 라운드는 서로 다른 초점으로 실행되며, 세 라운드가 **모두 pass**일 때만 review 스킬 전체 pass.

#### 3 Round 구조

| Round | Focus | 검증 질문 |
|-------|-------|---------|
| 1 | **누락** (omission) | "필요한 것이 빠졌는가? 요구사항·테스트 케이스·고려사항이 모두 포함되었는가?" |
| 2 | **모순** (contradiction) | "논리적으로 충돌하거나 모순되는 결정·주장이 있는가? 선행 산출물과 불일치는 없는가?" |
| 3 | **엣지 케이스** (edge case) | "경계 조건·예외·특수 상황을 놓쳤는가? Null/empty/boundary/race condition/동시성 커버?" |

#### 적용 스킬

다음 6개 review 스킬에 **필수 적용**:

- `workflow-brainstorm-review`
- `workflow-investigate-review`
- `workflow-tasker-review`
- `workflow-agent-review`
- `workflow-e2e-review`
- `workflow-team-code-review`

(`workflow-human-check` 제외 — 사용자가 직접 판단)

#### Agent 할당 전략

| Pattern | Round별 Agent |
|---------|---------------|
| **Pattern A** (single agent) | 각 Round에 **다른 agent 타입** 권장. 불가 시 동일 agent라도 **이전 라운드 산출물 컨텍스트 제거**하고 focus 프롬프트 교체 (fresh perspective). |
| **Pattern B** (consensus) | 각 Round을 N-agent 95% 합의로 진행 (3 × N agents × M rounds). tasker가 복잡도 따라 축소 가능. |
| **Pattern D** (hierarchical) | Lead agent가 3 라운드 orchestration. 각 라운드별 하위 agent 다른 관점 할당. |

#### state.json 확장 (team_runtime 내부)

```json
"team_runtime": {
  "workflow-agent-review": {
    "pattern": "B",
    "min_verification_rounds": 3,
    "rounds": [
      {
        "n": 1,
        "focus": "omission",
        "result": "pass",
        "agent_type": "code-reviewer",
        "findings": []
      },
      {
        "n": 2,
        "focus": "contradiction",
        "result": "pass",
        "agent_type": "security-reviewer",
        "findings": []
      },
      {
        "n": 3,
        "focus": "edge_case",
        "result": "fail",
        "agent_type": "qa-tester",
        "findings": ["boundary: negative input not handled", "race: concurrent writes 미검증"]
      }
    ],
    "completed_rounds": 2,
    "status": "in_progress"
  }
}
```

#### Fail 처리

- **어느 라운드든 fail** → review 스킬 전체 fail
- `events`에 `cause: verification_failed, evidence: {round: N, focus: X, findings: [...]}` 기록
- Producer chain 라우팅 (기존 5-1 규칙)
- 재진입 시 **전체 3 라운드 재실행** (pass한 라운드라도). 수정된 산출물에 대해 처음부터 검증.

#### 회피 방지 장치 (원칙 2 강화)

1. **각 라운드 독립 실행**: 이전 라운드 결론을 현재 라운드 프롬프트에 주입 금지 (bias 제거)
2. **"이미 검증함" 답변 차단**: Critic Watchdog이 skip 발언 감지 시 hook으로 round 무효화 + fail 처리
3. **agent 반복 감지**: 같은 agent가 3 라운드 연속 시 warning 기록 (Pattern A 최소 2종 혼합 권장)
4. **Round 건너뛰기 금지**: `completed_rounds < 3` 상태에서 review 스킬 pass 선언 불가 (hook 강제)

#### 비용 vs 엄격성 조절

기본 `min_verification_rounds: 3`. 예외:
- tasker가 "trivial 수정"으로 판단 시 → `min_verification_rounds: 1`로 축소 선언 가능 (state.json에 명시)
- 축소 사유는 `decisions.md`에 기록 (`Verification: reduced to 1 round (reason: ...)`)

#### 95% 합의와의 관계

- Pattern B의 95% 합의는 **한 라운드 내부의 agent 간 동의** 달성 방식
- Multi-Pass Verification은 **라운드 간의 focus 전환**
- 둘은 **직교**: Pattern B × 3-round = 각 라운드마다 95% 합의 달성 (최고 엄격)

---

## 10. Human Check 상세

### 10-1. 제시 자료

```
┌────────────────────────────────────────────────┐
│              Human Review Report              │
├────────────────────────────────────────────────┤
│ Feature  : <slug>                              │
│ Task     : <title>                             │
│ Mode     : <mode>                              │
│ Stages   : [완료 스킬 목록]                      │
│                                                │
│ Artifacts:                                     │
│   - Video : <path>                             │
│   - Log   : <path>                             │
│   - Diff  : <summary>                          │
│                                                │
│ Risks   : <## Risks 섹션>                       │
│ TDD     : <test_cycles 요약>                    │
│ E2E     : <surface + pass/fail>                │
└────────────────────────────────────────────────┘
```

(템플릿: `document/templates/report.md.md`)

### 10-2. 사용자 선택지

```
[1] rework   → 재작업 대상 명시 → active_feedback 생성 → target_skill 라우팅
[2] complete → Git 옵션
[3] hold     → status: blocked 기록
[4] upgrade  → 현재 모드가 부족 → 상위 모드로 전환
```

### 10-3. Git 옵션 (complete)

```
[a] 현재 브랜치 push
[b] 새 브랜치 push  (브랜치명 입력)
[c] 로컬 완료 (push 없음)
```

### 10-4. 마무리

`state.json` → `current_stage: done`, task md 체크박스 `[x]`, `session/YYYY-MM-DD.md` 로그.

---

## 11. Auto-Confirm Hook — 핵심 운영 메커니즘

> **원칙 1 (절대 정지 금지)의 실행 엔진**. 워크플로우가 완료되거나 사용자 stop 전까지 에이전트가 멈추지 않도록 강제한다.

### 11-1. Hook 동작 조건

매 `Stop` 이벤트마다 auto-confirm hook이 실행:

```
[Stop event 발생]
       │
       ▼
[state.json 읽기: current_stage, events, active_feedback, test_cycles]
       │
       ▼
[에이전트 마지막 응답 텍스트 분석]
       │
       ▼
[종합 판단: 아래 결정 트리]
       │
       ▼
[다음 행동 결정 → 프롬프트 주입] ──▶ 새 서브에이전트 진입
```

### 11-2. 결정 트리

| 신호 조합 | 다음 동작 |
|---------|----------|
| `events[-1].result == pass` + `current_stage` 완료 | **다음 workflow 스킬 자동 진입** |
| `events[-1].result == fail` | **Producer chain 라우팅** |
| `active_feedback`에 `resolved: false` 있음 | **target_skill 재진입** |
| 응답에 리스크/TODO/미해결 항목 언급 | **sub-tasker 호출 → 큐에 새 task 추가** |
| `test_cycles`에 RED 있으나 `workflow-coding` 미진입 | **workflow-coding 진입** |
| `current_stage == workflow-human-check && result == complete` | **세션 정리, `session/YYYY-MM-DD.md` 기록** |
| `mode_upgrade` 요청 감지 | 사용자 입력 대기 (유일 정지) |

### 11-3. 리스크 자동 태스크화 (Sub-tasker 패턴)

에이전트 응답에 다음 키워드/패턴이 감지되면 **자동으로 하위 task화**:

**트리거 키워드**:
- "리스크", "위험", "주의해야", "잠재적"
- "TODO", "나중에", "추후"
- "고려 필요", "검토 필요"
- "이상하지만", "임시로", "일단"

**동작**:
```
[키워드 감지]
       │
       ▼
[sub-tasker 서브에이전트 호출]
       │
       ▼
[응답 컨텍스트에서 리스크 내용 추출]
       │
       ▼
[새 task 파일 생성: .smt/features/<slug>/task/risk-<timestamp>.md]
       │
       ▼
[원 task의 state.json.sub_tasks에 id 추가]
       │
       ▼
[원 워크플로우 계속 진행]
```

**의미**: 에이전트가 "리스크 있다"고 말하고 끝내는 것을 금지. 언급한 모든 미해결 항목은 **자동으로 큐에 올라간다**. 원칙 2(회피 금지)의 기술적 구현.

### 11-4. 멈춤 허용 조건 (유일)

다음 경우에만 auto-confirm hook이 세션 정지를 **허용**한다:

1. **사용자 명시적 stop**: `/cancel`, `/stop`, 또는 사용자의 직접 정지 지시
2. **`workflow-human-check` 진행 중**: 사용자 입력 대기
3. **Mode upgrade 제안**: 사용자 결정 대기
4. **`workflow-investigate` 모드의 자연 종료**: 사용자가 다음 모드 선택 대기

이 외에는 **무한히 전진**한다. 같은 실패가 반복되면 `events`에 동일 패턴이 누적되고, 사용자가 인지하여 개입한다.

### 11-5. 판단 근거의 우선순위

auto-confirm이 마지막 응답 텍스트를 해석할 때:

1. **`state.json` 내용** (정형 데이터) — 최우선
2. **Hook 검증 결과** (typecheck, test 등) — 객관
3. **에이전트 응답 텍스트 패턴** (리스크 키워드 등) — 보조 신호
4. **암시적 완료 선언은 무시** — 파일 검증 되지 않은 "완료했습니다" 금지 (원칙 5)

### 11-6. 설정

`~/.smt/config.json`:

```json
{
  "autoConfirm": true,
  "subTaskerOnRisk": true,
  "maxSessionHours": 24,
  "stopOnCostLimit": false
}
```

- `autoConfirm: false` → hook 비활성화 (디버그 용도)
- `subTaskerOnRisk: false` → 리스크 자동 태스크화 비활성화
- `maxSessionHours` → 안전 장치 (사용자가 수동 정지하지 못한 경우)

### 11-7. Stall Detection & 내부 해결 Cascade

> **Smelter 핵심 UX 원칙**: 사용자가 워크플로우를 **모니터링할 일을 최소화**한다. 정체(stall)는 세션 내부에서 자동 해결을 우선 시도하며, 최후에만 사용자를 부른다.

#### Stall 감지 신호 (auto-confirm hook이 주기적으로 검사)

| 신호 | 임계값 |
|------|--------|
| 병렬 agent의 tool 무사용 | 5분 또는 10 tool call |
| 동일 `skill@fail` 연속 반복 | 3회 이상 |
| Sync point 대기 중 특정 agent만 미완료 | 타 agent 완료 후 3분 |
| `test_cycles`가 축적되어도 `run_result: pass` 없음 | 10회 이상 |
| `active_feedback` 미해결 누적 | 3개 이상 |
| `state.json.updated_at` 갱신 없음 | 10분 |

#### 내부 해결 Cascade (4 Level, 사용자 개입 없음)

```
[Stall 감지]
    │
    ▼
┌────────────────────────────────────────────────┐
│ Level 1: Debugger 서브에이전트                  │
│          (ReadOnly tools: Read, Grep, Glob)    │
│          현재 컨텍스트 분석 → 블로커 진단      │
│          → unblock 전략 제시 + state 주입       │
└──────────┬─────────────────────────────────────┘
           │ 해결 실패 (debugger가 "unblockable" 반환)
           ▼
┌────────────────────────────────────────────────┐
│ Level 2: Producer Chain 재라우팅                │
│          현 스킬 포기 → 상류 producer로 복귀    │
│          state.json.events에 stall_cascade     │
│          엔트리 append                          │
└──────────┬─────────────────────────────────────┘
           │ 해결 실패 (상류 재실행 후에도 동일 stall)
           ▼
┌────────────────────────────────────────────────┐
│ Level 3: Sub-tasker로 블로커 분리               │
│          블로커를 새 task로 추출                │
│          현 task는 `status: blocked` 대기       │
│          새 task가 해결되면 current_stage 복귀   │
└──────────┬─────────────────────────────────────┘
           │ 해결 실패 (sub-task도 stall)
           ▼
┌────────────────────────────────────────────────┐
│ Level 4: Mode Upgrade 자동 제안                 │
│          현 모드 범위 초과 판단 → 상위 모드 제시 │
│          → 사용자 결정 대기 (유일한 사용자 진입) │
└────────────────────────────────────────────────┘
           │ 사용자 거부 또는 mode 내 불가능
           ▼
      [사용자 알림]   ← 최후, 치명적 시스템 오류 포함
```

**Level 1~3**: 사용자 개입 **없이** 진행. 자동 전진.
**Level 4**: 사용자 결정 필요 (Iron Law #1의 유일 예외 경로).

#### 구현 세부

- 각 Level에서 최대 **2회 시도** 후 다음 Level로
- Level 2 진입 시 stall 타이머 **리셋 금지** (무한 cascade 방지)
- Level 3의 sub-task는 독립 state.json 생성. 해결 후 원 task `status: in_progress` 자동 복구
- Cascade 전 과정은 `events`에 `cause: stall_cascade, evidence.level: 1|2|3|4`로 기록

#### Debugger 서브에이전트 역할

ReadOnly tool만 사용. 진단 출력:

```json
{
  "stall_signal": "parallel agent tool_inactive 5min",
  "diagnosis": "investigator-3 stuck on external doc fetch timeout",
  "unblock_strategy": "switch to offline source, redistribute scope",
  "resolvable_in_session": true
}
```

`resolvable_in_session: false` 반환 시 즉시 Level 2로 진행.

---

## 12. Team Agent Patterns & Agent Assignment

### 12-1. 5 Pattern Framework (공식 정의)

| ID | 이름 | 구조 | 대표 사용처 |
|----|------|------|-------------|
| A | **Specialist Assignment** | 1 skill = 1 agent | 단순·집중 작업, 기본값 |
| B | **Team Consensus** | N agents 투표 (95% 합의) | 판단·합의 필요 (team-code-review, tasker-review) |
| C | **Parallel Delegation** | N agents 병렬 + Aggregator | 독립 영역 병렬 (investigate, coding, write-test) |
| D | **Hierarchical** | Lead + 하위 agents | 복잡 설계·이념 다양성 (tasker, brainstorm) |
| E | **Adversarial Watchdog** | 백그라운드 critic | Iron Law 실시간 감시 (coding 중) |

### 12-2. 패턴 정의 위치 (중요)

패턴은 **세 레이어에서 선언**된다. 각 레이어의 책임이 분리되어 있다.

| 레이어 | 소유 | 역할 |
|--------|------|------|
| **`SKILL.md`** (템플릿) | 스킬 | 기본 패턴·aggregator·sync 전략·규칙 |
| **`workflow-tasker` 산출물** (override) | tasker | 복잡도·영역 signal 기반 오버라이드 |
| **`state.json.team_runtime`** (인스턴스) | 런타임 | 실제 할당된 agent ID·현재 상태·산출물 경로 |

> **원칙**: 패턴은 스킬이 알고, tasker가 재단하고, state가 기록한다.

#### SKILL.md 예시 (`skills/workflow-investigate/SKILL.md`)

```yaml
---
name: workflow-investigate
default_pattern: A                       # 기본은 single agent
default_agent: explore-medium
supports_patterns: [A, C]                # parallel로도 승격 가능
team_template:
  C:
    parallel_split_by: area              # 분할 기준
    agents: [explore-medium]             # 반복 사용
    aggregator: architect
    conflict_resolver: conflict-resolver
    sync_point: "investigation.md merge"
---
```

#### state.json 예시 (런타임 인스턴스)

```json
"team_runtime": {
  "workflow-investigate": {
    "pattern": "C",
    "assigned_agents": [
      { "id": "agent-1", "agent_type": "explore-medium", "area": "database", "status": "done" },
      { "id": "agent-2", "agent_type": "explore-medium", "area": "api", "status": "done" },
      { "id": "agent-3", "agent_type": "explore-medium", "area": "ui", "status": "in_progress" }
    ],
    "aggregator": "architect",
    "sync_point_reached": false,
    "aggregation_result": null,
    "conflicts": []
  }
}
```

### 12-3. Pattern A — Specialist Assignment (기본)

단일 에이전트가 스킬 전체를 수행. `SKILL.md`의 `default_agent` 또는 tasker 오버라이드.

```
┌─────────────────┐
│ workflow-skill  │ ─▶ [specialist agent] ─▶ 산출물
└─────────────────┘
```

복잡도가 낮거나 분할 이점이 없는 스킬 기본값.

### 12-4. Pattern B — Team Consensus (95% 합의)

N명 에이전트가 **같은 대상**을 독립 검토 → 투표 → 합의 도달까지 라운드 반복.

```
        ┌──────────────┐
        │   advocate   │──┐
        └──────────────┘  │
        ┌──────────────┐  │   ┌─────────────┐   ┌──────────┐
        │    critic    │──┼──▶│ arbitrator  │──▶│ ≥95% 합의 │
        └──────────────┘  │   └─────────────┘   └──────────┘
        ┌──────────────┐  │        │ No
        │  (optional)  │──┘        ▼
        └──────────────┘      다음 라운드
```

사용처: `workflow-team-code-review` (기본), `workflow-tasker-review` (side-effect 검토 시 승격).

### 12-5. Pattern C — Parallel Delegation (신규)

독립 영역을 N agent에 분배 → 각자 실행 → sync point에서 Aggregator가 통합.

```
┌──────────────────┐
│ workflow-tasker  │──▶ parallel split 선언 (영역 + agent 배분)
└────────┬─────────┘
         ▼
┌────────────────────────────────────────────────┐
│ N agents 병렬 실행                              │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐   │
│ │agent 1 │ │agent 2 │ │agent 3 │ │agent N │   │
│ │area A  │ │area B  │ │area C  │ │area ...│   │
│ └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘   │
└──────┼──────────┼──────────┼──────────┼───────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
┌────────────────────────────────────────────────┐
│  Sync Point (모두 완료 대기)                    │
└────────────────┬───────────────────────────────┘
                 ▼
        ┌────────────────────┐
        │    Aggregator      │  단일 산출물로 통합
        │   (architect 등)   │
        └──────────┬─────────┘
                   ▼
         ┌─────────────────────┐
         │ 충돌 감지?           │
         └────┬───────────┬────┘
              │ Yes       │ No
              ▼           ▼
      ┌────────────────┐  최종 산출물
      │ Conflict-      │
      │ Resolver       │  (섹션 12-7)
      └────────────────┘
```

#### 분할 기준 (`parallel_split_by`)

| 기준 | 적용 스킬 |
|------|----------|
| `area` | investigate (DB/API/UI/security), brainstorm (product/eng/design 페르소나) |
| `file` | write-test (파일당 1 agent), coding (독립 파일) |
| `module` | coding (frontend/backend/shared) |
| `persona` | brainstorm (viewpoint별) |

#### Sync Point 동작

- 모든 assigned_agents가 `status: done` 또는 `failed`이 될 때까지 aggregator는 대기
- 1명이 stall → 섹션 11-7 cascade 적용
- 부분 실패 시 aggregator가 "누락된 영역"을 명시하여 재실행 결정

### 12-6. Pattern D — Hierarchical (신규)

리드 에이전트가 방향을 정하고 하위 에이전트에게 위임. 결과는 리드가 통합 후 제출.

```
        ┌──────────────────┐
        │  Lead Agent      │  (architect / researcher-high)
        │  (방향 결정)      │
        └────────┬─────────┘
                 │ 위임
      ┌──────────┼──────────┐
      ▼          ▼          ▼
  ┌──────┐  ┌──────┐  ┌──────┐
  │ sub  │  │ sub  │  │ sub  │    하위 agents
  │agent │  │agent │  │agent │
  └──┬───┘  └──┬───┘  └──┬───┘
     │         │         │
     └─────────┼─────────┘
               ▼
        ┌──────────────────┐
        │  Lead 재통합      │
        └──────────────────┘
```

사용처:
- `workflow-tasker`: architect가 설계 방향 결정 → researcher가 선행 기술 조사 → executor가 구체 task 나열
- `workflow-brainstorm` (deep): 진행자가 주제 정리 → product/eng/design 페르소나가 관점 제시 → 진행자가 종합

Pattern C와의 차이: C는 **대칭 병렬**, D는 **리드 종속**. D는 리드의 판단이 우선.

### 12-7. Aggregator & Conflict-Resolver (충돌 병합 안전 장치)

#### Aggregator 역할

병렬 산출물을 단일 파일로 통합. 1차 중복·모순 정리.

| 스킬 | 기본 Aggregator |
|------|-----------------|
| workflow-investigate | `architect` (영역별 정리) |
| workflow-coding | `architect` + `code-reviewer` (통합 검토) |
| workflow-write-test | `executor` (파일별 병합) |
| workflow-brainstorm | 진행자 역할 `planner` |

#### Conflict-Resolver 역할 (신규, 충돌 병합 실패 안전 장치)

Aggregator가 **병합 실패**를 선언하면 호출되는 전용 에이전트.

**Aggregator의 실패 선언 조건**:
- 같은 파일에 서로 다른 agent가 양립 불가한 변경
- 같은 API 시그니처에 다른 정의 제안
- 논리적으로 모순되는 결론 (예: investigate에서 "A는 안전" vs "A는 위험")
- 자동 머지 도구가 해결하지 못한 텍스트 충돌

**Conflict-Resolver 동작**:

```
[Aggregator 병합 실패 신호]
    │
    ▼
┌──────────────────────────────────────┐
│ Conflict-Resolver 에이전트           │
│                                       │
│ 1. 충돌 원인 분석 (원 에이전트들의     │
│    근거·선택지 수집)                  │
│ 2. 결정 근거 명시 (trade-off 표)      │
│ 3. 수정안 작성 (통합 산출물 제안)     │
│ 4. state.json.team_runtime.conflicts  │
│    에 기록                            │
└──────────┬───────────────────────────┘
           │
   ┌───────┴─────────┐
   ▼                 ▼
해결 성공         해결 실패
   │                 │
   ▼                 ▼
통합 산출물 확정    Sub-tasker 호출
                    "충돌 해결" task 생성
                    순차 재실행으로 fallback
                         │
                         ▼
                    Sub-task도 실패
                         │
                         ▼
                    섹션 11-7 Level 4
                    사용자 결정 대기
```

**Conflict-Resolver의 권한**:
- 원 에이전트 산출물 읽기 전용
- 최종 통합 파일 쓰기 권한
- `state.json.events`에 `conflict_resolved` 이벤트 기록
- **자기 해결 불가 선언 가능** (예외: 원칙 3과 무관. resolver는 기술적 판정자, 회피가 아님)

**Conflict-Resolver는 기본 전용 agent**로 정의: `agents/conflict-resolver.md`. code-reviewer와 architect의 판단을 합친 성격.

### 12-8. Pattern E — Adversarial Watchdog (Critic Watchdog)

> Iron Law 위반을 **실시간 감시**하는 백그라운드 critic.

#### 구현 가능성 (솔직 평가)

| 접근 | 가능성 | 이유 |
|------|--------|------|
| Hook 기반 즉각 감시 (PostToolUse) | ✅ **완전 가능** | Claude Code hook API 제공, 정형 규칙 체크 적합 |
| 주기적 agent-critic (polling) | ⚠️ **근사 실시간** | Agent tool 호출 기반이므로 완전 스트리밍 아님, 5~10 tool call마다 호출로 근사 |
| 연속 백그라운드 스트리밍 감시 | ❌ **현 SDK 제약** | Claude Code에 continuous observer 패턴 없음 |

**채택 구조**: Hook Layer 1 + 주기적 Agent Layer 2 **2중 방어**.

#### Layer 1 — Hook-Based Mini-Critic

- 스크립트: `scripts/critic-watchdog.mjs`
- 트리거: `PostToolUse` on `Edit`, `Write`, `Bash` (git/rm 관련)
- 실행: 정형 규칙 10개를 **동시 체크** (경량, 밀리초 수준)
- 위반 감지 시: `state.json.events`에 `skill: critic-watchdog, result: fail` append → auto-confirm이 producer 라우팅

#### Layer 2 — Periodic Agent-Critic

- `workflow-coding` 진행 중에만 활성
- 매 5~10 tool call 마다 critic agent 호출 (ReadOnly tools)
- 담당: **의미적 위반 감지** (scope 이탈, 회피 패턴, 논리적 규칙 위반)
- 발견 시: `active_feedback` 추가 + `target_skill` 재진입 지시

#### 감시 룰 (초기 10개, Hook Layer)

| # | 룰 | 감지 방식 | 심각도 |
|---|------|----------|--------|
| 1 | 테스트 파일 삭제 금지 | git diff에 `*.test.*` 삭제 | CRITICAL |
| 2 | `--no-verify` / `--force` 사용 금지 | Bash args 스캔 | CRITICAL |
| 3 | `.env`·secrets 파일 접근 금지 | Edit/Read 대상 경로 매칭 | CRITICAL |
| 4 | `active_feedback` resolved:false인 상태로 완료 선언 금지 | state.json 검사 | CRITICAL |
| 5 | `test_cycles`에 RED 없이 workflow-coding 진입 금지 | TDD cycle 검증 | CRITICAL |
| 6 | `allowed_skills` 외 `workflow-*` 호출 금지 | 스킬 dispatch 시 whitelist | CRITICAL |
| 7 | Scope 이탈 (plan.md Queue 밖 파일 수정) | 수정 파일 vs Queue 매칭 | HIGH |
| 8 | 회피 패턴 (fallback `??` 남발, TODO로 우회) | 코드 패턴 스캔 | HIGH |
| 9 | 병렬 agent 간 동일 파일 동시 수정 | team_runtime 상태 vs git diff | HIGH |
| 10 | `session/YYYY-MM-DD.md` 기록 없이 complete 전환 | state → log 매칭 | MEDIUM |

#### 위반 시 동작

| 심각도 | 동작 |
|--------|------|
| CRITICAL (1~6) | 즉시 **해당 tool 호출 차단** (hook exit 2) + 변경 revert + producer 라우팅 |
| HIGH (7~9) | `active_feedback` 추가 + 다음 skill에서 확인 강제 |
| MEDIUM (10) | 경고 기록, 계속 진행 |

#### 구현 제약

- Hook 스크립트는 **ReadOnly 접근**만 사용 (state.json은 append-only)
- Agent-critic은 **ReadOnly tools만** (Read, Grep, Glob, Bash read-only)
- False positive 관리: 각 룰에 `confidence` 필드, 임계값 미만은 경고만

### 12-9. Per-Skill Pattern Matrix

| Skill | Primary Pattern | Fallback | Aggregator | 비고 |
|-------|-----------------|----------|-----------|------|
| `workflow-brainstorm` (deep) | D Hierarchical (진행자 + 3 personas) | A single | planner | Planning mode |
| `workflow-brainstorm` (light) | A Specialist | — | — | Implement mode |
| `workflow-brainstorm-review` | B Adversarial (critic only) | A single | — | critic만, advocate 불필요 |
| `workflow-investigate` | C Parallel (area별) | A single (explore-medium) | architect | 가장 큰 이득 |
| `workflow-investigate-review` | A Single (explore-high) | — | — | 통합 산출 리뷰 |
| `workflow-tasker` | D Hierarchical (architect 리드) | A architect 단독 | architect | 설계 주도 |
| `workflow-tasker-review` | B Team Consensus (95%) | A single | arbitrator | side-effect 다각 검토 |
| `workflow-write-test` | C Parallel (file별) | A executor | executor | 독립 파일 병렬 |
| `workflow-coding` | C Parallel (module별) + E Watchdog | A executor + E Watchdog | architect + code-reviewer | watchdog은 모든 경우 활성 |
| `workflow-agent-review` | B Dual Adversarial (code-reviewer + security-reviewer) | A code-reviewer | arbitrator | "no security surface" 선언 시 A |
| `workflow-e2e` | A Specialist (qa-tester) | — | — | 도메인 집중 |
| `workflow-e2e-review` | A Single | — | — | 산출물 검토 |
| `workflow-team-code-review` | B Team Consensus 95% | — | arbitrator | advocate + critic + arbitrator |
| `workflow-human-check` | User | — | — | N/A |

**tasker가 matrix 오버라이드 가능**. 예: "단순 버그 fix이니 investigate도 A로" 선언 → 기본 C를 우회.

### 12-10. 세션 간 공유

| 요소 | 정책 |
|------|------|
| Queue (체크박스) | **독립** (task별) |
| State (state.json) | **독립** (task별) |
| Session (세션 컨텍스트) | **공유 허용** (한 세션에 여러 task) |
| Specialist agent | tasker가 skill별 할당 |
| Team Agent | 5 패턴(A/B/C/D/E) 전역 지원 |
| Conflict Resolver | 별도 전용 agent |
| Critic Watchdog | Hook Layer 1 + Agent Layer 2 |

**주의**:
- 토큰 효율 목적으로는 task 전환 시 새 서브에이전트 할당이 권장됨.
- 공유가 유리한 경우: 같은 feature 내 연관 task 연속 진행, 같은 specialist가 여러 task 처리.
- 공유가 불리한 경우: 독립 feature 간 교차, 긴 컨텍스트로 잡음 증가.

---

## 13. 전체 모드 그래프 (통합)

```
                                ╭──────────────────╮
                                │ 자연어 입력 or   │
                                │   명시 Command    │
                                ╰──────────────────╯
                                         │
                                         ▼
                                ╭──────────────────╮
                                │ 자동 분기 엔진    │
                                │ (패턴 매칭)       │
                                ╰──────────────────╯
                                         │
       ┌──────────┬──────────┬───────────┼──────────┬─────────────┐
       ▼          ▼          ▼           ▼          ▼             ▼
  simple_fix    fix    investigate    plan    implement     (override:
                                                             명시 command)
       │          │          │           │          │
       │          │          │           │          │
       │          ▼          ▼           ▼          ▼
       │      ╭──────────────────────────────────────────╮
       │      │         SHARED PIPELINE (workflow-*)     │
       │      │                                           │
       │      │  brainstorm ◀──▶ investigate             │
       │      │       │                │                  │
       │      │       ▼                ▼                  │
       │      │  brainstorm-review  investigate-review   │
       │      │                        │                  │
       │      │                        ▼                  │
       │      │  tasker ──▶ tasker-review                │
       │      │                        │                  │
       │      │                        ▼                  │
       │      │  write-test ──▶ coding                   │
       │      │                        │                  │
       │      │                        ▼                  │
       │      │  agent-review ──▶ e2e                    │
       │      │                        │                  │
       │      │                        ▼                  │
       │      │  e2e-review ──▶ team-code-review         │
       │      │                        │                  │
       │      │                        ▼                  │
       │      │                  human-check              │
       │      ╰──────────────────┬────────────────────────╯
       │                         │
       │                         ▼
       └──────────▶        ╭───────────────╮
                           │workflow-coding│
                           ╰───────────────╯
                                   │
                                   ▼
                        workflow-e2e → workflow-human-check
                        (simple_fix 경로)

               [utility skills 는 어디서든 자유 호출]
```

각 모드는 이 파이프라인의 **부분집합**을 `allowed_skills`로 선언.

---

## 14. Context Isolation & Scoped Testing

### 14-1. Queue 독립 (유지)

```
plan.md:
  - [ ] Task A  →  독립 queue + independent state.json
  - [ ] Task B  →  독립 queue + independent state.json
  - [ ] Task C  →  독립 queue + independent state.json
```

각 task의 checkbox tree와 state는 서로 간섭하지 않는다.

### 14-2. Session 공유

같은 세션에서 여러 task 진행 가능:
- Specialist agent 할당으로 전문성 유지
- Task 간 전환 시 auto-confirm hook이 `state.json` 기준으로 컨텍스트 재구성

### 14-3. Scoped Testing

```bash
# 변경 파일 식별
git diff --name-only

# 관련 테스트만
pnpm vitest run <changed_test_files>
npx playwright test <changed_specs>

# ❌ 금지 (workflow-human-check 전까지)
pnpm test          # 전체
npx playwright test # 전체
```

전체 회귀는 `workflow-human-check` 시 사용자 요청 또는 명시적 옵션으로만.

---

## 15. Rules Injection
`rules-lib/<lang>/*.md`는 파일 확장자 기반으로 `PreToolUse` 훅에서 주입.

| Tag | 의미 |
|-----|------|
| `[Inject: rules-lib/typescript]` | .ts/.tsx 편집 시 |
| `[Inject: rules-lib/python]` | .py 편집 시 |

각 workflow 스킬에 추가로 자체 rules가 주입될 수 있음 (예: `workflow-coding`은 `common/coding-style.md`).

---

## 16. 출력 규칙 (REQUIRED OUTPUT FORMAT)

각 workflow 스킬 진입 시 영어 헤더:

```
--- Skill: workflow-coding (mode: fix, agent: executor) ---
Goal: Apply RED → GREEN for validator.test.ts bug #123
```

**규칙**:
- 영어만
- workflow 스킬 전환 시 반드시 헤더 출력
- `agent: <assigned>` 포함 (team_runtime 참조)
- Goal 1줄

---

## 17. 파일 구조

```
.smt/features/<slug>/
├── task/
│   ├── plan.md
│   ├── <task>.md                    ← 사람이 읽는 작업 기록
│   └── <task>.state.json            ← 기계 상태 (단일 출처)
├── decisions.md
└── artifacts/
    ├── e2e-video.webm
    ├── screenshots/
    └── logs/

skills/
├── workflow-brainstorm/SKILL.md
├── workflow-brainstorm-review/SKILL.md
├── workflow-investigate/SKILL.md
├── workflow-investigate-review/SKILL.md
├── workflow-tasker/SKILL.md
├── workflow-tasker-review/SKILL.md
├── workflow-write-test/SKILL.md
├── workflow-coding/SKILL.md
├── workflow-agent-review/SKILL.md
├── workflow-e2e/SKILL.md
├── workflow-e2e-review/SKILL.md
├── workflow-team-code-review/SKILL.md
├── workflow-human-check/SKILL.md
├── (utility skills, prefix 없음)
│   ├── ui-ux-pro-max/SKILL.md
│   ├── copywriting/SKILL.md
│   └── ...
modes/
├── simple_fix.json
├── fix.json
├── investigate.json
├── plan.json
└── implement.json

commands/
├── simple-fix.md
├── fix.md
├── investigate.md
├── plan.md
└── implement.md

scripts/
├── auto-confirm.mjs       ← 섹션 11 Stop hook (queue-drop)
├── auto-confirm-consumer.mjs ← UserPromptSubmit consumer (queue 소비)
├── state-schema.mjs       ← state.json 스키마 + 검증 (섹션 2)
├── mode-classifier.mjs    ← 자동 분기 엔진 (섹션 1-2)
├── route-on-fail.mjs      ← Producer chain 라우터 (섹션 5-1)
├── stall-detector.mjs     ← Stall 6 신호 감지 (섹션 11-7)
├── critic-watchdog.mjs    ← Hook Layer 1 감시 10규칙 (섹션 12-8)
├── parallel-dispatcher.mjs ← Pattern A/B/C/D dispatch
├── feature-version-check.mjs ← `.smt/features/*` 상태 무결성 점검
└── rule-injector.mjs      ← rules-lib 주입

templates/verification/
├── round-1-omission.md    ← 누락 focus 프롬프트 (섹션 9-3)
├── round-2-contradiction.md ← 모순 focus 프롬프트
└── round-3-edge-case.md   ← 엣지 케이스 focus 프롬프트

agents/
├── debugger.md            ← Stall Cascade Level 1 (섹션 11-7)
├── aggregator.md          ← 병렬 산출물 통합 (섹션 12-7)
├── conflict-resolver.md   ← 병합 실패 안전 장치 (섹션 12-7)
├── critic.md              ← Watchdog Agent Layer 2 (섹션 12-8)
├── advocate.md            ← Pattern B 합의 역할
├── critic-b.md            ← Pattern B 합의 역할
├── arbitrator.md          ← Pattern B 합의 역할
└── (기타 specialist: executor, code-reviewer, security-reviewer, qa-tester, architect, explore-*, researcher, ...)
```

### 17-1. Mode 정의 예시 (`modes/fix.json`)

```json
{
  "mode": "fix",
  "entry_skill": "workflow-investigate",
  "allowed_skills": [
    "workflow-investigate", "workflow-investigate-review",
    "workflow-tasker", "workflow-tasker-review",
    "workflow-write-test", "workflow-coding",
    "workflow-agent-review",
    "workflow-e2e", "workflow-e2e-review",
    "workflow-team-code-review", "workflow-human-check"
  ],
  "default_team_overrides": {
    "workflow-coding":        { "pattern": "A", "default_agent": "executor" },
    "workflow-agent-review":  { "pattern": "A", "default_agent": "code-reviewer" },
    "workflow-e2e":           { "pattern": "A", "default_agent": "qa-tester" }
  },
  "magic_keywords": {
    "style": { "set": "exempt.tdd=true, exempt.e2e=false" },
    "i18n":  { "set": "exempt.tdd=true, exempt.e2e=false" },
    "typo":  { "set": "exempt.tdd=true, exempt.e2e=true" }
  },
  "transitions": {
    "upgrade_to": ["implement", "plan"],
    "downgrade_to": ["simple_fix"]
  }
}
```

---

## 18. 관련 문서

- 스킬 정의: `skills/workflow-<name>/SKILL.md`
- 유틸리티 스킬: `skills/<name>/SKILL.md` (접두사 없음)
- 모드 정의: `modes/<mode>.json`
- 커맨드: `commands/<command>.md`
- 템플릿: `document/templates/task.md.md`, `report.md.md`, `plan.md.md`
- Auto-confirm 구현: `scripts/auto-confirm.mjs` + `scripts/auto-confirm-consumer.mjs`
- 구현 현황: `document/implementation.md`

---

## Appendix A — 스킬 간 Producer Chain (전체)

```
                         ┌──────────────────────┐
                         │ workflow-brainstorm  │
                         └──────────┬───────────┘
                                    ▼
                 ┌─────────────────────────────────────┐
                 │   workflow-brainstorm-review        │
                 └──────────┬──────────────────────────┘
                            │                 ▲ reshape
                            ▼                 │
                 ┌──────────────────────┐     │
                 │ workflow-investigate │◀────┘
                 └──────────┬───────────┘
                            ▼
                 ┌────────────────────────────────┐
                 │  workflow-investigate-review   │
                 └──────────┬─────────────────────┘
                            │         ▲ reshape
                            ▼         │
                   ┌─────────────────┴┐
                   │ workflow-tasker  │
                   └────────┬─────────┘
                            ▼
                 ┌─────────────────────────┐
                 │ workflow-tasker-review  │
                 └──────────┬──────────────┘
                            │         ▲ reshape
                            ▼         │
                 ┌──────────────────────┐
                 │ workflow-write-test  │
                 └──────────┬───────────┘
                            ▼
                 ┌──────────────────────┐
                 │  workflow-coding     │◀──┐
                 └──────────┬───────────┘   │
                            ▼               │
                 ┌──────────────────────┐   │
                 │ workflow-agent-review│───┤ fail
                 └──────────┬───────────┘   │
                            ▼               │
                 ┌──────────────────────┐   │
                 │   workflow-e2e       │───┤
                 └──────────┬───────────┘   │
                            ▼               │
                 ┌──────────────────────┐   │
                 │ workflow-e2e-review  │───┤
                 └──────────┬───────────┘   │
                            ▼               │
                 ┌─────────────────────────┐│
                 │workflow-team-code-review│┤ fail (medium/low)
                 └──────────┬──────────────┘│
                            ▼               │
                 ┌──────────────────────────┐│
                 │  workflow-human-check    │┤ rework (default)
                 └──────────┬───────────────┘│
                            │                │
                            ▼                │
                         complete            │
                                             │
                  (fail: 모든 경로)          ▼
                                    (producer 또는
                                     active_feedback.target)
```

---

## Appendix B — 결정 사항 요약

| 항목 | 결정 |
|------|------|
| 스킬 접두사 | `workflow-*` (mode whitelist 대상) vs utility (자유 사용) |
| 라우팅 | Producer chain 기반 |
| 재시도 | 없음 (원칙 4) |
| 자기 페일 | 금지 (원칙 3) |
| Cause enum | 고정 (섹션 6-3) |
| Declarer | hook > user > (skill 금지) |
| Mode 업그레이드 | 모두 허용, 사용자 결정 |
| brainstorm ↔ investigate | 양방향 (reshape edge) |
| Implement의 brainstorm | `depth: light` 파라미터로 공유 |
| 명확/불명확 Fix 분기 | **자동 분기 우선** (패턴 매칭), `/simple-fix`·`/fix` 커맨드는 override |
| State 저장소 | `<task>.state.json` (JSON, task 단위) |
| 이벤트 히스토리 컨텍스트 | 최근 5개 |
| TDD 검증 | `test_cycles`에 RED 엔트리 강제 |
| 피드백 | `active_feedback` 누적, resolved 플래그 |
| Session 격리 | **완화** — Queue 독립, session 공유 허용 |
| Specialist agent | tasker가 할당, SKILL.md에 기본값 |
| Team Agent 패턴 | **5개 공식화** (A Specialist / B Consensus / C Parallel / D Hierarchical / E Watchdog) |
| 패턴 정의 위치 | **SKILL.md (템플릿)** + tasker (override) + state.json (런타임 인스턴스) |
| Parallel Delegation (C) | investigate(area), coding(module), write-test(file), brainstorm(persona) |
| Hierarchical (D) | tasker(architect 리드), brainstorm-deep(진행자 + 페르소나) |
| Aggregator | 병렬 산출물 통합 전담 (architect/executor/planner) |
| **Conflict-Resolver** | 신규 전용 agent. Aggregator 실패 시 호출. sub-tasker fallback. |
| **Critic Watchdog (E)** | Hook Layer 1 (정형 10규칙, 즉각 차단) + Agent Layer 2 (의미 검증, 주기적) |
| 연속 스트리밍 감시 | 불가 (SDK 제약). 주기적 polling으로 근사. |
| **Stall Detection** | Auto-confirm hook 주기 검사. 6개 신호. |
| **내부 해결 Cascade** | 4 Level (Debugger → Producer 재라우팅 → Sub-tasker → Mode Upgrade). Level 1-3은 사용자 개입 없음. |
| 사용자 알림 조건 | 최후. Cascade Level 4 거부 시 또는 치명적 시스템 오류. |
| Auto-confirm hook | 섹션 11 — 무한 전진, 리스크 자동 태스크화, stall cascade |
| **Multi-Pass Verification** | 모든 review 스킬 **3 라운드 강제** (누락/모순/엣지). tasker가 축소 가능 (1 round). 회피 방지 4 장치. |
| 유틸리티 스킬 | whitelist 밖, 자유 사용 |

---

## Appendix C — 구현 로드맵 (순차, 누락 없이)

| # | 항목 | 의존 | 비고 |
|---|------|------|------|
| 1 | `state.json` 스키마 v2 정의 | 없음 | 모든 hook이 읽는 단일 출처 |
| 2 | Mode classifier 엔진 (`scripts/mode-classifier.mjs`) | 1 | 자연어 → mode 자동 분기 |
| 3 | Mode 정의 파일 (`modes/*.json`) | 1 | 5개 mode + allowed_skills |
| 4 | 13개 `skills/workflow-*/SKILL.md` 작성 | 1 | contract + 기본 패턴 선언 |
| 5 | Producer chain 라우터 (`scripts/route-on-fail.mjs`) | 1, 4 | fail 이벤트 → producer lookup |
| 6 | Auto-confirm hook v2 (`scripts/auto-confirm.mjs`) | 1, 5 | 결정 트리 + 리스크 sub-tasker |
| 7 | Stall detection (11-7) | 6 | 6개 신호 + 4-Level cascade |
| 8 | Pattern C: Parallel Delegation | 4, 6 | investigate 먼저 (가장 큰 이득) |
| 9 | Aggregator (`agents/aggregator.md`) | 8 | architect 기반, 병합 1차 |
| 10 | Conflict-Resolver (`agents/conflict-resolver.md`) | 9 | 병합 실패 안전 장치 |
| 11 | Pattern B: Dual Adversarial for agent-review | 4 | code-reviewer + security-reviewer |
| 12 | Critic Watchdog Hook Layer 1 (`scripts/critic-watchdog.mjs`) | 1, 6 | 10 규칙 즉각 차단 |
| 13 | Critic Watchdog Agent Layer 2 | 12 | 주기 호출 (5-10 tool call) |
| 14 | Pattern D: Hierarchical for tasker/brainstorm | 4 | architect 리드 구조 |
| 15 | **Multi-Pass Verification 엔진** (`scripts/verification-rounds.mjs`) | 4, 6 | 3-round 강제, round별 agent 교체, completed_rounds gate |
| 16 | **Round-focus 프롬프트 템플릿** (`templates/verification/round-{1,2,3}.md`) | 15 | 누락/모순/엣지 각각의 focus 프롬프트 |
| 17 | Feature state 무결성 점검 유틸 | 1 | `feature-version-check.mjs` |

**실행 순서 보장**: 각 단계는 이전 의존성이 완결된 후 진행. 누락 시 전체 시스템 무결성 붕괴.

---

**End of workflow.md**
