---
title: Hooks Execution Workflow — 선형 실행 순서
type: reference
tags: [smelter, hooks, workflow, claude-code, execution-order]
created: 2026-04-13
updated: 2026-04-13
source_count: 12
---

# Hooks Execution Workflow — 선형 실행 순서

> ← [[wiki/smelter/index|Harness Index]] · [[claude-codex-structure|Claude & Codex 구조]]
> `~/.claude/hooks/hooks.json` 에 정의된 모든 훅의 실행 순서와 각 스크립트가 수행하는 작업을 선형적으로 기술.

---

## 전체 라이프사이클 요약

```
┌─────────────────────────────────────────────────────────────────┐
│                    Claude Code Session                          │
│                                                                 │
│  ① SessionStart ──→ ② UserPromptSubmit ──→ ③ PreToolUse ──→   │
│  ④ PermissionRequest ──→ [도구 실행] ──→ ⑤ PostToolUse ──→    │
│  ⑥ SubagentStart/Stop ──→ ... (반복) ... ──→                   │
│  ⑦ PreCompact ──→ ⑧ Stop ──→ ⑨ SessionEnd                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## ① SessionStart — 세션 시작 (1회)

> **시점:** Claude Code 프로세스가 시작되고, 첫 프롬프트를 받기 전.
> **matcher:** `*` (모든 세션)

### 1-A. `session-start.mjs` (timeout: 5s)

OMC 플러그인의 메인 세션 초기화 스크립트.

**입력:** stdin으로 JSON 수신 → `{ cwd, session_id, ... }`

**실행 순서:**

1. **버전 드리프트 감지** (`detectVersionDrift`)
   - `CLAUDE_PLUGIN_ROOT/package.json` 에서 플러그인 버전 읽기
   - `~/.claude/.omc-version.json` 에서 npm 패키지 버전 읽기
   - `~/.claude/CLAUDE.md` 에서 `<!-- OMC:VERSION:x.x.x -->` 마커 파싱
   - 세 버전이 불일치하면 `[OMC VERSION DRIFT DETECTED]` 경고 메시지 생성
   - `~/.claude/.omc/update-state.json` 캐시로 동일 드리프트 중복 알림 방지

2. **npm 레지스트리 업데이트 체크** (`checkNpmUpdate`)
   - `~/.claude/.omc/update-check.json` 캐시 확인 (24시간 TTL)
   - 캐시 만료 시 `registry.npmjs.org/oh-my-claude-sisyphus/latest` fetch (2초 타임아웃)
   - 새 버전 존재 시 `[OMC UPDATE AVAILABLE]` 메시지 생성

3. **HUD 설치 상태 확인** (`checkHudInstallation`)
   - `~/.claude/hud/omc-hud.mjs` 또는 `sisyphus-hud.mjs` 존재 확인
   - `~/.claude/settings.json` 에서 `statusLine` 설정 확인
   - 레이스 컨디션 대비 최대 2회 retry (100ms 간격)
   - 미설치 시 `[Sisyphus] HUD not configured` system-reminder 주입

4. **Ralph 상태 복원** (`ralphState`)
   - `{project}/.omc/state/persistent-state.json` 읽기
   - `active === true` 이면 `[RALPH LOOP RESTORED]` 메시지 (반복 횟수 포함)

5. **미완료 Todo 감지**
   - 프로젝트 로컬만 스캔: `{project}/.omc/todos.json`, `{project}/.claude/todos.json`
   - ⚠️ `~/.claude/todos/` 글로벌 디렉토리는 의도적으로 스캔하지 않음 (issue #354)
   - 미완료 항목 존재 시 `[PENDING TASKS DETECTED]` 메시지

6. **Notepad Priority Context 주입**
   - `{project}/.omc/notepad.md` 에서 `## Priority Context` 섹션 파싱
   - HTML 주석 제거 후 실제 내용이 있으면 `<notepad-context>` 태그로 주입
   - 이 컨텍스트는 컴팩션 이후에도 유지되는 핵심 정보

7. **플러그인 캐시 정리**
   - `~/.claude/plugins/cache/omc/oh-my-claudecode/` 에서 버전별 캐시 스캔
   - semver 정렬 → 최신 2개만 유지, 나머지 삭제

**출력:** `{ continue: true, hookSpecificOutput: { additionalContext: "..." } }`

---

### 1-B. `session-start-smelter.mjs` (timeout: 5s)

