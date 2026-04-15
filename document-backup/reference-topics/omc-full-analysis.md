---
title: OMC 하네스 시스템 전체 분석
type: topic
tags: [hanes, harness, omc, analysis, hooks, skills, agents, mcp, smelter]
created: 2026-04-11
updated: 2026-04-11
---

# OMC 하네스 시스템 전체 분석

> ← [[wiki/smelter/index|Harness Index]]
> **목적**: oh-my-claudecode(OMC) v4.0.10의 하네스 시스템 전체 분석. Hooks, Skills(39개), Agents(33개), MCP Tools, 실행 모드, 상태 관리.

---

## OMC 아키텍처 개요

OMC는 Claude Code 플러그인으로, hooks + skills + agents + MCP tools + 실행 모드를 레이어링하여 멀티 에이전트 오케스트레이션 시스템을 구축.

```
사용자 입력
    ↓
[UserPromptSubmit Hook] → 키워드/커맨드 감지 → 모드 활성화
    ↓
[Claude 실행] ← [PreToolUse Hook] 도구 사용 시마다 컨텍스트 주입
    ↓
[PostToolUse Hook] → 실패 감지, 통계 추적
    ↓
[Stop Hook] → 상태 파일 확인 → 미완료면 종료 차단
```

---

## 1. Hooks (핵심 메커니즘)

| Hook             | 스크립트                     | 역할                               | Smelter 적용         |
| ---------------- | ------------------------ | -------------------------------- | ----------------- |
| UserPromptSubmit | `keyword-detector.mjs`   | 프롬프트에서 키워드 감지 → 모드 활성화           | ✅ 필수 — E2E 자동 트리거 |
| UserPromptSubmit | `skill-injector.mjs`     | 학습된 스킬 자동 주입                     | ✅ 하네스 스킬 주입       |
| SessionStart     | `session-start.mjs`      | 모드 상태 복원, 버전 확인                  | ✅ 앱 시작 시 상태 복원    |
| PreToolUse       | `pre-tool-enforcer.mjs`  | 도구 사용 전 컨텍스트 주입 (병렬 실행, 파일 읽기 등) | ✅ E2E 강제 리마인더     |
| PostToolUse      | `post-tool-verifier.mjs` | 실패 감지, 통계 추적, `<remember>` 태그 처리 | ✅ E2E 결과 후처리      |
| Stop             | `persistent-mode.cjs`    | 상태 파일 확인 → 미완료면 종료 차단            | ✅ 자율 개발 루프 핵심     |
| PreCompact       | `pre-compact.mjs`        | 컴팩션 전 메모리 보존                     | ⭐ 선택적             |

### Hook 통신 방식
```
Hook 스크립트 (stdin: JSON) → 처리 → stdout: JSON
  → { continue: true, hookSpecificOutput: { additionalContext: "..." } }
  → additionalContext가 <system-reminder>로 Claude에 주입
```

---

## 2. Skills (39개)

### 핵심 실행 모드 (Smelter 포팅 대상)

| 스킬 | 트리거 | 동작 | Smelter 포팅 |
|------|--------|------|-----------|
| **autopilot** | "autopilot", "build me" | 5단계 파이프라인: 분석→설계→비평→실행→QA | ✅ E2E 파이프라인과 통합 |
| **ralph** | "ralph", "don't stop" | Stop hook으로 종료 차단, 반복 실행 | ✅ 자율 개발 루프 |
| **ultrawork** | "ulw", "ultrawork" | 병렬 에이전트 디스패치 | ✅ 멀티 패인 병렬 |
| **ecomode** | "eco", "budget" | 모델 티어 다운그레이드 (비용 절감) | ⭐ 선택적 |
| **swarm** | "swarm N agents" | SQLite 기반 태스크 큐 + 원자적 클레이밍 | ⭐ 고급 기능 |
| **ultraqa** | autopilot에서 활성화 | Build→Lint→Test→Fix 사이클 반복 | ✅ E2E 자동 수정 루프 |

