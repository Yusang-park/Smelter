---
title: oh-my-claudecode 아키텍처 분석
type: topic
tags: [ai-tools, claude-code, oh-my-claudecode, harness, hooks, skills, agents, mcp, smelter]
created: 2026-04-10
updated: 2026-04-10
source_count: 1
---

# oh-my-claudecode 아키텍처 분석

> ← [[wiki/smelter/index|Harness Index]]
> Claude Code 플러그인 시스템 위에 동작하는 멀티에이전트 오케스트레이션 하네스.  
> 모든 지능은 마크다운 프롬프트 파일에, Node.js 코드는 순수 인프라만 담당하는 구조.

---

## 전체 디렉토리 구조

```
oh-my-claudecode/
├── .claude-plugin/           # Claude Code 마켓플레이스 플러그인 메타데이터
│   ├── plugin.json           # 플러그인 선언 (name, skills 경로, mcpServers)
│   └── marketplace.json
├── .mcp.json                 # MCP 서버 설정 (서버 "t": bridge/mcp-server.cjs)
├── CLAUDE.md                 # 오케스트레이터에 주입되는 마스터 프롬프트
├── AGENTS.md                 # 에이전트 카탈로그 요약
│
├── agents/                   # 에이전트 정의 (각 1개 .md 파일, 총 19개)
├── skills/                   # 스킬 정의 (각 하위폴더의 SKILL.md, 총 36개)
├── hooks/
│   └── hooks.json            # Claude Code 훅 이벤트 → 스크립트 매핑
├── scripts/                  # 훅에서 실행되는 Node.js 스크립트들
│
├── src/                      # TypeScript 소스
│   ├── mcp/omc-tools-server.ts   # 인프로세스 MCP 서버
│   ├── hooks/                    # TypeScript 훅 구현체 (30+ 모듈)
│   └── tools/                    # MCP 도구 구현 (LSP, AST, State, Notepad 등)
│
└── bridge/
    ├── mcp-server.cjs        # MCP 서버 진입점
    ├── cli.cjs               # `omc` CLI 진입점
    └── team-bridge.cjs
```

---

## 핵심 설계 원칙

