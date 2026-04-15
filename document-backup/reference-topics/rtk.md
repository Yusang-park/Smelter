---
title: RTK — CLI 프록시로 LLM 토큰 60-90% 절감
type: reference
tags: [rtk, token, proxy, cli, rust, claude-code, token-reduction, reference]
created: 2026-04-13
updated: 2026-04-13
repo: https://github.com/rtk-ai/rtk
site: https://www.rtk-ai.app/
---

# RTK — CLI 프록시로 LLM 토큰 60-90% 절감

> ← [[wiki/libraries/index|Libraries Index]]
> bash 명령어 출력을 LLM에 넘기기 전에 **필터링·압축·정규화**해서 토큰을 줄이는 CLI 프록시. Rust 단일 바이너리, 의존성 0.

---

## 핵심 개념

```
Claude Code가 git status 실행
      ↓  (PreToolUse hook이 투명하게 재작성)
rtk git status 실행
      ↓
압축된 출력 → Claude에게 전달
```

Claude는 재작성된 사실을 모름. 그냥 작고 깔끔한 출력을 받을 뿐.

---

## 압축 전략 (4가지)

| 전략 | 설명 |
|------|------|
| **Smart Filtering** | 주석, 보일러플레이트 제거 |
| **Grouping** | 유사 항목 집계 (디렉토리별 파일, 에러 타입별 그룹) |
| **Truncation** | 관련 컨텍스트 유지하며 중복 제거 |
| **Deduplication** | 반복 로그 라인 → `N번 반복` 형태로 압축 |

---

## 절감 예시

| 명령어 | 일반 출력 | RTK 출력 | 절감 |
|--------|----------|---------|------|
| `git status` | ~3,000 토큰 | ~600 토큰 | **-80%** |
| `cargo test` | ~25,000 토큰 | ~2,500 토큰 | **-90%** |
| `ls` / `tree` | ~2,000 토큰 | ~400 토큰 | **-80%** |
| `cat` / `read` | ~40,000 토큰 | ~12,000 토큰 | **-70%** |
| **30분 세션 합계** | **~118,000** | **~23,900** | **-80%** |

실제 사례: 한 유저가 2주 동안 Claude Code 세션에서 **10M 토큰(89%) 절감** ([kilocode discussion](https://github.com/Kilo-Org/kilocode/discussions/5848))

---

## 설치

```bash
# Homebrew (추천)
brew install rtk

# Cargo
cargo install --git https://github.com/rtk-ai/rtk

# curl (Linux/macOS)
curl -sSf https://rtk-ai.app/install.sh | sh
```

### Claude Code 훅 등록

```bash
rtk init -g
```

`~/.claude/settings.json`에 PreToolUse 훅 자동 등록. 이후 모든 Bash 호출에서 자동 적용.

---

## 지원 명령어 (100+)

| 카테고리 | 명령어 |
|---------|--------|
| 파일 | `rtk ls`, `rtk read`, `rtk find`, `rtk grep`, `rtk diff` |
| Git | `rtk git status`, `rtk git log`, `rtk git diff`, `rtk git push/pull` |
| 테스트 | `rtk test cargo test`, `rtk pytest`, `rtk go test`, `rtk vitest run` |
| 빌드/린트 | `rtk tsc`, `rtk cargo build`, `rtk lint`, `rtk ruff check` |
| 클라우드 | `rtk aws ...`, `rtk docker ps`, `rtk kubectl pods` |
| 패키지 | `rtk pnpm list`, `rtk pip list` |

---

## 모니터링 명령어

```bash
rtk gain             # 토큰 절감 통계 (ASCII 그래프)
rtk gain --history   # 최근 명령어 히스토리
rtk discover         # 놓친 절감 기회 탐지
rtk session          # 최근 세션 RTK 적용 현황
```

---

## 지원 AI 도구

| 도구 | 설치 명령어 | 방식 |
|------|-----------|------|
| **Claude Code** | `rtk init -g` | PreToolUse 훅 |
| Cursor | `rtk init -g --agent cursor` | hooks.json |
| Gemini CLI | `rtk init -g --gemini` | BeforeTool 훅 |
| Windsurf | `rtk init --agent windsurf` | .windsurfrules |
| Cline / Roo Code | `rtk init --agent cline` | .clinerules |

---

## ⚠️ 주의사항

- 훅은 **Bash tool 호출에만** 적용됨
- Claude Code 내장 툴 (`Read`, `Grep`, `Glob`)은 훅 우회 → 해당 워크플로우는 직접 `rtk` 명령어 사용 필요
- `--ultra-compact` 플래그로 최대 압축 가능 (ASCII 아이콘 + 인라인 포맷)

---

## Caveman과 비교

| | RTK | Caveman |
|-|-----|---------|
| **대상** | 명령어 **출력** (bash stdout) | LLM **응답** 텍스트 |
| **방식** | 출력 필터링·압축 | 응답 스타일 정규화 (필러 제거) |
| **절감** | 입력 토큰 60-90% | 출력 토큰 40-75% |
| **조합** | ✅ 함께 쓰면 효과 배가 | ✅ |

---

## 관련 페이지

- [[wiki/archon/topics/litellm|LiteLLM — LLM 백엔드 교체 프록시]]
- [[wiki/smelter/index|Smelter Index]]
