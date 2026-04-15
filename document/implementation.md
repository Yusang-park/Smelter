---
title: Smelter Implementation
type: canonical
tags: [smelter, implementation, inventory, status]
created: 2026-04-13
updated: 2026-04-15
---

# Smelter Implementation

> 코드 인벤토리 및 구현 상태 추적 문서.
> 워크플로우 상세(10단계)는 [[workflow]]를 참조.
> 체크 마크가 없는 항목은 미구현. 사용자가 완전히 됐다고 확인하면 완료 처리.
> 이 파일이 수정되면 index, workflow 파일 모두 함께 수정되어야 함.

---

## 실행 모델 요약

> 상세: [[workflow]] §실행 모델 요약

| 축 | 값 | 의미 |
|---|---|---|
| 시작 명령 | `/tasker` | planning state 생성/보정 (Step 1-3) |
| | `/feat` | 구현 작업 (task 없으면 Step 1-10, 있으면 Step 4-10) |
| | `/qa` | 버그 수정 (Step 4-8, 10 — Step 9 건너뜀) |

아키텍처: `사용자 입력 → keyword-detector (훅) → Skill Tool → commands/*.md (프롬프트) → Claude 실행 → hooks 가드레일 → .smt/ 상태 추적`

---

## 커맨드

> 상세: [[workflow]] §실행 모델 요약, §시작 명령 적용

| 커맨드 | 파일 | 프리셋 | 단계 범위 | E2E | 상태 |
|--------|------|--------|-----------|-----|------|
| `/tasker` | `commands/tasker.md` | `tasker` | 1-3 | — | |
| `/feat` | `commands/feat.md` | `feat` | 1-10 (task 지정시 4-10) | surface-based | |
| `/qa` | `commands/qa.md` | `qa` | 4-8, 10 | surface-based | |

### 프리셋

| 프리셋 | 파일 | Steps | E2E | 최소 테스트 | 상태 |
|--------|------|-------|-----|-----------|------|
| `tasker` | `presets/tasker.json` | 1-3 | false | 0 | |
| `feat` | `presets/feat.json` | 1-10 | surface | 10+ | |
| `qa` | `presets/qa.json` | 4-8, 10 | surface | 5+ | |

### 매직 키워드 (keyword-detector.mjs)

| 키워드 | 커맨드 | 분기 힌트 |
|--------|--------|----------|
| `tasker`, `plan`, `설계해줘`, `계획부터` | `/tasker` | — |
| `new feature`, `새 기능`, `design first` | `/feat` | Step 2 포함 |
| `extend`, `add to`, `덧붙여`, `확장해줘` | `/feat` | Step 2 건너뜀 |
| `fix`, `bug`, `버그`, `고쳐` | `/qa` | E2E 강제 |
| `style`, `typo`, `텍스트`, `색상`, `i18n`, `문구` | `/qa` | TDD 면제 |
| `cancel`, `stop` | `/cancel` | — |

---

## 코드 인벤토리 (src/bin)

> smelter CLI 패키지 (`/Users/yusang/smelter/`)

| 파일 | 역할 | 상태 |
|------|------|------|
| `src/index.ts` | Public exports (타입, 엔진, 어댑터, 러너, 룰) | |
| `src/types.ts` | HarnessPreset, 실행 옵션, E2E 타입, StreamChunk, UsageInfo | |
| `src/engine.ts` | `runWithHarness()` — Claude 호출 + `runWithTask()` — 프리셋 로드·컨텍스트 주입·태스크 라이프사이클 | |
| `src/adapters/claude.ts` | Claude CLI spawn + JSONL 파싱 (Node.js `child_process`) | |
| `src/adapters/codex.ts` | Codex (OpenAI) CLI spawn — GPT/o-series 모델 라우팅 | |
| `src/runners/playwright.ts` | Playwright CLI spawn + JSON 결과 파싱 | |
| `src/rules/defaults.ts` | DEFAULT_RULES, TDD_E2E_SYSTEM_PROMPT, CAVEMAN_SYSTEM_PROMPT, HARNESS_CONFIG | |
| `bin/cli.ts` | CLI: `smelter` 커맨드 전체 (run/task/e2e/review/status/init/workflow 등) | |
| `src/store.ts` | 로컬 태스크 스토어 (`.smt/tasks.json`) | |
| `src/artifacts.ts` | E2E 영상/로그/스크린샷 아티팩트 저장 | |
| `src/project-memory.ts` | 프로젝트 메모리 (techStack, conventions, notes, directives) | |
| `src/skill-loader.ts` | 스킬 로드 + 시스템 프롬프트 주입 | |
| `src/agent-loader.ts` | 에이전트 로드 + frontmatter 파싱 | |
| `src/workflow-engine.ts` | YAML DAG 워크플로우 엔진 — 위상 정렬 + 병렬 레이어 실행 | |
| `src/workflow-types.ts` | WorkflowNode, Workflow, NodeResult, WorkflowResult 타입 | |