Smelter TDD 강제 + 응답 스타일 + 파일 기반 메모리 주입.

**실행 순서:**

1. **Caveman 컨텍스트 주입** (항상)
   ```
   [RESPONSE STYLE: CONCISE]
   Remove filler words, pleasantries, and hedging from all responses.
   Keep articles, grammar, and complete sentences intact.
   ```

2. **TDD 컨텍스트 주입** (항상)
   ```
   [LINEAR HARNESS — TDD + E2E MODE]
   1. Write tests FIRST (RED)
   2. Run tests — they MUST fail initially
   3. Write minimal code to pass tests (GREEN)
   4. Refactor (IMPROVE)
   5. E2E tests will run automatically
   ```

3. **`.smelter/` 디렉토리 탐색** (`findSmelterDir`)
   - 현재 디렉토리부터 최대 6레벨 상위까지 `.smelter/tasker.md` 탐색
   - 발견 시 다음 파일 로드:
     - `plan.md` → 최대 2000자까지 로드
     - `task/{기능명}.md` → `- [ ]`, `- [~]`, `- [!]` (미완료/진행중/중요) 항목만 필터링
   - `[SMELTER FILE-BASED MEMORY]` 블록으로 주입

**출력:** `{ type: "system_prompt_prefix", content: "CAVEMAN + TDD + SMELTER" }`

> **Note:** 이 스크립트는 `system_prompt_prefix` 타입으로 출력 → 시스템 프롬프트 앞에 직접 삽입됨.

---

## ② UserPromptSubmit — 사용자 프롬프트 제출 (매 입력마다)

> **시점:** 사용자가 프롬프트를 입력하고 제출한 직후, Claude가 처리를 시작하기 전.
> **matcher:** `*`

### 2-A. `keyword-detector.mjs` (timeout: 5s)

문서에 정의된 명시적 slash command를 감지하여 command invocation과 harness state를 주입한다.

**입력:** stdin으로 `{ prompt, cwd, session_id }` 수신

**실행 순서:**

1. **프롬프트 추출** (`extractPrompt`)
   - `data.prompt`, `data.message.content`, 또는 `data.parts[].text` 에서 추출

2. **명시적 커맨드 매칭** (`extractExplicitHarnessCommand`)
   - 허용 커맨드: `/tasker`, `/tasker`, `/work`, `/default`, `/ralph`
   - 정규식: `^/(plan|todo|work|simple|ralph)\\b`
   - 자연어 질문이나 메타 대화는 감지하지 않음

3. **상태 파일 생성** (`activateHarnessState`)
   - 모든 감지 커맨드에 대해 `{project}/.omc/state/harness-state.json` 생성
   - `/ralph`일 때만 `{project}/.omc/state/persistent-state.json` 추가 생성
   - `persistent-state.json`에는 `selection_query`가 포함될 수 있음

4. **Flow Trace 기록** (best-effort)
   - `dist/hooks/subagent-tracker/flow-tracer.js` 로 감지된 command와 mode 변경 기록

5. **출력 생성**
   - `[MAGIC KEYWORD: XXX]` 형식의 additionalContext를 만들어 해당 command를 즉시 invoke하도록 지시
   - 현재 이 훅은 문서화된 5개 command 외 자연어 키워드, MCP 위임, 혼합 모드 조합을 처리하지 않음

**출력:** `{ continue: true, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "..." } }`

---

### 2-B. `skill-injector.mjs` (timeout: 3s)

학습된 스킬(Learned Skills)을 프롬프트 트리거와 매칭하여 자동 주입.

**입력:** stdin으로 `{ prompt, cwd, session_id }` 수신

**실행 순서:**

1. **컴파일된 브릿지 로드 시도** (`dist/hooks/skill-bridge.cjs`)
   - 성공 시: 재귀 탐색 + 영속 세션 캐시 사용
   - 실패 시: 인라인 폴백 (비재귀 + 인메모리 캐시)

2. **스킬 파일 탐색** (`findSkillFiles`)
   - 프로젝트 스킬: `{project}/.omc/skills/*.md` (높은 우선순위)
   - 글로벌 스킬: `~/.omc/skills/*.md`
   - 레거시 스킬: `~/.claude/skills/omc-learned/*.md`
   - 심볼릭 링크 해석 → 중복 파일 제거 (`realpathSync`)

