---
title: Smelter Implementation Blueprint
type: canonical
tags: [smelter, implementation, architecture, hooks, workflow]
created: 2026-04-13
updated: 2026-04-15
---

# Smelter Implementation Blueprint

> workflow.md의 10단계 워크플로우를 구현하기 위한 설계서.
> 이 문서는 각 단계가 어떤 코드/훅/에이전트/파일에 의해 구현되는지를 정의한다.
> 이 파일이 수정되면 index, workflow 파일 모두 함께 수정되어야 한다.

---

## 1. Architecture Overview

### 실행 모델

Smelter의 10단계 워크플로우는 **프롬프트 기반 아키텍처 + 훅 가드레일**로 구현된다.

```
사용자 입력
  → keyword-detector.mjs (UserPromptSubmit)
    → Skill Tool → commands/*.md (프롬프트 주입)
      → Claude가 단계별 지시 수행
        → hooks가 런타임 제약 강제
          → .smelter/ 파일이 진행 상태 추적
```

**핵심 설계 결정**: 단계 전환은 코드 레벨 상태 머신이 아닌 **프롬프트 지시**로 구현한다.

- 워크플로우 엔진 = Claude 자체 (commands/*.md의 지시를 따름)
- Hooks = 가드레일 (TDD 강제, E2E 리마인더, 자동 계속, 재시도)
- .smelter/ = 영속 상태 (파일 기반)
- Commands = 어떤 단계를 실행할지 정의
- Presets = 메타데이터 (단계 범위, E2E 여부, 최소 테스트 수)

### Layer Stack

| Layer | 위치 | 역할 |
|-------|------|------|
| **Entry** | `scripts/keyword-detector.mjs` | 슬래시 커맨드/매직 키워드 감지 → Skill 호출 |
| **Command** | `commands/*.md` | 단계별 실행 지시 (프롬프트) |
| **Preset** | `presets/*.json` | 실행 메타데이터 (단계 범위, E2E, 최소 테스트) |
| **Hook** | `hooks/hooks.json` + `scripts/*.mjs` | 런타임 가드레일 |
| **State** | `.smelter/` | 파일 기반 진행 상태 |
| **Agent** | `agents/*.md` | 역할별 서브에이전트 정의 |

---

## 2. Entry — 커맨드 진입 시스템

### 진입 흐름

```
사용자: "/work add dark mode"
  ↓
keyword-detector.mjs (UserPromptSubmit)
  ├─ (1) 슬래시 커맨드 감지: /work → command=work
  ├─ (2) 또는 매직 키워드 감지 (Haiku classifier): "new feature" → command=work
  ├─ activateHarnessState() → .smelter/state/ 기록
  ├─ [WORK MODE] 태그 출력
  └─ additionalContext: "Skill: work" 주입 → Skill Tool이 commands/work.md 로드
```

### 커맨드-프리셋 매핑

| 커맨드 | 프리셋 | 단계 범위 | E2E | 최소 테스트 |
|--------|--------|-----------|-----|-----------|
| `/tasker` | `tasker` | 1–3 | — | 0 |
| `/work` | `work` | 1–10 | required | 10+ |
| `/default` | `default` | 4–10 | surface-based | 5+ |
| `/ralph` | `ralph` | per-task | per-task | per-task |

### 매직 키워드 매핑

| 키워드 | 커맨드 | 분기 힌트 |
|--------|--------|----------|
| `tasker`, `plan`, `설계해줘`, `계획부터` | `/tasker` | — |
| `new feature`, `새 기능`, `design first` | `/work` | Step 2 포함 |
| `extend`, `add to`, `덧붙여`, `확장해줘` | `/work` | Step 2 건너뜀 |
| `fix`, `bug`, `버그`, `고쳐` | `/default` | E2E 강제 |
| `style`, `typo`, `텍스트`, `색상`, `i18n`, `문구` | `/default` | TDD 면제 |
| `ralph`, `keep going`, `끝까지` | `/ralph` | — |
| `cancel`, `stop` | `/cancel` | — |

### 구현 파일

| 파일 | 역할 |
|------|------|
| `scripts/keyword-detector.mjs` | 슬래시 커맨드 + Haiku classifier 기반 매직 키워드 감지 |
| `scripts/lib/subagent-classifier.mjs` | Haiku 서브에이전트 프롬프트 분류 |
| `scripts/lib/cancel-signal.mjs` | /cancel, /queue 시그널 관리 |
| `scripts/cancel-propagator.mjs` | 취소 시그널 전파 |

---

## 3. 10단계 워크플로우 구현 상세

> 각 단계는 **트리거 / 수행 주체 / 참여 훅 / 참여 에이전트 / 상태 파일 / 산출물**로 정의한다.

---

### Step 1 — Problem Recognition (문제 인식)

> 커맨드: `/tasker` (핵심), `/work` (plan 없을 때 자동 수행)

| 항목 | 구현 |
|------|------|
| **트리거** | `/tasker` → `commands/tasker.md` / `/work` → `commands/work.md` (plan 부재 시) |
| **수행 주체** | Claude (프롬프트 지시) |
| **참여 훅** | 없음 |
| **참여 에이전트** | `explore` (코드베이스 조사 시) |
| **읽는 파일** | `.smelter/index.md`, `features/*/task/_overview.md` |
| **쓰는 파일** | `features/<slug>/task/_overview.md`, `features/<slug>/task/<task-name>.md` |
| **산출물** | Feature 디렉토리 + _overview.md + task 파일 (초안) |

**구현 메커니즘**: `commands/tasker.md`가 Claude에게 지시:
1. 프로젝트 루트 탐색 (`package.json`, `.git` 등)
2. 기존 planning state 확인 (`index.md` 존재 여부)
3. 문제/기능 요청 캡처
4. Feature 디렉토리 생성 + 파일 초기화

**`/work` 자동 수행**: `commands/work.md`가 Step 1에서 `.smelter/features/*/task/` 확인 → 매칭 task 없으면 간략 Step 1 실행 후 진행.

---

### Step 2 — Pre Review (기획 검토)

> 커맨드: `/tasker` (핵심), `/work` ("extend" 시 건너뜀)

| 항목 | 구현 |
|------|------|
| **트리거** | `/tasker` → `commands/tasker.md` / `/work` → `commands/work.md` |
| **수행 주체** | Claude + 서브에이전트 (합의 시) |
| **참여 훅** | 없음 |
| **참여 에이전트** | `architect` (접근 방식 평가), 합의 프로세스 시 3개 에이전트 |
| **읽는 파일** | `features/<slug>/task/_overview.md`, 관련 코드 파일 |
| **쓰는 파일** | `features/<slug>/task/<task-name>.md` `## Approaches` 섹션 |
| **산출물** | 채택 접근 방식 + 근거 |

**수행 절차**:
1. 접근 방식 2–4개 도출
2. 각 후보에 대해 장단점, 구현 복잡도, 위험도, 적용 가능성 기록
3. 최종 채택 방식 확정

**95% 합의 프로세스** (의사결정 어려운 경우):
```
서브에이전트 3개 할당:
  advocate  (긍정) → agent: architect   → 방식의 장점 옹호
  critic    (부정) → agent: critic      → 위험/단점 지적
  arbitrator(중립) → agent: analyst     → 양측 종합, 점수 계산

라운드 반복: 모든 에이전트 동의율 ≥ 95% 달성까지
채택 방식 확정 → 문서에 근거와 함께 기록
```

**"extend" 분기**: `keyword-detector.mjs`가 "extend" 매직 키워드 감지 시 `hint: "extend"` 전달 → `commands/work.md`가 Step 2를 건너뜀.

---

### Step 3 — Planning (계획)

> 커맨드: `/tasker` (Step 1–2 완료 후)

| 항목 | 구현 |
|------|------|
| **트리거** | `/tasker` → `commands/tasker.md` |
| **수행 주체** | Claude (프롬프트 지시) |
| **참여 훅** | 없음 |
| **참여 에이전트** | `planner` (복잡한 경우) |
| **읽는 파일** | Step 2 산출물 |
| **쓰는 파일** | `features/<slug>/task/<task-name>.md` `## Queue` 섹션 |
| **산출물** | 체크박스 트리 (의존 순서, `[parallel]` 태그), Wiki 링크 |

**선형 구조 원칙**: 모든 체크박스는 의존 관계 순서 나열. 병렬 가능 파트만 `[parallel]` 태그.

**Planning state 원칙**: `/tasker`는 `.smt/features/<slug>/task/`에 직접 계획을 기록한다.
모든 planning state의 source of truth는 `.smt/`이며, tasker planning은 해당 task 디렉토리에 정리된다.

**병렬 처리**: 계획 내 독립 파트는 서브에이전트로 분배:
```
[parallel] 파트 A → Sub-agent 1
[parallel] 파트 B → Sub-agent 2
동기화 포인트에서 합류
```

---

### Step 4 — Test Design / TDD (테스트 설계)

> 커맨드: `/work`, `/default`, `/ralph` (per-task)

| 항목 | 구현 |
|------|------|
| **트리거** | `commands/work.md` Step 4 / `commands/default.md` Step 4 |
| **수행 주체** | Claude + `tdd-guide` 에이전트 |
| **참여 훅** | `session-start-smelter.mjs` (TDD 컨텍스트 사전 주입) |
| **참여 에이전트** | `tdd-guide`, `executor` (테스트 작성) |
| **읽는 파일** | `features/<slug>/task/<task-name>.md` `## Queue` |
| **쓰는 파일** | 테스트 파일 (구현 파일 없이) |
| **산출물** | 테스트 파일 (모두 RED 상태) |

**TDD 강제 메커니즘** (2중):
1. `session-start-smelter.mjs`가 세션 시작 시 TDD 컨텍스트를 `system_prompt_prefix`로 주입
2. `commands/*.md`가 Step 4에서 "테스트 먼저 작성" 명시적 지시

**최소 테스트 수** (workflow.md 기준):

| 카테고리 | 최소 수 |
|---------|---------|
| 정상 동작 (happy path) | 2+ |
| 경계 조건 (boundary) | 2+ |
| 실패 케이스 (error path) | 2+ |
| 엣지 케이스 (edge case) | 2+ |
| 통합 (integration) | 1+ |
| **합계** | **10+** (`/work`), **5+** (`/default`) |

**TDD 면제 조건** (`/default` 전용, surface 기반):

| 변경 유형 | TDD | E2E |
|---------|-----|-----|
| CSS/스타일/색상/타이포그래피 | ❌ | ❌ |
| i18n/번역 텍스트 변경 | ❌ | ❌ |
| 기존 기능 수정 | ✅ (기존 테스트 먼저 확인) | surface-based |
| 신규 기능 구현 | ✅ | ✅ |

---

### Step 5 — Implementation (구현)

> 커맨드: `/work`, `/default`, `/ralph` (per-task)

| 항목 | 구현 |
|------|------|
| **트리거** | `commands/work.md` Step 5 / `commands/default.md` Step 5 |
| **수행 주체** | Claude + 서브에이전트 |
| **참여 훅** | `post-tool-verifier.mjs` (수정 파일 추적), `tool-retry.mjs` (재시도), `rule-injector.mjs` (코딩 규칙) |
| **참여 에이전트** | `executor` (기본), `executor-high` (복합), `designer` (UI), `build-fixer` (빌드 오류) |
| **읽는 파일** | Step 4 테스트 파일, `features/<slug>/task/<task-name>.md` |
| **쓰는 파일** | 구현 코드 파일, task 파일 (체크박스 업데이트) |
| **산출물** | 구현 코드 (GREEN), task 체크박스 업데이트 |

**파일 추적**: `post-tool-verifier.mjs`가 Write/Edit 시 수정 파일을 `/tmp/smelter-session-files-<hash>.json`에 기록 → Step 8 E2E 판단에 사용.

**코딩 규칙 주입**: `rule-injector.mjs`가 PreToolUse에서 파일 확장자 기반으로 `rules-lib/<lang>/` 규칙을 주입. `[Inject: rules-lib/<lang>]` 태그.

**실패 시 재진입 규칙**:

| 상황 | 조치 |
|------|------|
| 검증 실패 후 재진입 | Task 문서 업데이트 후 진행 |
| 동일 접근 방식 3회 이상 실패 (`/work`) | **Step 2로 복귀** — 다른 방식 채택 |
| 동일 접근 방식 3회 이상 실패 (`/default`) | **`/work` 수준으로 에스컬레이션** |
| 계획에 없는 추가 구현 | **금지** — Step 3로 돌아가 추가 |

---

### Step 6 — Local Agent Review (로컬 에이전트 리뷰)

> 커맨드: `/work`, `/default`, `/ralph` (per-task)

| 항목 | 구현 |
|------|------|
| **트리거** | `commands/work.md` Step 6 / `commands/default.md` Step 6 |
| **수행 주체** | 서브에이전트 (독립 검토) |
| **참여 훅** | 없음 |
| **참여 에이전트** | `code-reviewer`, `security-reviewer` (인증/입력/시크릿 변경 시) |
| **읽는 파일** | 구현 코드, 테스트 코드 |
| **쓰는 파일** | `features/<slug>/risks.md` 또는 task 파일 `## Risks` |
| **산출물** | Risks 기록, 이슈 분류 |

**3회 반복 규칙**: 이 과정은 반드시 **3번 반복**. 이전 Step으로 복귀 시 다시 3번 수행.

**검토 항목 및 복귀 규칙**:

| 검토 항목 | 실패 시 복귀 |
|---------|---------|
| 코드 품질 (가독성, 네이밍, 복잡도) | Step 5 |
| 버그 및 로직 오류 | Step 5 |
| 보안 취약점 | Step 5 |
| 계획(`## Queue`) 대비 구현 누락 | Step 3 |
| 엣지 케이스 (보안, QA, 실패 처리) | Step 3 |

**Risk 심각도 포맷**:
```markdown
## Risks
- [LOW] 에러 메시지가 사용자에게 너무 기술적
- [MEDIUM] 동시 요청 시 race condition 가능성
- [HIGH] 인증 토큰 만료 처리 누락
```

---

### Step 7 — Utility Test (유틸리티 테스트)

> 커맨드: `/work`, `/default`, `/ralph` (per-task)

| 항목 | 구현 |
|------|------|
| **트리거** | `commands/work.md` Step 7 / `commands/default.md` Step 7 |
| **수행 주체** | Claude (직접 명령 실행) |
| **참여 훅** | `tool-retry.mjs` (일시적 오류 재시도) |
| **참여 에이전트** | `build-fixer` (실패 시) |
| **실행 항목** | 유닛/통합 테스트 (scoped), 빌드, 타입 검사 |
| **산출물** | 테스트/빌드 결과 로그 |

**스코프 테스트 원칙** (변경 파일만):
```bash
# 변경 파일 식별
git diff --name-only

# 관련 테스트만 실행
npm test -- --testPathPattern="auth|profile"

# ❌ 금지 (명시적 요청 없이)
npm test          # 전체 단위 테스트
npx playwright test  # 전체 E2E
```

**검사 체크리스트**:

| 항목 | 명령 예시 | 실패 시 |
|------|---------|---------|
| 유닛/통합 테스트 (관련 파일만) | `npm test -- --testPathPattern="<keyword>"` | Step 5 복귀 |
| 빌드 성공 | `npm run build` | Step 5 복귀 |
| 타입 검사 (TypeScript) | `tsc --noEmit` | Step 5 복귀 |

---

### Step 8 — E2E Validation (E2E 검증)

> 커맨드: `/work` (필수), `/default` (surface-based), `/ralph` (per-task)

| 항목 | 구현 |
|------|------|
| **트리거** | `commands/work.md` Step 8 / `commands/default.md` Step 8 |
| **수행 주체** | Claude + `qa-tester` 에이전트 |
| **참여 훅** | `stop-e2e.mjs` (E2E 리마인더), `post-tool-verifier.mjs` (수정 파일 목록) |
| **참여 에이전트** | `qa-tester` (Playwright UI), `executor` (API/CLI/Hook 테스트) |
| **읽는 파일** | `/tmp/smelter-session-files-<hash>.json` (수정 파일 목록) |
| **쓰는 파일** | `.smelter/features/<slug>/artifacts/` (비디오, 로그, 스크린샷) |
| **산출물** | E2E 결과 아티팩트 |

**5-Surface Mapping**:

| Component | Real Interface | Runner |
|-----------|---------------|--------|
| UI/Frontend | Browser | Playwright |
| CLI/Script | stdin, argv, exit code | subprocess |
| HTTP API | HTTP endpoints | real server + curl/fetch |
| Database/Query | Real DB queries | real or in-process test DB |
| Hook script | stdin JSON → stdout JSON | `cat payload \| node hook.mjs` |

**산출물 형태**:

| 타입 | 산출물 | 필수 여부 |
|------|--------|---------|
| 프론트엔드 | 비디오 녹화 + 스크린샷 | 필수 |
| 백엔드/API | 로그 파일 | 필수 |

**stop-e2e.mjs 동작 (Stop 훅)**:
1. `post-tool-verifier.mjs`가 기록한 수정 파일 목록을 `/tmp/smelter-session-files-<hash>.json`에서 읽음
2. 소스 파일만 필터 (테스트/문서/설정 제외)
3. 컴포넌트 타입 감지 (hook, cli, api, ui, lib)
4. `.smelter/` 에 pending 항목이 있으면 `decision: "block"` + E2E 리마인더 주입

**제약 사항**:

| 제약 | 상세 |
|------|------|
| PROD 데이터 수정/삭제 금지 | 사용자 허락 없이 절대 불가 |
| 테스트 데이터셋 확인 | test용 데이터셋 확인 후 자동 허용 |
| 로그인 필요 시 | `.env`에 E2E auth 정보 삽입 요청 |

---

### Step 9 — Team Code Review (팀 에이전트 코드 리뷰)

> 커맨드: `/work`, `/default` (QA 시 건너뜀)

| 항목 | 구현 |
|------|------|
| **트리거** | `commands/work.md` Step 9 |
| **수행 주체** | 서브에이전트 3개 (합의 프로세스) |
| **참여 훅** | 없음 |
| **참여 에이전트** | advocate (`code-reviewer`), critic (`critic`), arbitrator (`analyst`) |
| **읽는 파일** | 전체 구현 코드, Risks 기록, E2E 아티팩트 (비디오/로그/스크린샷) |
| **쓰는 파일** | `features/<slug>/risks.md` 업데이트 |
| **산출물** | 팀 리뷰 결과 (심각도 분류) |

**3-에이전트 합의 프로세스**:
```
advocate  (code-reviewer, 긍정) → 구현의 장점, 올바른 결정 옹호
critic    (critic, 부정)        → 문제점, 놓친 케이스, 잠재적 버그 지적
arbitrator(analyst, 중립)       → 양측 종합, 점수 계산, 최종 판단

라운드 반복: 모든 에이전트 동의율 ≥ 95% 달성까지
```

**검토 범위**:
1. Step 6 리뷰 사항 재검토 (해소 여부)
2. 새로운 문제점 탐색
3. 보안 취약점, 성능 이슈, 유지보수성 평가
4. 기획에 대한 구현이 올바른지 검토

**심각도별 복귀 규칙**:

| 심각도 | 기준 | 조치 |
|--------|------|------|
| `CRITICAL` | 데이터 손실, 보안 취약점, 서비스 중단 | **Step 3 복귀** (재설계) |
| `HIGH` | 주요 버그, 심각한 엣지 케이스 누락 | **Step 3 복귀** |
| `MEDIUM` | 개선 필요한 로직, 마이너 버그 | **Step 5 복귀** (수정) |
| `LOW` | 스타일, 네이밍, 제안 사항 | Risks 기록 후 계속 |

---

### Step 10 — Human Review (사용자 리뷰)

> 커맨드: `/work`, `/default`, `/ralph` (per-task 완료 시)

| 항목 | 구현 |
|------|------|
| **트리거** | `commands/work.md` Step 10 / `commands/default.md` Step 10 |
| **수행 주체** | Claude (보고서 제시) + 사용자 (결정) |
| **참여 훅** | `auto-confirm.mjs` (미완료 작업 시 자동 계속) |
| **참여 에이전트** | `git-master` (Git 작업 시) |
| **읽는 파일** | 모든 이전 단계 산출물 |
| **쓰는 파일** | `features/<slug>/task/<task>.md`, `features/<slug>/results.md`, `.smelter/sessions/YYYY-MM-DD.md` |
| **산출물** | 완료 보고서, Git 커밋/푸시 |

**사용자 결정 옵션**:
```
[1] 재작업  → 재작업 범위 명시 → Step 3 복귀
[2] 완료    → Git 옵션으로 이동
[3] 보류    → features/<slug>/task/<task>.md에 blocked 기록
```

**Git 옵션** (완료 시):
```
[a] 현재 브랜치에 push     → git push origin {현재 브랜치}
[b] 새 브랜치 생성 후 push  → git checkout -b {name} && git push -u origin {name}
[c] 로컬 완료 (push 없음)  → 커밋만
```

**Task 문서 마무리**:
1. `features/<slug>/task/<task>.md` → `status: done`, 체크박스 `[x]`
2. `features/<slug>/results.md` 기입 (비디오, 로그, 브랜치, PR)
3. `.smelter/sessions/YYYY-MM-DD.md` 에 세션 로그 추가

**auto-confirm.mjs 동작** (전역 Stop 훅):
1. 메인 에이전트 턴 종료 시 `.smelter/`에서 pending task 확인
2. pending 있으면 → `.smelter/state/queue-<session>.json`에 마지막 메시지 저장
3. `decision: "block"` 으로 종료 차단
4. `auto-confirm-consumer.mjs`가 다음 UserPromptSubmit에서 소비 → 컨텍스트 주입 → 작업 계속

---

## 4. Hook 구성

### 이벤트별 훅과 워크플로우 관계

| 이벤트 | 훅 스크립트 | 워크플로우 역할 | 관련 단계 |
|--------|------------|---------------|----------|
| **SessionStart** | `session-start-smelter.mjs` | TDD 컨텍스트 + Caveman 스타일 + `.smelter/` 상태 주입 | Step 4 사전 준비 |
| **UserPromptSubmit** | `keyword-detector.mjs` | 커맨드 감지 → Skill 호출 주입 | 진입점 |
| **UserPromptSubmit** | `auto-confirm-consumer.mjs` | 자동 계속 큐 소비 | Step 10 후 |
| **UserPromptSubmit** | `skill-injector.mjs` | 학습된 스킬 매칭 → 컨텍스트 주입 | 전 단계 |
| **PreToolUse** | `pre-tool-enforcer.mjs` | 도구 설명 + 취소 시그널 차단 | 전 단계 |
| **PreToolUse** | `rule-injector.mjs` | 파일 확장자 기반 코딩 규칙 주입 | Step 5 |
| **PostToolUse** | `post-tool-verifier.mjs` | 수정 파일 추적 + 실패 감지 | Step 5→8 |
| **PostToolUse** | `tool-retry.mjs` | 일시적 오류 자동 재시도 (3회) | Step 5, 7 |
| **Stop** | `auto-confirm.mjs` | 미완료 작업 시 종료 차단 + 큐 저장 | Step 10 |
| **Stop** | `stop-e2e.mjs` | 소스 파일 변경 시 E2E 리마인더 | Step 8 |
| **SubagentStart/Stop** | `subagent-tracker.mjs` | 서브에이전트 추적 | Step 2, 6, 9 |
| **PreCompact** | `pre-compact.mjs` | 컴팩트 전 컨텍스트 보존 | 전 단계 |
| **SessionEnd** | `session-end.mjs` | 세션 종료 처리 | 전 단계 |

### 훅 실행 순서 다이어그램

```
세션 시작
  └─ SessionStart: session-start-smelter.mjs
       ├─ TDD_CONTEXT 주입 ──────────────── Step 4 준비
       ├─ CAVEMAN_CONTEXT 주입
       └─ .smelter/ 상태 로드 + pending task 알림

사용자 입력
  └─ UserPromptSubmit:
       ├─ keyword-detector.mjs ── 커맨드 감지 ── 진입
       ├─ auto-confirm-consumer.mjs ── 큐 소비
       └─ skill-injector.mjs ── 스킬 매칭

도구 사용 전
  └─ PreToolUse:
       ├─ pre-tool-enforcer.mjs ── 설명/취소
       └─ rule-injector.mjs ── 코딩 규칙

도구 사용 후
  └─ PostToolUse:
       ├─ post-tool-verifier.mjs ── 파일 추적
       └─ tool-retry.mjs ── 재시도

에이전트 응답 종료
  └─ Stop:
       ├─ auto-confirm.mjs ── 계속 강제
       └─ stop-e2e.mjs ── E2E 리마인더
```

---

## 5. State 프로토콜 (.smelter/)

### 디렉토리 구조

```
{PROJECT_ROOT}/.smelter/
├── index.md                           ← 대시보드 (feature 목록, pending/done 카운트)
├── features/
│   └── <feature-slug>/
│       ├── task/
│       │   ├── _overview.md           ← feature 목표, 범위, acceptance criteria
│       │   ├── plan.md                ← 실행 계획 (Queue, Approaches, Wiki Links)
│       │   └── <task-name>.md         ← 개별 태스크 (atomic, agent-readable)
│       ├── decisions.md               ← 아키텍처 결정 기록
│       ├── risks.md                   ← Step 6/9에서 채워짐
│       ├── results.md                 ← 아티팩트 경로, 커밋, PR
│       └── artifacts/                 ← 비디오/로그/스크린샷
├── state/                             ← 런타임 상태 (git-ignored)
│   ├── ralph-state.json               ← 영속 모드 상태
│   ├── queue-<session>.json           ← 자동 계속 큐
│   ├── tool-retry.json                ← 재시도 카운터
│   └── mode-emitted-<session>.json    ← 모드 배너 중복 방지
├── decisions/                         ← ADR (프로젝트 전체)
├── wiki/                              ← 프로젝트 지식 베이스
└── sessions/                          ← 세션 로그 (YYYY-MM-DD.md)
```

### 단계별 상태 파일 라이프사이클

| 단계 | 읽기 | 쓰기 |
|------|------|------|
| Step 1 | `index.md` | `features/<slug>/task/_overview.md`, task 파일 |
| Step 2 | task 파일, 코드 파일 | task 파일 `## Approaches` |
| Step 3 | task 파일 | task 파일 `## Queue`, `plan.md` |
| Step 4 | task `## Queue` | 프로젝트 테스트 파일 |
| Step 5 | 테스트 파일, task 파일 | 프로젝트 코드, task 체크박스 |
| Step 6 | 구현 코드, 테스트 코드 | `risks.md` |
| Step 7 | git diff 목록 | (로그 출력) |
| Step 8 | 수정 파일 목록 | `artifacts/` |
| Step 9 | 전체 산출물, `risks.md` | `risks.md` 업데이트 |
| Step 10 | 전체 산출물 | `results.md`, `sessions/`, task `status: done` |

---

## 6. Agent 테이블

### 워크플로우 단계별 에이전트 사용

| 에이전트 | 참여 단계 | 역할 | 티어 |
|---------|----------|------|------|
| `explore` | 1, 2 | 코드베이스 조사, 파일 검색 | H/S/O |
| `architect` | 2, 3 | 접근 방식 평가, 아키텍처 설계 | H/S/O |
| `planner` | 3 | 복잡한 계획 수립 | O |
| `critic` | 2, 9 | 계획/코드 비평 (부정 역할) | O |
| `analyst` | 2, 9 | 요구사항 분석, 중재 (중립 역할) | O |
| `tdd-guide` | 4 | TDD 프로토콜 강제 | H/S |
| `executor` | 4, 5 | 테스트/코드 작성 | H/S/O |
| `executor-high` | 5 | 복합 리팩토링 | O |
| `designer` | 5 | UI 구현 | H/S/O |
| `build-fixer` | 5, 7 | 빌드/타입 에러 수정 | H/S |
| `code-reviewer` | 6, 9 | 코드 품질 검토 (긍정 역할 in Step 9) | H/O |
| `security-reviewer` | 6 | 보안 취약점 탐지 | H/O |
| `qa-tester` | 8 | E2E 테스트 실행 | S/O |
| `git-master` | 10 | Git 커밋, 푸시 | S |

---

## 7. 커맨드별 단계 흐름

### /tasker (Step 1→3)

```
Step 1: 문제 인식 (features/<slug>/task/ 생성)
  → Step 2: 기획 검토 (Approaches, 95% 합의)
  → Step 3: 계획 (Queue 체크박스 트리)
  → 요약 출력 + 다음 커맨드 안내 (/ralph, /work, /default)
```

### /work (Step 1→10)

```
Step 1: 문제 인식 (plan 없으면 생성)
Step 2: 기획 검토 ("extend" 시 건너뜀)
Step 3: 계획
Step 4: TDD (RED)
Step 5: 구현 (GREEN → REFACTOR)
  ↓
Step 6: 로컬 리뷰 (3회 반복) ───→ [Step 3/5 복귀]
  ↓ 통과
Step 7: 유틸리티 테스트 ──────→ [Step 5 복귀]
  ↓ 통과
Step 8: E2E 검증 ─────────→ [Step 5 복귀]
  ↓ 통과
Step 9: 팀 리뷰 ──────────→ [Step 3/5 복귀]
  ↓ 통과
Step 10: 사용자 리뷰 ────→ [Step 3 복귀] 또는 완료
```

### /default (Step 4→10)

```
Surface 분류 (TDD/E2E 면제 판단)
  → Step 4: TDD (면제 가능)
  → Step 5: 구현
  → Step 6: 로컬 리뷰
  → Step 7: 유틸리티 테스트
  → Step 8: E2E (surface-based, 면제 가능)
  → Step 9: 팀 리뷰 (QA 시 건너뜀)
  → Step 10: 사용자 리뷰
```

### /ralph (per-task)

```
Step 1: planning state 읽기 (features/*/task/*.md)
Step 2: 태스크 선택 (쿼리 기반 또는 전체)
  ↓
각 태스크마다 (독립 컨텍스트):
  → 서브에이전트 스폰 (Context Isolation 원칙)
  → 태스크 유형/surface에 따라 Step 4-10 실행
  → 완료 시 task 파일 업데이트
  ↓
전체 완료 또는 blocked → 최종 체크리스트 → 세션 로그
```

---

## 8. 코드 인벤토리

### 핵심 인프라 (훅 + 진입)

| 파일 | 역할 | 상태 |
|------|------|------|
| `hooks/hooks.json` | 훅 이벤트 매핑 정의 | ✅ |
| `scripts/keyword-detector.mjs` | 커맨드/매직 키워드 감지 | ✅ |
| `scripts/session-start-smelter.mjs` | 세션 시작 컨텍스트 주입 | ✅ |
| `scripts/pre-tool-enforcer.mjs` | 도구 설명 + 취소 차단 | ✅ |
| `scripts/post-tool-verifier.mjs` | 수정 파일 추적 + 실패 감지 | ✅ |
| `scripts/tool-retry.mjs` | 일시적 오류 자동 재시도 | ✅ |
| `scripts/auto-confirm.mjs` | 미완료 작업 종료 차단 | ✅ |
| `scripts/auto-confirm-consumer.mjs` | 자동 계속 큐 소비 | ✅ |
| `scripts/stop-e2e.mjs` | E2E 리마인더 | ✅ |
| `scripts/skill-injector.mjs` | 학습 스킬 매칭/주입 | ✅ |
| `scripts/rule-injector.mjs` | 언어별 코딩 규칙 주입 | ✅ |
| `scripts/subagent-tracker.mjs` | 서브에이전트 추적 | ✅ |
| `scripts/pre-compact.mjs` | 컴팩트 전 컨텍스트 보존 | ✅ |
| `scripts/session-end.mjs` | 세션 종료 처리 | ✅ |
| `scripts/cancel-propagator.mjs` | 취소 시그널 전파 | ✅ |
| `scripts/permission-handler.mjs` | Bash 권한 요청 처리 | ✅ |

### 라이브러리

| 파일 | 역할 | 상태 |
|------|------|------|
| `scripts/lib/yellow-tag.mjs` | ANSI 노란색 태그 출력 | ✅ |
| `scripts/lib/cancel-signal.mjs` | 취소 시그널 read/write | ✅ |
| `scripts/lib/subagent-classifier.mjs` | Haiku 프롬프트 분류기 | ✅ |
| `scripts/lib/stdin.mjs` | stdin 읽기 유틸리티 | ✅ |
| `scripts/lib/codex-models.mjs` | Codex 모델 매핑 | ✅ |

### 커맨드 + 프리셋

| 파일 | 역할 | 상태 |
|------|------|------|
| `commands/tasker.md` | /tasker 프롬프트 (Step 1-3) | ✅ |
| `commands/work.md` | /work 프롬프트 (Step 1-10) | 🔧 수정 필요 |
| `commands/default.md` | /default 프롬프트 (Step 4-10) | 🔧 수정 필요 |
| `commands/ralph.md` | /ralph 프롬프트 (per-task) | ✅ |
| `presets/tasker.json` | tasker 메타 | ✅ |
| `presets/work.json` | work 메타 | 🔧 수정 필요 |
| `presets/default.json` | default 메타 | 🔧 수정 필요 |
| `presets/ralph.json` | ralph 메타 | ✅ |

### 에이전트 (34개)

| 범위 | 파일 수 | 상태 |
|------|---------|------|
| executor (H/S/O) | 3 | ✅ |
| architect (H/S/O) | 3 | ✅ |
| designer (H/S/O) | 3 | ✅ |
| explore (H/S/O) | 3 | ✅ |
| scientist (H/S/O) | 3 | ✅ |
| qa-tester (S/O) | 2 | ✅ |
| build-fixer (H/S) | 2 | ✅ |
| code-reviewer (H/O) | 2 | ✅ |
| researcher (H/S) | 2 | ✅ |
| tdd-guide (H/S) | 2 | ✅ |
| security-reviewer (H/O) | 2 | ✅ |
| planner (O) | 1 | ✅ |
| critic (O) | 1 | ✅ |
| analyst (O) | 1 | ✅ |
| git-master (S) | 1 | ✅ |
| writer (H) | 1 | ✅ |
| vision (S) | 1 | ✅ |
| deep-executor (O) | 1 | ✅ |

### 수정 필요 항목

| 파일 | 수정 내용 |
|------|----------|
| `commands/work.md` | Step 번호를 workflow.md 10단계에 맞춤 (현재 11단계 참조) |
| `commands/default.md` | Step 번호를 10단계에 맞춤 |
| `presets/work.json` | `"steps": [1,...,10]` (11→10) |
| `presets/default.json` | `"steps": [4,...,10]` (11→10) |
| `session-start-smelter.mjs` | `features/*/task/` 경로 기반으로 pending 탐색 정규화 |
| `auto-confirm.mjs` | `readPendingTasks()` → features 기반 탐색 보강 |
| `stop-e2e.mjs` | features 기반 workflow active 확인 |

### 미구현 (선택적)

| 파일 | 역할 | 우선순위 |
|------|------|---------|
| 집행 훅: `secret-hardcode-block` | Write/Edit 시 하드코딩된 시크릿 차단 | MEDIUM |
| 집행 훅: `large-file-warn` | Write 시 과대 파일 경고 | LOW |
| 집행 훅: `test-remind` | Edit/Write 후 테스트 리마인드 | LOW |
| 집행 훅: `agents-md-sync` | AGENTS.md 동기화 점검 | LOW |

---

## 9. 템플릿

### features/<slug>/task/_overview.md

```markdown
---
feature: <slug>
status: open | in_progress | done | blocked
created: YYYY-MM-DD
---

# <Feature Title>

## Goal
<한 줄 목표>

## Background
<배경 설명>

## Acceptance Criteria
- [ ] <검증 가능한 기준 1>
- [ ] <검증 가능한 기준 2>

## Scope
### In Scope
- ...
### Out of Scope
- ...
```

### features/<slug>/task/<task-name>.md

```markdown
---
task: <task-name>
type: feature | qa | need-review
status: pending | in_progress | blocked | done
created: YYYY-MM-DD
---

# <Task Title>

## Goal
<한 줄 목표>

## Queue
- [ ] 구현 항목 1
  - [ ] 하위 항목 A
  - [ ] 하위 항목 B
- [ ] 구현 항목 2 [parallel]
- [ ] TDD 작성
- [ ] E2E 작성

## Approaches
(Step 2에서 채워짐)

## Wiki Links
- [[관련-문서]]

## Risks
(Step 6, 9에서 채워짐)
```

### features/<slug>/results.md

```markdown
---
feature: <slug>
completed: YYYY-MM-DD
---

# Results

## Artifacts
- Video: <경로>
- Log: <경로>
- Screenshots: <경로>

## Git
- Branch: <브랜치명>
- Commit: <해시>
- PR: <URL 또는 "없음">
```

---

## 10. Visibility — Yellow Tags

| Tag | Source | 관련 단계 |
|-----|--------|----------|
| `[TASKER MODE]` / `[WORK MODE]` / `[DEFAULT MODE]` / `[RALPH MODE]` | keyword-detector | 진입 |
| `[Command: /<name>]` | keyword-detector | 진입 |
| `[Magic Keyword: <kw> → /<cmd>]` | keyword-detector | 진입 |
| `[Session Start]` | session-start-smelter | Step 4 준비 |
| `[Pre Tool: <name>]` | pre-tool-enforcer | 전 단계 |
| `[Inject: rules-lib/<lang>]` | rule-injector | Step 5 |
| `[Inject: scanning skills]` | skill-injector | 전 단계 |
| `[Post Verify]` | post-tool-verifier | Step 5 |
| `[Auto-Retry: <reason>]` | tool-retry | Step 5, 7 |
| `[Auto-Confirm: queued]` | auto-confirm | Step 10 |
| `[Run E2E]` | stop-e2e | Step 8 |