---

## Hooks 구성

> 상세 실행 순서: [[workflow]] §Rules Injection
> 모든 훅은 노란색 ANSI 태그를 stderr로 출력

### 핵심 훅

| 이벤트 | 스크립트 | 역할 | 상태 |
|--------|---------|------|------|
| `SessionStart` | `session-start-smelter.mjs` | Caveman 응답 스타일 + TDD 강제 + `.smt/` plan/task 주입 | ✅ |
| `UserPromptSubmit` | `keyword-detector.mjs` | `/tasker` `/feat` `/qa` `/cancel` `/queue` 감지 → harness state 활성화 + command 주입 | 🔧 |
| `UserPromptSubmit` | `auto-confirm-consumer.mjs` | 자동 계속 큐 소비 → 컨텍스트 주입 | ✅ |
| `UserPromptSubmit` | `skill-injector.mjs` | 학습된 스킬 자동 매칭 및 프롬프트 주입 | ✅ |
| `PreToolUse` | `pre-tool-enforcer.mjs` | 도구 사용 전 설명 주입 + 취소 시그널 차단 | ✅ |
| `PreToolUse` | `rule-injector.mjs` | 파일 확장자 기반 `rules-lib/<lang>` 코딩 규칙 주입 | ✅ |
| `PostToolUse` | `post-tool-verifier.mjs` | 수정 파일 추적, 실패 감지, bash history 기록 | ✅ |
| `PostToolUse` | `tool-retry.mjs` | 일시적 오류 자동 재시도 (rg timeout, file-modified 등, 최대 3회) | ✅ |
| `Stop` | `auto-confirm.mjs` | 미완료 작업 시 종료 차단 + 큐 파일 저장 | 🔧 |
| `Stop` | `stop-e2e.mjs` | 소스 파일 변경 감지 → E2E 리마인더 (Step 8) | 🔧 |

### 보조 훅

| 이벤트 | 스크립트 | 역할 | 상태 |
|--------|---------|------|------|
| `SubagentStart/Stop` | `subagent-tracker.mjs` | 서브에이전트 추적 | ✅ |
| `PreCompact` | `pre-compact.mjs` | 컴팩트 전 컨텍스트 보존 | ✅ |
| `SessionEnd` | `session-end.mjs` | 세션 종료 처리 | ✅ |
| `PermissionRequest` | `permission-handler.mjs` | Bash 권한 요청 처리 | ✅ |

### Setup 훅

| 이벤트 | 스크립트 | 역할 | 상태 |
|--------|---------|------|------|
| `SessionStart(init)` | `setup-init.mjs` | 초기 설치/세팅 보조 | ✅ |
| `SessionStart(maintenance)` | `setup-maintenance.mjs` | 유지보수/정리 작업 보조 | ✅ |

### 라이브러리 (scripts/lib/)

| 파일 | 역할 | 상태 |
|------|------|------|
| `yellow-tag.mjs` | ANSI 노란색 태그 출력 `[smelter]` | ✅ |
| `cancel-signal.mjs` | 취소 시그널 read/write/clear | ✅ |
| `subagent-classifier.mjs` | Haiku 서브에이전트 기반 프롬프트 분류 | ✅ |
| `stdin.mjs` | stdin 읽기 유틸리티 | ✅ |
| `codex-models.mjs` | Codex 모델 매핑 | ✅ |