3. **YAML 프론트매터 파싱** (`parseSkillFrontmatter`)
   - 각 `.md` 파일에서 `triggers:` 목록 추출
   ```yaml
   ---
   name: My Skill
   triggers:
     - keyword1
     - keyword2
   ---
   ```

4. **트리거 매칭 및 점수화**
   - 프롬프트(소문자) 안에 트리거 문자열이 포함되면 +10점
   - 이미 이 세션에서 주입된 스킬은 스킵
   - 점수 내림차순 정렬 → 최대 5개 선택

5. **`<mnemosyne>` 블록으로 포맷**
   ```xml
   <mnemosyne>
   ## Relevant Learned Skills
   ### Skill Name (scope)
   <skill-metadata>{"path":"...", "triggers":[...], "score":10}</skill-metadata>
   (스킬 본문)
   ---
   </mnemosyne>
   ```

6. **Flow Trace 기록** (best-effort) — 스킬 활성화 이벤트 기록

**출력:** `{ continue: true, hookSpecificOutput: { additionalContext: "<mnemosyne>..." } }` 또는 매칭 없으면 `{ continue: true }`

---

## ③ PreToolUse — 도구 실행 전 (매 도구 호출마다)

> **시점:** Claude가 도구(Read, Write, Edit, Bash, Task 등)를 호출하기 직전.
> **matcher:** `*` (모든 도구)

### 3-A. `pre-tool-enforcer.mjs` (timeout: 3s)

도구별 컨텍스트 리마인더를 주입하고, 진행 상태를 표시.

**입력:** stdin으로 `{ tool_name, cwd, session_id, toolInput }` 수신

**실행 순서:**

1. **도구명 추출** — `tool_name` 또는 `toolName` 필드

