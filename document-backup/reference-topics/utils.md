
## 🪨 Caveman 토큰 압축 통합

> [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) 기반. 출력 토큰 ~65-75% 절감, 기술 정확도 100% 유지.

| 항목 | 파일 | 상태 |
|------|------|------|
| Skill 정의 | `skills/caveman/SKILL.md` | ✅ |
| 타입 | `src/types.ts` — `HarnessRunOptions.caveman` | ✅ |
| 시스템 프롬프트 | `src/rules/defaults.ts` — `CAVEMAN_SYSTEM_PROMPT` | ✅ |
| 엔진 주입 | `src/engine.ts` — skill/agent 이후 caveman 프롬프트 prepend | ✅ |
| CLI 플래그 | `bin/cli.ts` — `--caveman [lite\|full\|ultra]` | ✅ |
| Public API | `src/index.ts` — `CAVEMAN_SYSTEM_PROMPT` export | ✅ |

```bash
smelter run --caveman "refactor auth module"         # full (기본)
smelter run --caveman lite "explain this function"   # ~40-50% 절감
smelter run --caveman ultra --model sonnet "debug"   # 최대 압축
smelter run --caveman --skill tdd "add login"        # 다른 옵션과 조합
```

lite 단일 모드 — 필러/헤징/인사말 제거, 관사+문법 유지:
```
Not: "Sure! I'd be happy to help. The issue is likely caused by..."
Yes: "Bug in auth middleware. Token expiry check uses < not <=. Fix:"
```

---

## 🧠 ECC 학습 시스템 (continuous-learning-v2)

> 학습 시스템은 `continuous-learning-v2`를 사용한다.

| 구성요소 | 경로 | 역할 |
|---------|------|------|
| `observe.sh` | `skills/continuous-learning-v2/hooks/observe.sh` | PreToolUse/PostToolUse 마다 JSONL 관찰 기록 |
| `config.json` | `skills/continuous-learning-v2/config.json` | 활성화: 5분마다 Haiku가 패턴 분석 |
| 관찰 저장소 | `~/.claude/homunculus/projects/{git-hash}/` | 프로젝트별 격리된 instinct YAML |
| `/instinct-status` | 커맨드 | 학습된 패턴 조회 |
| `/evolve` | 커맨드 | instinct → skill/command/agent 진화 |

**흐름**: 도구 호출 → observe.sh 기록 → 20개 관찰 후 Haiku 분석 → confidence 0.3~0.9 instinct 생성 → `/evolve`로 영구화

---

## 📋 Task Summary HUD — 터미널별 작업 요약 표시

> 각 Claude Code 터미널이 어떤 작업을 수행 중인지 HUD 두 번째 줄에 파란색으로 표시.

| 구성요소 | 경로 | 역할 |
|---------|------|------|
| `task-summarizer.mjs` | `scripts/task-summarizer.mjs` | `UserPromptSubmit` 훅 — 프롬프트 캐시 + Haiku 요약 워커 생성 |
| `statusline-hud.mjs` | `scripts/statusline-hud.mjs` | 캐시된 요약을 HUD 두 번째 줄에 파란색으로 표시 |
| 캐시 | `~/.claude/hud/task-summary/{cwdKey}.json` | cwd별 격리된 요약 캐시 (30분 TTL) |
| 테스트 | `scripts/test-task-summarizer.mjs` | E2E 테스트 (7개) |

### HUD 출력 형태

```
Opus 4.6  612k / 1.2M 50% | ctx 23%        ← 1줄: 모델 + 사용량 (기존)
다크모드 토글 추가                              ← 2줄: 작업 요약 (파란색)
```

### 실행 흐름

1. **UserPromptSubmit 훅** → `task-summarizer.mjs` 실행
2. 슬래시 커맨드(`/plan`, `/ralph` 등)와 짧은 입력(< 5자)은 무시
3. 원본 프롬프트를 `~/.claude/hud/task-summary/{cwdKey}.json`에 즉시 저장
4. 백그라운드 워커 프로세스 생성 → Haiku API로 한 줄 한국어 요약 요청 (최대 30자)
5. 워커가 응답 받으면 캐시 파일의 `summary` 필드 업데이트
6. `statusline-hud.mjs`가 주기적으로 캐시를 읽어 HUD에 표시

### 인증 체인 (별도 API 키 불필요)

| 순서 | 소스 | 설명 |
|------|------|------|
| 1 | `CLAUDE_CODE_OAUTH_TOKEN` 환경변수 | CI/CD, 컨테이너용 |
| 2 | macOS Keychain (`claude-code` 서비스) | macOS에서 자동 |
| 3 | `~/.claude/.credentials.json` | Linux/fallback |
| 4 | `ANTHROPIC_API_KEY` 환경변수 | 수동 설정 fallback |

인증 실패 시 AI 요약 대신 원본 프롬프트 앞 40자를 잘라서 표시 (graceful degradation).

### 캐시 파일 구조

```json
{
  "raw_prompt": "add dark mode toggle to settings page",
  "summary": "다크모드 토글 추가",
  "timestamp": "2026-04-14T12:00:00.000Z",
  "cwd": "/Users/yusang/my-project"
}
```