### 미구현 집행 훅

> 공통 규칙을 자동 집행/리마인드하는 역할. 새 규칙을 정의하는 곳이 아님.

| 훅 이름 | 이벤트 | 집행 대상 | 상태 |
|---------|--------|----------|------|
| `secret-hardcode-block` | `PreToolUse(Write/Edit)` | 하드코딩된 시크릿 금지 | 🔲 |
| `large-file-warn` | `PreToolUse(Write)` | 과대 파일 경고 | 🔲 |
| `test-remind` | `PostToolUse(Edit/Write)` | 코드 수정 후 테스트 리마인드 | 🔲 |
| `agents-md-sync` | `Stop` | AGENTS.md 동기화 점검 | 🔲 |

---

## 기본 내장 룰 (DEFAULT_RULES)

> `src/rules/defaults.ts`에 정의. 훅이 런타임에 강제.

| ID | 트리거 | 동작 | 강제 훅 | 상태 |
|----|--------|------|---------|------|
| `tdd-enforce` | 세션 시작 | TDD 프롬프트 주입 (RED→GREEN→REFACTOR) | `session-start-smelter.mjs` | ✅ |
| `caveman-compress` | 세션 시작 | Caveman 응답 스타일 주입 (~40-50% 토큰 절감) | `session-start-smelter.mjs` | ✅ |
| `e2e-on-complete` | Stop | 코드 변경 감지 → E2E 리마인더 주입 | `stop-e2e.mjs` | ✅ |
| `auto-confirm` | Stop | 미완료 작업 시 종료 차단, 다음 턴에 컨텍스트 주입 | `auto-confirm.mjs` | ✅ |
| `tool-retry` | PostToolUse | rg timeout, file-modified 등 일시적 오류 자동 재시도 | `tool-retry.mjs` | ✅ |
| `system-prompt-inject` | 세션 시작 | `.smt/` plan/task 컨텍스트 주입 | `session-start-smelter.mjs` | ✅ |
| `save-artifacts` | E2E 완료 | 영상/스크린샷/로그를 `.smt/features/<slug>/artifacts/`에 저장 | `stop-e2e.mjs` | |
| `e2e-retry-on-fail` | E2E 실패 | 실패 내용을 채팅에 주입 → 자동 수정 | — | 🔲 |
| `task-on-start` | 개발 요청 감지 | 카드 자동 생성 + in_progress 이동 | — | 🔲 |

---

## Skills 목록

### 실행 관련 (2개)

| 스킬 | 동작 | 상태 |
|------|------|------|
| `deep-executor` | 복잡한 목표 지향 자율 실행 | ✅ |
| `tdd` | RED→GREEN→REFACTOR TDD 강제 워크플로우 | ✅ |

### 계획/품질 (9개)

| 스킬 | 동작 | 관련 Step | 상태 |
|------|------|----------|------|
| `ralplan` | Planner + Architect + Critic 합의까지 반복 | 2-3 | ✅ |
| `tdd-linear` | TDD 강제 + 10개 이상 테스트 + 면제 조건 | 4 | ✅ |
| `code-review` | 코드 리뷰 실행 | 6, 9 | ✅ |
| `security-review` | 보안 리뷰 실행 | 6 | ✅ |
| `build-fix` | 빌드/TypeScript 에러 수정 | 7 | ✅ |
| `analyze` | 심층 분석 및 조사 | 2 | ✅ |
| `review` | Critic을 통한 계획 리뷰 | 2-3 | ✅ |
| `research` | 병렬 scientist 에이전트 리서치 | 2 | ✅ |

### 유틸리티 (13개)