2. **Todo 상태 조회** (`getTodoStatus`)
   - 프로젝트 로컬 `{project}/.omc/todos.json`, `{project}/.claude/todos.json` 확인
   - `[N active, M pending]` 형태의 상태 문자열 생성
   - ⚠️ 글로벌 `~/.claude/todos/` 는 스캔하지 않음 (issue #354)

3. **Skill/Task 호출 기록** (`recordToolInvocation`) — best-effort
   - `Skill` 도구 호출 시 flow-tracer에 기록

4. **도구별 리마인더 메시지 생성** (`generateMessage`)

   | 도구 | 주입 메시지 |
   |------|-----------|
   | `TodoWrite` | "Mark todos in_progress BEFORE starting, completed IMMEDIATELY after finishing." |
   | `Bash` | "Use parallel execution for independent tasks. Use run_in_background for long operations." |
   | `Edit` / `Write` | "Verify changes work after editing. Test functionality before marking complete." |
   | `Read` | "Read multiple files in parallel when possible for faster analysis." |
   | `Grep` / `Glob` | "Combine searches in parallel when investigating multiple patterns." |
   | `Task` | 에이전트 스폰 메타데이터 포함 (아래 참조) |
   | 기타 | "The boulder never stops. Continue until all tasks complete." |

5. **Task/Agent 스폰 시 특수 처리** (`generateAgentSpawnMessage`)
   - `toolInput`에서 `subagent_type`, `model`, `description`, `run_in_background` 추출
   - `{project}/.omc/state/subagent-tracking.json`에서 현재 실행 중인 에이전트 수 조회
   - 예시 출력: `[2 active, 1 pending] Spawning agent: executor (sonnet) [BACKGROUND] | Task: Fix auth | Active agents: 3`

**출력:** `{ continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "[상태] 리마인더" } }`

> **핵심 역할:** 매 도구 호출 전에 "잊지 마" 리마인더를 주입하여 Claude가 TDD, 병렬 실행, 검증 등의 패턴을 지속적으로 따르도록 강제.

---

## ④ PermissionRequest — 권한 요청 (Bash 도구 전용)

> **시점:** Bash 명령 실행에 대해 사용자 승인을 요청하기 전.
> **matcher:** `Bash`

### 4-A. `permission-handler.mjs` (timeout: 5s)

위험한 명령에 대한 자동 권한 처리.

**실행 순서:**

1. stdin에서 데이터 파싱
2. `dist/hooks/permission-handler/index.js` → `processPermissionRequest(data)` 호출
3. 내부적으로 위험도 분석:
   - 파괴적 git 명령 (`git reset --hard`, `git push --force`)
   - 파일 시스템 삭제 (`rm -rf`)
   - 시스템 명령 등
4. 결과에 따라 auto-approve / warn / block 결정

**출력:** 권한 처리 결과 JSON

---

## ⑤ PostToolUse — 도구 실행 후 (매 도구 호출마다)

> **시점:** 도구가 실행을 완료한 직후.
> **matcher:** `*` (모든 도구)

### 5-A. `post-tool-verifier.mjs` (timeout: 3s)

실행 결과를 분석하고 적절한 후속 안내 제공.

**입력:** stdin으로 `{ tool_name, tool_response, session_id, cwd, tool_input }` 수신

**실행 순서:**

1. **세션 통계 업데이트** (`updateStats`)
   - `~/.claude/.session-stats.json` 에 도구별 호출 횟수 기록
   - 세션별로 `tool_counts`, `last_tool`, `total_calls`, `updated_at` 추적

2. **Bash 히스토리 기록** (Bash 도구만)
   - `~/.claude/.omc-config.json` 에서 `bashHistory` 설정 확인 (기본값: 활성)
   - 활성화 시 실행된 명령을 `~/.bash_history` 에 append
   - `#`으로 시작하는 주석 명령은 skip

3. **`<remember>` 태그 처리** (Task 도구만, `processRememberTags`)
   - 서브에이전트 출력에서 `<remember>내용</remember>` → **Working Memory**에 기록
   - `<remember priority>내용</remember>` → **Priority Context**에 기록 (컴팩션 생존)
   - `dist/hooks/notepad/index.js`의 `setPriorityContext()`, `addWorkingMemoryEntry()` 사용

4. **도구별 결과 분석** (`generateMessage`)

   | 도구 | 성공 시 | 실패 시 |
   |------|--------|--------|
   | `Bash` | 백그라운드 감지 시 "Remember to verify results" | "Command failed. Investigate the error" |
   | `Task` | 에이전트 완료 요약 (running/completed/failed 수) | "Task delegation failed" |
   | `Edit` | "Code modified. Verify changes work" | "Edit operation failed. Verify content matches" |
   | `Write` | "File written. Test the changes" | "Write operation failed. Check permissions" |
   | `TodoWrite` | 상태 변경별 안내 (created/completed/in_progress) | — |
   | `Read` | 10회 초과 시 "Consider using Grep" | — |
   | `Grep` | 0건 시 "Verify pattern syntax" | — |
   | `Glob` | 0건 시 "Verify glob syntax" | — |

5. **에러 패턴 감지** (`detectBashFailure`)
   - `error:`, `failed`, `permission denied`, `command not found`, `fatal:`, `abort` 등의 패턴 매칭

**출력:** 메시지 있으면 `{ continue: true, hookSpecificOutput: { additionalContext: "..." } }`, 없으면 `{ continue: true, suppressOutput: true }`

---

## ⑥ SubagentStart / SubagentStop — 서브에이전트 추적

> **시점:** 서브에이전트(Task 도구)가 시작/종료될 때.
> **matcher:** `*`

### 6-A. `subagent-tracker.mjs start` (timeout: 3s)

**실행:**
1. `dist/hooks/subagent-tracker/index.js` → `processSubagentStart(data)` 호출
2. `{project}/.omc/state/subagent-tracking.json` 에 에이전트 등록
   - `{ agent_type, status: "running", started_at, description }`
3. `total_spawned` 카운터 증가
4. Flow trace에 에이전트 시작 이벤트 기록

### 6-B. `subagent-tracker.mjs stop` (timeout: 5s)

**실행:**
1. `processSubagentStop(data)` 호출
2. 추적 파일에서 해당 에이전트 상태를 `"completed"` 또는 `"failed"` 로 업데이트
3. `total_completed` 또는 `total_failed` 카운터 증가
4. Flow trace에 에이전트 종료 이벤트 기록
5. 종료 시간, 실행 시간 기록

---

## ⑦ PreCompact — 컨텍스트 압축 전

> **시점:** 컨텍스트 윈도우가 가득 차서 자동 압축(compaction)이 시작되기 직전.
> **matcher:** `*`

### 7-A. `pre-compact.mjs` (timeout: 10s)

**실행:**
1. `dist/hooks/pre-compact/index.js` → `processPreCompact(data)` 호출
2. 현재 활성 모드 상태, Todo 리스트, 중요 컨텍스트를 압축 후에도 유지되도록 보존
3. notepad의 Priority Context가 압축 결과에 포함되도록 보장

## ⑧ Stop — Claude 응답 완료 (매 턴마다)

> **시점:** Claude가 응답을 마치고 멈추려 할 때.
> **matcher:** `*`
> **핵심:** 이 훅이 `{ decision: "block" }` 을 반환하면 Claude는 멈추지 않고 계속 작업.

### 8-A. `persistent-mode.cjs` (timeout: 10s)

범용 continuation 훅. ralph-state.json과 무관하게 독립적으로 동작한다.
Claude가 "~~~도 할까요?" 라고 묻고 멈추는 상황을 자동화 — Haiku가 마지막 출력을 읽어 다음 액션을 생성하고 자동으로 계속 실행시킨다.

**입력:** stdin으로 `{ cwd, session_id, stop_reason, transcript }` 수신

**실행 순서:**

1. **컨텍스트 리밋 체크** (`isContextLimitStop`)
   - `stop_reason`에 `context_limit`, `token_limit`, `max_tokens` 등 패턴이 있으면 → **즉시 continue** (차단하면 데드락 발생, issue #213)

2. **사용자 중단 체크** (`isUserAbort`)
   - `user_requested`, `aborted`, `cancel`, `interrupt`, `ctrl_c` 등 감지 → **즉시 continue**

3. **Priority 1: Planning 태스크 체크** (`readPlanningTasks`)
   - `.smelter/task/{기능명}.md` 파일들을 스캔
   - `- [ ]` (pending) 또는 `- [~]` (in_progress) 항목이 있으면 → **block**

4. **Priority 2: Claude 네이티브 태스크/Todo 체크**
   - `~/.claude/tasks/{sessionId}/*.json` (status: pending/in_progress)
   - `~/.claude/todos/{sessionId}.json`
   - `{project}/.smelter/todos.json`, `{project}/.claude/todos.json`
   - 미완료 항목이 있으면 → **block**

5. **Block 시: Haiku로 스마트 continuation 생성** (`generateSmartContinuation`)
   - transcript에서 마지막 Claude 출력 추출 (최대 2000자)
   - 남은 태스크 목록과 함께 `claude -p` (Haiku 모델)로 전달
   - Haiku가 구체적인 다음 액션 1-3문장 생성
   - 실패 시 정적 fallback 메시지 사용

**출력:** `{ decision: "block", reason: "[CONTINUATION] ..." }` 또는 `{ continue: true }`

---

### 8-B. `stop-e2e.mjs` (timeout: 120s)

프론트엔드 변경 사전 필터링 + AI 판단 기반 E2E 위임. 스크립트 단계에서 백엔드/테스트/스크립트 파일을 제외하고, 프론트엔드 변경 + 키워드 매칭된 E2E 테스트만 최소한으로 Claude에 위임한다. 토큰 절약을 위해 관련 없는 변경은 Claude에 전달하지 않는다.

**실행 순서:**

1. **세션 중복 방지** (마커 파일)
   - `/tmp/smelter-e2e-{projectHash}.marker` 존재 + 2시간 이내 → skip
   - 한 세션에서 한 번만 위임 (무한루프 방지)

2. **Playwright 설정 확인**
   - `playwright.config.ts` 또는 `.js` 없으면 → skip

3. **변경된 코드 파일 수집** (`getChangedFiles`)
   - `git diff --cached` + `git diff` + `git ls-files --others` → `.ts/.tsx/.js/.jsx`만

4. **프론트엔드 파일 필터링** (`isFrontendFile`)
   - 다음 패턴은 자동 제외 (백엔드/테스트/인프라):
     - `amplify/backend/function/` (Lambda)
     - `helpers/` (백엔드 헬퍼)
     - `scripts/` (빌드/배포 스크립트)
     - `e2e/` (E2E 테스트 자체)
     - `*.test.*`, `*.spec.*` (단위/통합 테스트)
     - `playwright.config.*`
   - 프론트엔드 변경 없으면 → skip (**토큰 0 소모**)

5. **키워드 기반 E2E 매칭** (`extractKeywords`)
   - 변경된 프론트엔드 파일 경로에서 키워드 추출 (예: `account`, `signup`, `cms`)
   - E2E 파일명에 키워드 포함 여부로 관련 테스트만 선별
   - 매칭 E2E 없으면 → skip

6. **마커 생성 + 최소 프롬프트 위임**
   - `{ decision: "block", reason: "[E2E CHECK] ..." }` — 프론트엔드 파일 + 매칭 E2E만 포함
   - Claude가 `npx playwright test <matched-files>` 실행
   - E2E 실패 시 Claude가 직접 수정

**출력:** exit code 0 (skip) 또는 exit code 2 (프롬프트 → Claude에게 판단 위임)

---

## ⑨ SessionEnd — 세션 완전 종료 (1회)

> **시점:** Claude Code 프로세스가 완전히 종료될 때.
> **matcher:** `*`

### 9-A. `session-end.mjs` (timeout: 10s)

**실행:**
1. `dist/hooks/session-end/index.js` → `processSessionEnd(data)` 호출
2. 세션 통계 최종 정리
3. 세션 로그 기록 (`sessions/YYYY-MM-DD.md` 등)
4. 임시 상태 파일 정리

---

## 전체 실행 흐름 — 시퀀스 다이어그램

```
사용자                    Claude Code                    Hook 스크립트들
  │                          │                               │
  │    [세션 시작]            │                               │
  │                          │──① SessionStart──────────────→│
  │                          │   session-start.mjs           │ 버전/HUD/상태 복원
  │                          │   session-start-linear.mjs    │ TDD+Caveman+Plan 주입
  │                          │←──(additionalContext)─────────│
  │                          │                               │
  │──"/ralph auth"──────────→│                               │
  │                          │──② UserPromptSubmit──────────→│
  │                          │   keyword-detector.mjs        │ "/ralph" 감지
  │                          │                               │ → harness-state / persistent-state 생성
  │                          │   skill-injector.mjs          │ 학습된 스킬 트리거 매칭
  │                          │←──(스킬 호출 지시)────────────│
  │                          │                               │
  │                          │──[Claude: Read 호출 결정]     │
  │                          │──③ PreToolUse(Read)──────────→│
  │                          │   pre-tool-enforcer.mjs       │ "[0 active, 3 pending] Read
  │                          │←──(리마인더)──────────────────│   multiple files in parallel"
  │                          │                               │
  │                          │──[Read 도구 실행]             │
  │                          │                               │
  │                          │──⑤ PostToolUse(Read)─────────→│
  │                          │   post-tool-verifier.mjs      │ 세션 통계 업데이트
  │                          │←──(결과 분석 메시지)──────────│
  │                          │                               │
  │                          │──[Claude: Task 호출 결정]     │
  │                          │──③ PreToolUse(Task)──────────→│
  │                          │   pre-tool-enforcer.mjs       │ "Spawning agent: executor
  │                          │←──(에이전트 메타 + 리마인더)──│   (sonnet) | Active: 0"
  │                          │                               │
  │                          │──④ PermissionRequest(Bash)?   │ (Bash 시에만)
  │                          │   permission-handler.mjs      │
  │                          │                               │
  │                          │──[Task 도구 실행 = 에이전트 생성]
  │                          │──⑥ SubagentStart─────────────→│
  │                          │   subagent-tracker.mjs start  │ 추적 파일에 등록
  │                          │                               │
  │                          │   ... (에이전트 작업 중) ...  │
  │                          │                               │
  │                          │──⑥ SubagentStop──────────────→│
  │                          │   subagent-tracker.mjs stop   │ 추적 파일 업데이트
  │                          │                               │
  │                          │──⑤ PostToolUse(Task)─────────→│
  │                          │   post-tool-verifier.mjs      │ <remember> 태그 처리
  │                          │                               │ 에이전트 완료 요약
  │                          │                               │
  │                          │──(더 많은 도구 호출 반복)     │
  │                          │   ③→실행→⑤→③→실행→⑤→...     │
  │                          │                               │
  │                          │  [컨텍스트 윈도우 가득 참]    │
  │                          │──⑦ PreCompact────────────────→│
  │                          │   pre-compact.mjs             │ 모드/tasker 상태 보존
  │                          │                               │
  │                          │  [Claude: 응답 완료]          │
  │                          │──⑧ Stop─────────────────────→│
  │                          │   persistent-mode.cjs         │ task/*.md 미완료 → Haiku가 다음 액션 생성
  │                          │←──{ decision: "block" }───────│ "[CONTINUATION] 구체적 다음 단계..."
  │                          │                               │
  │                          │──(계속 작업)──→ ③→⑤→③→⑤→...  │
  │                          │                               │
  │                          │  [Claude: 다시 응답 완료]     │
  │                          │──⑧ Stop─────────────────────→│
  │                          │   persistent-mode.cjs         │ 미완료 작업 있음 → BLOCK!
  │                          │   stop-e2e.mjs                │ 변경 파일 + E2E 목록 프롬프트 출력
  │                          │←──{ decision: "block" }───────│ Claude가 관련 E2E만 선택 실행
  │                          │                               │
  │                          │──(수정 반복)                   │
  │                          │                               │
  │                          │  [/cancel 호출로 모드 종료]   │
  │                          │──⑧ Stop─────────────────────→│
  │                          │   persistent-mode.cjs         │ 상태 파일 없음 → continue
  │                          │   stop-e2e.mjs                │ 변경 없음 → exit 0 (skip)
  │                          │←──{ continue: true }──────────│
  │                          │                               │
  │                          │──⑨ SessionEnd────────────────→│
  │                          │   session-end.mjs             │ 세션 로그, 통계 정리
  │←──[최종 응답]────────────│                               │
```

---

## 훅 스크립트 출력 프로토콜

모든 훅 스크립트는 stdout으로 JSON을 출력해야 함.

### 공통 필드

```json
{
  "continue": true,              // true = 계속 진행, false = 중단
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",     // 훅 이벤트명
    "additionalContext": "메시지"       // Claude 컨텍스트에 주입되는 텍스트
  },
  "suppressOutput": true         // true면 additionalContext 주입하지 않음
}
```

### Stop 훅 전용 필드

```json
{
  "decision": "block",           // "block" = Claude가 멈추지 않고 계속 작업
  "reason": "RALPH LOOP..."     // 왜 block하는지 Claude에게 전달되는 메시지
}
```

### SessionStart 특수 출력

```json
{
  "type": "system_prompt_prefix",    // 시스템 프롬프트 앞에 직접 삽입
  "content": "TDD + CAVEMAN + ..."
}
```

---

## 파일 경로 요약

| 스크립트 | 경로 | 훅 | 타임아웃 |
|---------|------|-----|---------|
| session-start.mjs | `~/.claude/scripts/` | SessionStart | 5s |
| session-start-smelter.mjs | `~/.claude/scripts/` | SessionStart | 5s |
| keyword-detector.mjs | `~/.claude/scripts/` | UserPromptSubmit | 5s |
| skill-injector.mjs | `~/.claude/scripts/` | UserPromptSubmit | 3s |
| pre-tool-enforcer.mjs | `~/.claude/scripts/` | PreToolUse | 3s |
| permission-handler.mjs | `~/.claude/scripts/` | PermissionRequest | 5s |
| post-tool-verifier.mjs | `~/.claude/scripts/` | PostToolUse | 3s |
| subagent-tracker.mjs | `~/.claude/scripts/` | SubagentStart/Stop | 3s/5s |
| pre-compact.mjs | `~/.claude/scripts/` | PreCompact | 10s |
| persistent-mode.cjs | `~/.claude/scripts/` | Stop | 10s |
| stop-e2e.mjs | `~/.claude/scripts/` | Stop | 120s |
| session-end.mjs | `~/.claude/scripts/` | SessionEnd | 10s |

---

## 상태 파일 맵

```
{project}/
├── .omc/
│   ├── state/
│   │   ├── harness-state.json        ← keyword-detector.mjs가 현재 command 상태 기록
│   │   └── subagent-tracking.json    ← subagent-tracker.mjs가 읽고 쓰기
│   ├── notepad.md                    ← session-start.mjs가 Priority Context 읽기
│   ├── todos.json                    ← pre-tool-enforcer가 읽기
│   └── skills/*.md                   ← skill-injector.mjs가 탐색
├── .smelter/
│   ├── task/{기능명}.md              ← persistent-mode.cjs Priority 1 (미완료 태스크 체크)
│   └── todos.json                    ← persistent-mode.cjs Priority 2 (Todo 체크)
├── .claude/
│   └── todos.json                    ← persistent-mode.cjs Priority 2 (Todo 체크)
│
~/.claude/
│   ├── .session-stats.json           ← post-tool-verifier.mjs가 읽고 쓰기
│   ├── .omc/update-state.json        ← session-start.mjs가 드리프트 알림 캐시
│   └── .omc/update-check.json        ← session-start.mjs가 npm 업데이트 캐시
│
~/.omc/
│   └── skills/*.md                   ← skill-injector.mjs가 글로벌 스킬 탐색
```
