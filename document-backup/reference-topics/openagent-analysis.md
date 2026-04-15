---
title: oh-my-openagent 아키텍처 분석
type: topic
tags: [ai-tools, opencode, oh-my-openagent, harness, bun, typescript, multi-model, tmux, smelter]
created: 2026-04-10
updated: 2026-04-10
source_count: 1
---

# oh-my-openagent 아키텍처 분석

> ← [[wiki/smelter/index|Harness Index]]

> npm 패키지명 `oh-my-opencode`. **OpenCode** 플러그인으로 Claude / GPT / Kimi / GLM / Gemini 등 다중 모델을 오케스트레이션.  
> oh-my-claudecode가 "프롬프트 주입 레이어"라면, 이쪽은 SDK API를 직접 제어하는 "진짜 런타임 확장".

- 런타임: **Bun** (Node.js 아님)
- 언어: TypeScript ESM
- 플러그인 인터페이스: `@opencode-ai/plugin`, `@opencode-ai/sdk`

---

## oh-my-claudecode와의 근본적 차이

| 항목 | oh-my-claudecode | oh-my-openagent |
|-----|-----------------|-----------------|
| 기반 런타임 | Claude Code CLI | **OpenCode** (오픈소스) |
| 에이전트 실행 | `claude --print` subprocess | **`client.session.create()` 직접 호출** |
| 모델 지원 | Claude 전용 | Claude, GPT-5.4, Kimi K2.5, GLM-5, Gemini |
| 프로세스 모델 | 별도 프로세스 spawn | 동일 프로세스 내 SDK 호출 |
| 편집 도구 | str-replace 기반 | **Hashline(LINE#ID)** 자체 구현 |
| 시각화 | 없음 | tmux 패널 (xterm.js로 교체 가능) |

---

## 전체 디렉토리 구조

```
oh-my-openagent/
├── src/
│   ├── index.ts                   # 플러그인 진입점
│   ├── create-hooks.ts            # 훅 팩토리 (40개+)
│   ├── create-tools.ts            # 도구 팩토리
│   ├── create-managers.ts         # 매니저 팩토리
│   │
│   ├── agents/                    # 에이전트 정의 (TypeScript)
│   │   ├── sisyphus.ts            # 메인 오케스트레이터 (Opus/Kimi/GLM)
│   │   ├── hephaestus/            # 자율 딥워커 (GPT-5.4)
│   │   ├── prometheus/            # 전략 플래너
│   │   ├── oracle.ts              # 아키텍처/디버깅 전문가
│   │   └── dynamic-agent-prompt-builder.ts
│   │
│   ├── features/
│   │   ├── background-agent/      # 백그라운드 에이전트 관리 (핵심)
│   │   ├── tmux-subagent/         # tmux 패널 관리
│   │   ├── claude-code-agent-loader/   # Claude Code 에이전트 호환
│   │   ├── boulder-state/         # Ralph loop 상태
│   │   └── task-toast-manager/    # UI 알림
│   │
│   ├── hooks/                     # 40개+ 훅
│   ├── tools/
│   │   ├── hashline-edit/         # LINE#ID 기반 편집 (핵심 혁신)
│   │   ├── lsp/                   # LSP 클라이언트
│   │   ├── background-task/       # 백그라운드 태스크 도구
│   │   └── interactive-bash/      # tmux 인터랙티브 터미널
│   │
│   └── openclaw/                  # Discord/Telegram 게이트웨이
│       ├── dispatcher.ts          # HTTP/커맨드 디스패처
│       ├── reply-listener.ts      # 폴링 데몬 관리
│       └── daemon.ts              # 별도 프로세스 데몬
│
└── packages/                      # 플랫폼별 바이너리
```

---

## 에이전트 실행 방식

CLI subprocess가 **아님**. OpenCode SDK 세션 API를 직접 호출.

```typescript
// src/features/background-agent/spawner.ts

// 1. 새 세션 생성
const createResult = await client.session.create({
  body: { parentID: input.parentSessionID },
  query: { directory: parentDirectory },
})
const sessionID = createResult.data.id

// 2. 에이전트 + 모델 + 프롬프트 전송 (fire-and-forget)
promptWithModelSuggestionRetry(client, {
  path: { id: sessionID },
  body: {
    agent: "sisyphus",              // 에이전트 이름
    model: { providerID, modelID }, // Claude, GPT, Kimi 등
    parts: [{ type: "text", text: prompt }],
  },
}).catch(handleError)
```

`client` = `PluginInput["client"]` — OpenCode가 플러그인에 주입하는 내부 API 클라이언트.

---

## 멀티에이전트 상태 추적

### BackgroundManager (`features/background-agent/manager.ts`)

```typescript
tasks: Map<string, BackgroundTask>  // 태스크 상태 레지스트리

// POLLING_INTERVAL_MS 주기로 모든 세션 상태 폴링
const sessions = await client.session.list()
// SessionStatusMap 갱신
```

태스크 생명주기:
```
pending → running → completed
                  → error
                  → cancelled (stale timeout)
                  → interrupt
```

### Stale 감지 (`task-poller.ts`)

- `DEFAULT_STALE_TIMEOUT_MS` 이후 `progress.lastUpdate` 미갱신 → 자동 취소
- `sessionGone`: 세션이 `MIN_SESSION_GONE_POLLS` 연속 사라지면 소멸 판정 → `abortWithTimeout()`

### 동시성 제어 (`ConcurrencyManager`)

- `providerID/modelID` 단위 동시 실행 수 제한
- `acquire()` / `release()` 세마포어 패턴

---

## Hashline(LINE#ID) 편집 시스템

> 기존 str-replace의 "컨텍스트 이동 후 편집 실패" 문제를 해결한 핵심 혁신.

파일 읽기 시 자동으로 LINE#ID 삽입:
```
11#VK| function hello() {
22#XJ|   return "world";
33#MB| }
```

구현 (`hashline-edit/hash-computation.ts`):
```typescript
// xxHash32로 라인 내용 해시 → 256개 2글자 사전으로 인코딩
const hash = Bun.hash.xxHash32(stripped, seed)
return HASHLINE_DICT[hash % 256]  // "VK", "XJ", "MB" 등
```

에이전트가 `pos: "22#XJ"` 형태로 편집 앵커 지정 → 실행 전 해시 일치 검증 → 불일치 시 **편집 거부**.

---

## tmux 통합 (`features/tmux-subagent/`)

```typescript
// 백그라운드 에이전트 생성 시 tmux 패널 자동 오픈
onSubagentSessionCreated(sessionId) {
  const paneId = tmuxManager.openPane({
    title: `Agent: ${sessionId}`,
    layout: "grid"  // 패널 자동 배치
  })
  sessionToPaneMap.set(sessionId, paneId)
}
```

- `decideSpawnActions()`: 기존 패널 재사용 vs 신규 생성 결정
- `pane-state-querier.ts`: `tmux list-panes` 파싱으로 상태 폴링
- GUI 하네스라면 이 tmux 부분을 **xterm.js + WebSocket**으로 교체하면 됨

---

## 주요 훅 목록

| 훅 | 역할 |
|----|------|
| `hashline-read-enhancer` | 파일 읽기 결과에 LINE#ID 자동 삽입 |
| `preemptive-compaction` | 컨텍스트 한도 80% 전 자동 압축 |
| `todo-continuation-enforcer` | 미완료 Todo 있으면 에이전트 계속 강제 |
| `ralph-loop` | self-referential 루프 구현 |
| `model-fallback` | API 오류 시 fallback 모델 자동 전환 |
| `session-recovery` | 세션 에러/컨텍스트 초과 시 자동 복구 |
| `keyword-detector` | 키워드 감지 → 슬래시 커맨드 트리거 |
| `comment-checker` | AI 슬롭 주석 감지 후 제거 |

---

## openclaw — 외부 게이트웨이

Discord/Telegram 봇으로 원격 에이전트 제어.

```typescript
// dispatcher.ts — Bun spawn으로 커맨드 게이트웨이 실행
const proc = spawn(["sh", "-c", interpolated], {
  env: { ...process.env },
  stdout: "pipe",
})
```

- `daemon.ts`: 별도 백그라운드 프로세스로 폴링 루프
- `reply-listener.ts`: PID 파일 기반 데몬 수명주기 관리
- GUI 하네스의 "외부 알림" 참고 패턴

---

## Claude Code 호환성 레이어

```
src/features/claude-code-agent-loader/   # ~/.claude/agents/ 로드
src/features/claude-code-command-loader/ # Claude Code 슬래시 커맨드 로드
src/features/claude-code-mcp-loader/     # Claude Code MCP 설정 로드
src/features/claude-code-session-state/  # 서브에이전트 세션 ID 추적
```

---

## 관련 페이지

- [[wiki/external-harness-analysis/omc-architecture-analysis]]
- [[wiki/hanes/topics/gui-harness-design]]