| 스킬 | 동작 | 상태 |
|------|------|------|
| `cancel` | 활성 실행 취소 | ✅ |
| `note` | 노트패드 저장 (compaction 복원력) | ✅ |
| `caveman` | 토큰 압축 응답 (~40-50% 절감) | ✅ |
| `help` | 사용 가이드 | ✅ |
| `doctor` | 설치 진단 및 수정 | ✅ |
| `skill` | 로컬 스킬 관리 (list/add/remove) | ✅ |
| `learner` | 현재 대화에서 스킬 추출 | ✅ |
| `git-master` | Git 커밋, 리베이스, 히스토리 관리 | ✅ |
| `deepsearch` | 코드베이스 심층 검색 | ✅ |
| `trace` | 에이전트 플로우 타임라인 표시 | ✅ |
| `writer-memory` | 작가용 메모리 (캐릭터/관계/씬 추적) | ✅ |
| `frontend-ui-ux` | UI/UX 디자이너-개발자 | ✅ |
| `continuous-learning-v2` | ECC instinct 학습 시스템 | ✅ |

### 인프라/설정 (7개)

| 스킬 | 동작 | 상태 |
|------|------|------|
| `deepinit` | AGENTS.md 계층적 코드베이스 초기화 | ✅ |
| `local-skills-setup` | 로컬 스킬 자동 매칭 설정 | ✅ |
| `mcp-setup` | MCP 서버 구성 | ✅ |
| `orchestrate` | 멀티 에이전트 오케스트레이션 활성화 | ✅ |
| `project-session-manager` | worktree + tmux 격리 환경 관리 | ✅ |
| `release` | 릴리스 워크플로우 자동화 | ✅ |
| `hud` | HUD 디스플레이 옵션 구성 | ✅ |

### 미구현 범용 스킬

| 스킬 | 트리거 | 동작 | 상태 |
|------|--------|------|------|
| `review-all` | `/review-all` | 코드 리뷰 + 보안 리뷰 + 타입 체크 병렬 후 통합 리포트 | 🔲 |
| `pr-ready` | `/pr-ready` | 린트 → 타입 체크 → 테스트 → PR body 생성 → push 원스톱 | 🔲 |
| `feature-kickoff` | `/feature-kickoff` | 브랜치 생성 → AGENTS.md 확인 → 태스크 리스트 → TDD 시작 | 🔲 |
| `debt-scan` | `/debt-scan` | TODO/FIXME/`console.log`/`any`/테스트 누락 스캔 | 🔲 |

---

## Agents 목록 (34개)

> 에이전트는 `Agent(subagent_type="<name>")` 형태로 스폰.
> 워크플로우 단계별 사용은 [[workflow]] 각 Step의 §시작 명령 적용 참조.

| 에이전트 | 티어(들) | 파일 수 | 용도 | 상태 |
|---------|---------|--------|------|------|
| executor | H/S/O | 3 | 코드 구현 (low=단순, med=기본, high=복합 리팩토링) | ✅ |
| architect | H/S/O | 3 | 아키텍처 설계, 디버깅 조언 | ✅ |
| designer | H/S/O | 3 | UI/UX 디자인-개발 | ✅ |
| explore | H/S/O | 3 | 코드베이스 탐색, 파일/패턴 검색 | ✅ |
| scientist | H/S/O | 3 | 데이터 분석, 리서치, ML | ✅ |
| qa-tester | S/O | 2 | E2E 테스트, CLI 테스트 | ✅ |
| build-fixer | H/S | 2 | 빌드/타입 에러 수정 | ✅ |
| code-reviewer | H/O | 2 | 코드 리뷰 (품질/보안/유지보수) | ✅ |
| researcher | H/S | 2 | 외부 문서 리서치 | ✅ |
| tdd-guide | H/S | 2 | TDD 강제 (테스트 먼저 작성) | ✅ |
| security-reviewer | H/O | 2 | 보안 취약점 탐지 (OWASP Top 10) | ✅ |
| planner | O | 1 | 전략적 계획 + 인터뷰 워크플로우 | ✅ |
| critic | O | 1 | 계획 리뷰 + 비평 | ✅ |
| analyst | O | 1 | 요구사항 분석 | ✅ |
| git-master | S | 1 | Git 커밋, 리베이스, 히스토리 관리 | ✅ |
| writer | H | 1 | 기술 문서 작성 (README, API docs) | ✅ |
| vision | S | 1 | 이미지/PDF/다이어그램 분석 | ✅ |
| deep-executor | O | 1 | 복잡한 목표 지향 자율 실행 | ✅ |
| **합계** | | **34** | | ✅ |