> **코드와 지시사항의 완전한 분리**
> - 모든 지능 = 마크다운 파일 (SKILL.md, agents/*.md, CLAUDE.md)
> - Node.js/TypeScript = 순수 인프라 (상태 파일 I/O, 키워드 감지, 도구 노출)

---

## 1. 스킬 시스템

스킬은 **순수 마크다운 프롬프트 파일**. 코드 없음.

### 파일 형식

```yaml
# skills/ultrawork/SKILL.md
---
name: ultrawork
description: Parallel execution engine for high-throughput task completion
level: 4
---
## When Activated
YOU ARE AN ORCHESTRATOR. Spawn multiple parallel agents...
```

### 스킬 실행 경로 (2가지)

**경로 A — 키워드 자동 감지 (UserPromptSubmit 훅)**

```
사용자 입력 → keyword-detector.mjs
  → SKILL.md 파일 읽기
  → hookSpecificOutput.additionalContext에 주입
  → Claude가 시스템 컨텍스트 앞에 삽입된 내용 수신
```

`keyword-detector.mjs` 핵심 패턴:
```javascript
function createSkillInvocation(skillName, originalPrompt) {
  const skillContent = loadSkillContent(skillName); // SKILL.md 직접 읽기
  return `[MAGIC KEYWORD: ${skillName.toUpperCase()}]\n\n${skillContent}\n\n---\nUser request:\n${originalPrompt}`;
}
```

**경로 B — `/oh-my-claudecode:name` 슬래시 명령**

### 스킬 계층 구조

```
autopilot (5단계 파이프라인)
 └── ralph (지속성 루프, PRD 기반 스토리 추적)
      └── ultrawork (독립 태스크 병렬 실행 엔진)
           └── executor 에이전트 × N
```

---

## 2. 에이전트 정의 방식

에이전트 = `agents/<name>.md` 마크다운 파일. frontmatter에 모델과 도구 제한 선언.

```yaml
---
name: explore
description: Codebase search specialist
model: claude-haiku-4-5      # 모델 고정
disallowedTools: Write, Edit  # 금지 도구
level: 3
---
<Agent_Prompt>
  <Role>...</Role>
  <Constraints>...</Constraints>
</Agent_Prompt>
```

### 에이전트 티어 매트릭스

| 도메인 | LOW (Haiku) | MEDIUM (Sonnet) | HIGH (Opus) |
|-------|-------------|-----------------|-------------|
| 분석 | `architect-low` | `architect-medium` | `architect` |
| 실행 | `executor-low` | `executor` | `executor-high` |
| 탐색 | `explore` | `explore-medium` | `explore-high` |
| 리서치 | `researcher-low` | `researcher` | - |
| 프론트엔드 | `designer-low` | `designer` | `designer-high` |

호출: `Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")`

---

## 3. 훅 시스템

`hooks/hooks.json` 하나가 모든 훅 이벤트를 정의.

### 이벤트 → 스크립트 매핑

| 훅 이벤트 | 스크립트 | 역할 |
|-----------|---------|------|
| `UserPromptSubmit` | `keyword-detector.mjs`, `skill-injector.mjs` | 키워드 감지, 스킬 주입 |
| `SessionStart` | `session-start.mjs`, `project-memory-session.mjs` | 세션 초기화, 메모리 로드 |
| `PreToolUse` | `pre-tool-enforcer.mjs` | 도구 사용 전 검증 |
| `PostToolUse` | `post-tool-verifier.mjs` | 도구 실행 후 검증 |
| `SubagentStart` | `subagent-tracker.mjs start` | 서브에이전트 추적 시작 |
| `SubagentStop` | `subagent-tracker.mjs stop`, `verify-deliverables.mjs` | 완료 검증 |
| `Stop` | `persistent-mode.cjs` | ralph 루프 지속 강제 |
| `PreCompact` | `pre-compact.mjs` | 컨텍스트 압축 전 저장 |
| `SessionEnd` | `session-end.mjs` | 세션 종료 처리 |

### 훅 실행 패턴

```javascript
// hooks.json
{
  "type": "command",
  "command": "node \"$CLAUDE_PLUGIN_ROOT\"/scripts/run.cjs \"$CLAUDE_PLUGIN_ROOT\"/scripts/<script>.mjs",
  "timeout": 3  // 초
}
// stdin → 훅 이벤트 JSON / stdout → 훅 응답 JSON
```

---

## 4. 멀티에이전트 상태 추적

### 상태 파일 위치

```
{worktree}/.omc/state/
├── ralph-state.json
├── ultrawork-state.json
├── autopilot-state.json
└── sessions/{sessionId}/
    ├── ralph-state.json
    └── ultrawork-state.json
```

### ralph-state.json 구조

```json
{
  "active": true,
  "iteration": 1,
  "max_iterations": 100,
  "started_at": "2026-04-10T...",
  "prompt": "원본 사용자 요청",
  "session_id": "abc123",
  "linked_ultrawork": true,
  "last_checked_at": "2026-04-10T..."
}
```

### ralph 루프 강제 메커니즘

```
Claude 응답 완료 → Stop 훅 → persistent-mode.cjs
  → ralph-state.json 읽기 → active: true 확인
  → additionalContext: "The boulder never stops"
  → Claude가 다음 iteration 계속
```

`/oh-my-claudecode:cancel` = 상태 파일 삭제 → 루프 종료

---

## 5. MCP 서버 구조

```
bridge/mcp-server.cjs → src/mcp/omc-tools-server.ts
```

`@anthropic-ai/claude-agent-sdk`의 `createSdkMcpServer` 사용.

| 카테고리 | 도구 | 내용 |
|---------|------|------|
| LSP | 12개 | hover, goto_definition, find_references, diagnostics 등 |
| AST | 2개 | ast_grep_search, ast_grep_replace |
| State | N개 | state_read/write/clear/list_active |
| Notepad | N개 | notepad_read/write_priority/write_working |
| Memory | N개 | project_memory_read/write/add_note |
| Python | 1개 | python_repl |

---

## 6. 전체 실행 흐름

```
[사용자 입력]
     ↓ UserPromptSubmit 훅
[keyword-detector.mjs]
  ├─ 키워드 감지 → SKILL.md 주입 + .omc/state/*.json 생성
     ↓ Claude 오케스트레이터 (CLAUDE.md 기반)
[스킬 지시에 따라 Task() 호출]
     ↓ SubagentStart 훅
[에이전트 (agents/*.md 프롬프트 + MCP 도구)]
     ↓ SubagentStop 훅 → verify-deliverables.mjs
[Stop 훅]
[persistent-mode.cjs]
  ├─ active=true → "The boulder never stops" → 루프 지속
  └─ active=false → 종료
```

---

## 관련 페이지

- [[wiki/external-harness-analysis/claude-codex-harness-structure]]
- [[wiki/external-harness-analysis/oh-my-openagent-architecture]]
- [[wiki/hanes/topics/gui-harness-design]]