### 계획/분석 스킬

| 스킬 | 역할 | Smelter 포팅 |
|------|------|-----------|
| plan | 전략적 계획 수립 | ⭐ 위키 연동 가능 |
| analyze | 깊은 분석/디버깅 | ⭐ 선택적 |
| deepsearch | 코드베이스 검색 | ⭐ 선택적 |
| tdd | TDD 워크플로우 강제 | ✅ E2E 강제와 유사 |
| code-review | 코드 리뷰 | ⭐ 선택적 |

### 유틸리티 스킬
cancel, note, learner, help, doctor 등 — 필요에 따라 포팅.

---

## 3. Agents (33개, 3-티어)

### 티어 시스템

| 티어 | 모델 | 비용 | 용도 |
|------|------|------|------|
| LOW | Haiku | $ | 단순 조회, 파일 찾기, 간단 수정 |
| MEDIUM | Sonnet | $$ | 기능 구현, 디버깅, 표준 작업 |
| HIGH | Opus | $$$ | 아키텍처, 복잡한 리팩토링, 전략 |

### 에이전트 정의 형식 (frontmatter YAML)
```yaml
---
name: executor
description: Focused task executor for implementation work (Sonnet)
model: sonnet
disallowedTools: []  # executor는 모든 도구 사용 가능
---
# 마크다운 지침
```

### Smelter에 포팅할 에이전트 패턴

| 역할 | Smelter 용도 |
|------|-----------|
| executor (low/med/high) | 코드 작성 |
| architect (low/med/high) | 설계 + 검증 |
| qa-tester | E2E 테스트 작성 |
| build-fixer | 빌드 에러 수정 |
| code-reviewer | 코드 리뷰 → 카드 생성 |

---

## 4. MCP Tools

| 서버 | 도구 수 | 핵심 도구 | Smelter 포팅 |
|------|---------|----------|-----------|
| **t** (Tools) | 26 | notepad, state, project-memory, LSP, ast-grep, python-repl | ✅ state + memory |
| **x** (Codex) | 5 | ask_codex, job management | ✅ 멀티모델 |
| **g** (Gemini) | 5 | ask_gemini, job management | ✅ 멀티모델 |

### 특히 유용한 도구
- **State 관리**: 모드 상태 파일 읽기/쓰기/클리어
- **Notepad**: 세션 메모리 (컴팩션 생존)
- **Project Memory**: 프로젝트 기술 스택, 컨벤션, 노트 저장

---

## 5. 상태 관리

### 상태 파일 형식
```json
{
  "active": true,
  "started_at": "2026-04-11T...",
  "original_prompt": "build a feature...",
  "reinforcement_count": 0,
  "last_checked_at": "2026-04-11T...",
  "iteration": 1
}
```

### 안전 장치
- 2시간 만료 타임아웃
- 컨텍스트 한계 감지 (컴팩션 허용)
- 최대 강화 횟수 제한
- Ctrl+C 감지

---

## 6. Smelter 포팅 우선순위

### Must-Have (P0)
1. **Stop-hook 영속성** — 상태 파일 + 종료 차단
2. **키워드 감지** — 프롬프트 스캔 → 모드 활성화
3. **E2E 자동 트리거** — 개발 완료 감지 → Playwright 실행
4. **Pre-tool 주입** — 도구 사용 시마다 E2E 리마인더

### High Value (P1)
5. **에이전트 티어 시스템** — low/med/high 모델 라우팅
6. **Notepad/메모리** — 세션 간 정보 보존
7. **Autopilot 파이프라인** — 분석→설계→실행→QA

### Medium (P2)
8. Ecomode, Swarm, Pipeline
9. LSP/AST 도구
10. 외부 AI 위임 (Codex/Gemini MCP)

---

## 관련 페이지

- [[wiki/smelter/omc-architecture]]
- [[wiki/smelter/archon-vs-omc]]
- [[wiki/archon/plan/12-harness-gui]]
- [[wiki/archon/topics/product-vision]]