### 워크플로우 단계별 에이전트 배정

| Step | 에이전트 | 역할 |
|------|---------|------|
| 1 (문제 인식) | `explore` | 코드베이스 조사 |
| 2 (기획 검토) | `architect`, `critic`, `analyst` | 접근 방식 평가, 95% 합의 프로세스 |
| 3 (계획) | `planner` | 복잡한 계획 수립 |
| 4 (TDD) | `tdd-guide`, `executor` | TDD 강제, 테스트 작성 |
| 5 (구현) | `executor`, `executor-high`, `designer`, `build-fixer` | 코드 작성, UI, 빌드 수정 |
| 6 (로컬 리뷰) | `code-reviewer`, `security-reviewer` | 코드/보안 검토 (3회 반복) |
| 7 (유틸리티 테스트) | `build-fixer` | 실패 시 수정 |
| 8 (E2E) | `qa-tester`, `executor` | 5-surface E2E 실행 |
| 9 (팀 리뷰) | `code-reviewer`(advocate), `critic`, `analyst`(arbitrator) | 3-에이전트 95% 합의 |
| 10 (사용자 리뷰) | `git-master` | Git 커밋/푸시 |

### 미구현 보강 에이전트

| 에이전트                 | 파일명                     | 역할                         | 상태  |
| -------------------- | ----------------------- | -------------------------- | --- |
| `pr-author`          | `pr-author.md`          | 커밋 히스토리 → 영문 PR body 자동 생성 | 🔲  |
| `monorepo-navigator` | `monorepo-navigator.md` | pnpm/turborepo 영향 범위 분석    | 🔲  |
| `changelog-writer`   | `changelog-writer.md`   | 커밋 로그 → CHANGELOG.md 자동 작성 | 🔲  |
| `test-gap-finder`    | `test-gap-finder.md`    | 변경 코드의 테스트 누락 영역 탐지        | 🔲  |

---

## 파일 기반 메모리 (.smt/)

> 핵심 철학: **Agents do not memorize — agents read files.**
> 경로 기준: [[workflow]] §용어 정의

### 디렉토리 구조

```
{PROJECT_ROOT}/.smt/
├── index.md                           ← 대시보드 (feature 목록, pending/done)
├── features/
│   └── <feature-slug>/
│       ├── task/
│       │   ├── plan.md                ← 실행 계획 (## Plan 체크박스 트리)
│       │   └── <task_slug>.md         ← 개별 태스크 (atomic, agent-readable)
│       ├── decisions.md               ← 아키텍처 결정 기록
│       └── artifacts/                 ← 비디오/로그/스크린샷 (Step 8)
├── state/                             ← 런타임 상태 (git-ignored)
│   ├── queue-<session>.json
│   ├── tool-retry.json
│   └── mode-emitted-<session>.json
├── decisions/                         ← ADR (프로젝트 전체)
├── wiki/                              ← 프로젝트 지식 베이스
└── sessions/                          ← 세션 로그 (YYYY-MM-DD.md)
```

### 파일 설명

| 파일/디렉토리 | 역할 | 읽는 단계 | 쓰는 단계 |
|-------------|------|----------|----------|
| `.smt/index.md` | 전체 feature 대시보드, pending/done 카운트 | 1 | 1, 10 |
| `.smt/features/<slug>/task/plan.md` | 실행 계획, ## Plan 체크박스 트리 | 3-10 | 3 |
| `.smt/features/<slug>/task/<task_slug>.md` | 개별 태스크 (type, status, Queue, Approaches, Risks) | 4-10 | 1-2, 5-6, 9-10 |
| `.smt/features/<slug>/decisions.md` | 해당 feature의 아키텍처 결정 | 2-3 | 2, 5 |
| `.smt/features/<slug>/artifacts/` | E2E 비디오, 로그, 스크린샷 | 9-10 | 8 |
| `.smt/state/queue-<session>.json` | auto-confirm 큐 (Stop → 다음 UserPromptSubmit) | 훅 | auto-confirm |
| `.smt/sessions/YYYY-MM-DD.md` | 세션 로그 | — | 10 |
| `.smt/wiki/` | 프로젝트 지식 베이스 | 2-3 | 3 |

