---
title: Claude & Codex Harness Structure
type: topic
tags: [ai-tools, claude-code, codex, harness, configuration, smelter]
created: 2026-04-09
updated: 2026-04-09
source_count: 1
---

# Claude & Codex Harness Structure

> ← [[wiki/smelter/index|Harness Index]]
> 폴더/MD 파일 기반으로 동작하는 모든 Claude Code & Codex CLI 확장 포인트 정리.

---

## 구조 비교 (한눈에)

| 기능 | Claude Code | Codex CLI |
|------|-------------|-----------|
| 전역 AI 지시 파일 | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` |
| 프로젝트 지시 파일 | `./CLAUDE.md` 또는 `./AGENTS.md` | `./AGENTS.md` |
| 에이전트 정의 | `~/.claude/agents/*.md` | `~/.codex/agents/*.toml` + `rules/*.md` |
| 스킬/워크플로우 | `~/.claude/skills/*/` | `~/.codex/skills/*/` |
| 규칙/코딩 표준 | `~/.claude/rules/` | `~/.codex/rules/` |
| 슬래시 커맨드 | `~/.claude/commands/*.md` | (skills에 통합) |
| 훅 설정 | `~/.claude/hooks/hooks.json` | `~/.codex/hooks.json` |
| 메인 설정 | `~/.claude/settings.json` | `~/.codex/config.toml` |
| 세션 메모리 | `.omc/notepad.md` (프로젝트별) | `~/.codex/memories/*.md` |

---

## Claude Code (`~/.claude/`)

| 경로 | 기능 | 설명 |
|------|------|------|
| `CLAUDE.md` | 전역 AI 지시 | 매 세션 시스템 프롬프트로 자동 주입 |
| `AGENTS.md` | 보조 전역 지시 | 플러그인 레이어; `./AGENTS.md` 프로젝트 루트도 인식 |
| `agents/*.md` | 서브 에이전트 페르소나 | `Task(subagent_type="...")` 로 호출 |
| `skills/*/` | 스킬 워크플로우 디렉토리 | 키워드 트리거 또는 슬래시 커맨드로 실행 |
| `skills/learned/` | 자동 캡처 스킬 | `/learner` 명령으로 생성 |
| `rules/common/*.md` | 공통 코딩 표준 | 모든 프로젝트에 적용 |
| `rules/<lang>/*.md` | 언어별 오버라이드 | 12개 언어; common 규칙을 오버라이드 |
| `commands/*.md` | 슬래시 커맨드 정의 | UI에서 `/commandname`으로 사용 (60개+) |
| `hooks/hooks.json` | 라이프사이클 훅 설정 | PreToolUse, PostToolUse, Stop |
| `scripts/` | 훅 자동화 스크립트 | hooks.json에서 호출하는 JS/shell 스크립트 |
| `settings.json` | 하네스 메인 설정 | 권한, 플러그인, MCP 허용 목록 |
| `settings.local.json` | 로컬 머신 오버라이드 | 같은 스키마; settings.json보다 우선 |
| `.omc-config.json` | OMC 런타임 설정 | 기본 실행 모드, 모델 라우팅, 에이전트 팀 |
| `hud/` | 상태줄 스크립트 | settings.json에서 참조하는 `omc-hud.mjs` |
| `mcp-configs/` | MCP 서버 프리셋 | `mcp-setup` 스킬에서 사용 |
| `plugins/` | 설치된 플러그인 에셋 | 마켓플레이스 플러그인 바이너리 및 설정 |
| `marketplace.json` | 플러그인 패키지 매니페스트 | 플러그인 패키지 메타데이터 선언 |

### 훅 타입 3종

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node ~/.claude/scripts/pre-bash.mjs" }] }],
    "PostToolUse": [...],
    "Stop": [...]
  }
}
```

| 타입 | 시점 | 용도 |
|------|------|------|
| `PreToolUse` | 도구 실행 전 | 검증, 차단 가능 |
| `PostToolUse` | 도구 실행 후 | 자동 포맷, 린트 |
| `Stop` | 세션 종료 시 | 최종 확인 |

---

## Codex CLI (`~/.codex/`)

| 경로 | 기능 | 설명 |
|------|------|------|
| `AGENTS.md` | 전역 AI 지시 | CLAUDE.md 상당; config.toml의 `developer_instructions`에서 참조 |
| `agents/*.toml` | 서브 에이전트 역할 정의 | 구조적 설정 (model, rules_file, temperature) |
| `rules/*.md` | 에이전트별 지침 파일 | `.toml`에 페어링되는 자연어 규칙 |
| `skills/*/` | 스킬 워크플로우 디렉토리 | `$skillname` 키워드 라우팅으로 실행 |
| `memories/*.md` | 에이전트별 영속 메모리 | 세션 간 연속성 — 세션 시작 시 자동 로드 |
| `prompts/*.md` | 에이전트별 프롬프트 템플릿 | AGENTS.md 권한 하의 좁은 실행 서페이스 |
| `hooks.json` | 라이프사이클 훅 설정 | SessionStart, PreToolUse, PostToolUse, **UserPromptSubmit**, Stop |
| `config.toml` | Codex 메인 설정 | 모델, 컨텍스트 윈도우, trust 레벨, notify 훅 |

### Codex 에이전트 이중 구조

```toml
# ~/.codex/agents/architect.toml
role = "architect"
model = "o3"
rules_file = "architect.md"
temperature = 0
```

```markdown
# ~/.codex/rules/architect.md
You are a senior software architect...
```

### Codex memories — Claude에 없는 기능 ⭐

```markdown
# ~/.codex/memories/architect.md
- 이 프로젝트는 모노레포 (Turborepo)
- DB: PostgreSQL + Redis
- API 스타일: REST + tRPC 혼용
```
에이전트별로 세션 간 기억 유지. Claude는 프로젝트별 `.omc/notepad.md`로 유사 기능 제공.

---

## 프로젝트 루트 (Repo Root)

| 파일/폴더 | Claude | Codex | 설명 |
|----------|--------|-------|------|
| `./CLAUDE.md` | ✅ | ❌ | Claude 전용 프로젝트 지시 |
| `./AGENTS.md` | ✅ | ✅ | **양쪽 동시 인식** — 하나로 두 도구 제어 |
| `./.claude/settings.json` | ✅ | ❌ | 프로젝트별 Claude 설정 |
| `./.codex/skills/` | ❌ | ✅ | 프로젝트 스코프 스킬 (전역 심링크) |
| `./.omc/notepad.md` | ✅ | ❌ | OMC 세션 메모 |
| `./.omc/project-memory.json` | ✅ | ❌ | OMC 영속 프로젝트 메모리 |

> **핵심:** `./AGENTS.md` 하나로 Claude Code와 Codex CLI 양쪽을 동시에 제어 가능.

---

## Rules 오버라이드 우선순위

```
~/.claude/rules/common/*.md          ← 기본값 (모든 프로젝트)
~/.claude/rules/<language>/*.md      ← 언어별 오버라이드 (충돌 시 우선)
./CLAUDE.md 또는 ./AGENTS.md          ← 프로젝트별 (가장 좁은 범위, 최우선)
```

---

## 새 기능 추가 — 빠른 설정

```bash
# Claude 서브 에이전트 추가
echo "# MyAgent\nYou are..." > ~/.claude/agents/my-agent.md

# 슬래시 커맨드 추가
echo "# mycommand\nDo X when invoked..." > ~/.claude/commands/mycommand.md

# 스킬 추가 (Claude + Codex 공통 패턴)
mkdir ~/.claude/skills/my-skill && echo "# My Skill\n..." > ~/.claude/skills/my-skill/prompt.md

# 프로젝트 공용 지시 (Claude + Codex 동시 인식)
echo "# Project Instructions\n..." > ./AGENTS.md

# Codex 에이전트 추가 (이중 구조)
echo 'role="myrole"\nmodel="o3"' > ~/.codex/agents/my-agent.toml
echo "# MyAgent\nYou are..." > ~/.codex/rules/my-agent.md

# Codex 에이전트 메모리 설정
echo "# Context\n- Stack: Next.js + Supabase" > ~/.codex/memories/my-agent.md
```

---

## 🎯 우리가 해야 할 일 (Action Items)

> 현재 하네스 구조를 제대로 활용하기 위한 구체적인 작업 목록.

---

### 1. 🪝 Hooks — 자동화 품질 게이트

**목표:** 코드 변경 시 테스트/빌드/린트가 자동으로 돌아가도록.

| 우선순위    | 훅                  | 시점                        | 내용                                                |
| ------- | ------------------ | ------------------------- | ------------------------------------------------- |
| 🔴 High | `pre-commit` 빌드 체크 | `PreToolUse(Bash)`        | `git commit` 전 `tsc --noEmit` / `gradle build` 실행 |
| 🔴 High | 테스트 자동 실행          | `PostToolUse(Edit/Write)` | 파일 저장 후 해당 모듈 테스트 자동 트리거                          |
| 🟡 Med  | 린트/포맷              | `PostToolUse(Edit)`       | ESLint, ktlint, prettier 자동 적용                    |
| 🟡 Med  | 시크릿 스캔             | `PreToolUse(Write)`       | API 키/비밀번호 하드코딩 감지 후 차단                           |
| 🟢 Low  | 컨텍스트 압축 알림         | `Stop`                    | 세션 종료 시 중요 결정사항 notepad에 자동 저장                    |

**설정 방식:**
- `~/.claude/hooks/hooks.json` 에 훅 정의
- 실제 스크립트는 `~/.claude/scripts/` 에 작성
- **심볼릭 링크로 프로젝트 공유**: `~/.codex/hooks.json`도 동일 스크립트 참조하도록 연결 → Claude + Codex 양쪽에서 같은 품질 게이트 적용

```bash
# 공통 스크립트를 Claude 훅에서도 Codex 훅에서도 같이 참조
~/.claude/scripts/check-build.mjs   ← 실제 로직
~/.codex/hooks.json                  ← 동일 스크립트 경로 참조
```

---

### 2. 🤖 Sub-agents — 코딩 특화 에이전트

**목표:** 우리 프로젝트 스택에 맞는 에이전트를 추가/커스터마이징.

| 상태 | 에이전트 | 파일 | 해야 할 일 |
|------|---------|------|-----------|
| ❌ 없음 | `next-reviewer` | `~/.claude/agents/next-reviewer.md` | Next.js App Router 패턴, RSC/RCC 구분, Suspense 경계 리뷰 전문 |
| ❌ 없음 | `kotlin-android` | `~/.claude/agents/kotlin-android.md` | Jetpack Compose, ViewModel, Coroutine 패턴 전문 |
| ❌ 없음 | `supabase-reviewer` | `~/.claude/agents/supabase-reviewer.md` | RLS 정책, Edge Functions, DB 마이그레이션 리뷰 |
| ❌ 없음 | `pr-summarizer` | `~/.claude/agents/pr-summarizer.md` | PR 설명 자동 생성 — 커밋 히스토리 → 한국어 PR body |
| ⚠️ 보완 | `code-reviewer` | `~/.claude/agents/code-reviewer.md` | 우리 팀 컨벤션 (immutability, 파일 크기 등) 추가 |
| ⚠️ 보완 | `architect` | `~/.claude/agents/architect.md` | 현재 프로젝트 스택 컨텍스트 (Next.js + Kotlin + Supabase) 주입 |

**에이전트 MD 작성 포인트:**
```markdown
# next-reviewer

You are an expert Next.js App Router code reviewer...

## 우리 프로젝트 컨벤션
- Server Component 기본, Client Component는 `"use client"` 명시
- fetch는 항상 revalidate 옵션 포함
- ...
```

---

### 3. 📚 Skills — 반복 워크플로우 자동화

**목표:** 자주 쓰는 작업 패턴을 스킬로 등록해 `/명령어` 하나로 실행.

| 상태 | 스킬 이름 | 트리거 | 내용 |
|------|---------|--------|------|
| ❌ 없음 | `feature-start` | `/feature-start` | 브랜치 생성 → AGENTS.md 확인 → 태스크 리스트 생성까지 |
| ❌ 없음 | `pr-ready` | `/pr-ready` | 테스트 실행 → 린트 → PR body 자동 생성 → 푸시 |
| ❌ 없음 | `db-migrate` | `/db-migrate` | Supabase 마이그레이션 생성 → 리뷰 → 적용 |
| ❌ 없음 | `deploy-check` | `/deploy-check` | 빌드 → E2E → Vercel 배포 상태 확인 |
| ❌ 없음 | `review-all` | `/review-all` | 코드 리뷰 + 보안 리뷰 + 타입 체크 병렬 실행 |

---