---

## Visibility — Yellow Tags

| Tag | Source | 관련 |
|-----|--------|------|
| `[TASKER MODE]` / `[FEAT MODE]` / `[QA MODE]` | keyword-detector | 진입 |
| `[Command: /<name>]` | keyword-detector | 진입 |
| `[Magic Keyword: <kw> → /<cmd>]` | keyword-detector | 진입 |
| `[Session Start]` | session-start-smelter | 세션 |
| `[Pre Tool: <name>]` | pre-tool-enforcer | 전체 |
| `[Inject: rules-lib/<lang>]` | rule-injector | Step 5 |
| `[Inject: scanning skills]` | skill-injector | 전체 |
| `[Post Verify]` | post-tool-verifier | Step 5 |
| `[Auto-Retry: <reason>]` | tool-retry | Step 5, 7 |
| `[Auto-Confirm: queued]` | auto-confirm | Step 10 |
| `[Run E2E]` | stop-e2e | Step 8 |
| `[Plan Mode: Enter/Exit]` | /tasker command | Step 1-3 |

---

## 마이그레이션 항목

> 현재 코드베이스 → workflow.md 정합성 확보를 위한 변경 목록

### 이름 변경 (work→feat, default→qa, ralph 제거)

| 현재 파일 | 변경 후 | 비고 |
|----------|---------|------|
| `commands/work.md` | `commands/feat.md` | 프롬프트 내용도 workflow.md 10단계에 맞춤 |
| `commands/default.md` | `commands/qa.md` | Step 4-8, 10 (Step 9 건너뜀) 반영 |
| `commands/ralph.md` | 삭제 | workflow.md에 없는 커맨드 |
| `presets/work.json` | `presets/feat.json` | name, steps 필드 갱신 |
| `presets/default.json` | `presets/qa.json` | name, steps 필드 갱신 |
| `presets/ralph.json` | 삭제 | workflow.md에 없는 프리셋 |

### 스크립트 수정

| 파일 | 수정 내용 |
|------|----------|
| `keyword-detector.mjs` | `COMMAND_CONFIG` 키: `work→feat`, `default→qa`, `ralph` 제거. MODE_LABELS 갱신 |
| `session-start-smelter.mjs` | `.smelter/` → `.smt/` 경로 전환 |
| `auto-confirm.mjs` | `readPendingTasks()` 경로 `.smelter/` → `.smt/`, features 기반 탐색 |
| `stop-e2e.mjs` | `.smelter/` → `.smt/` 경로 전환 |
| `post-tool-verifier.mjs` | tracking 경로 필요시 갱신 |

### 문서 수정

| 파일 | 수정 내용 |
|------|----------|
| `CLAUDE.md` | 전체 `.smelter/` → `.smt/`, `/work`→`/feat`, `/default`→`/qa` |
| `AGENTS.md` | 커맨드 이름 갱신 |
| `document/index.md` | 커맨드 테이블 갱신 |
| `document/workflow.md` | line 20-21의 "Step 4-11" → "Step 4-10" 정합성 수정 |

---

## 현재 상태 스냅샷

| 영역 | 상태 |
|------|------|
| 코드 인벤토리 (src/bin) | 15개 TS 파일 목록화, 구현 확인 필요 |
| 커맨드 | 3개 (이름 변경 필요: work→feat, default→qa, ralph 제거) |
| 프리셋 | 3개 (이름 변경 필요, ralph 제거) |
| Hooks (핵심 + 보조 + setup) | 14개 스크립트 연결, 3개 경로 수정 필요 |
| Skills | 31개 존재 |
| Agents | 34개 존재 |
| 파일 메모리 | `.smelter/` → `.smt/` 전환 필요 |
| 미구현 집행 훅 | 4개 |
| 미구현 범용 스킬 | 4개 |
| 미구현 보강 에이전트 | 4개 |
