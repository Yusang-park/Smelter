# 릴리즈 노트 (한국어)

> 이 문서는 [`RELEASE_NOTES.md`](RELEASE_NOTES.md) (영문 canonical)의 한국어 번역본입니다.
> 영문이 항상 최신이며, 번역과 상충 시 영문을 따릅니다.

---

## v2.4.1 — E2E 실제 인터페이스 강제
**릴리즈**: 2026-04-20

E2E 스테이지 계약을 강화: `workflow-e2e`와 `workflow-verify` Phase 3는 **실제 사용자 인터페이스**(실 브라우저, 실 subprocess, 실 HTTP 포트, 실 DB 엔진, 실 hook stdin/stdout)를 구동해야 하며 surface별 artifact 파일을 남겨야 한다. 테스트 러너 stdout만으로는(`pnpm test`, `vitest run` 등) 유효한 E2E pass가 아니다.

### 강제 조항

- **`skills/workflow-e2e/SKILL.md`** — "테스트 러너 스테이지가 아님" 경고를 최상단에 배치하여 전면 재작성. Surface별 Real Interface Contract 표, "안 쳐주는 것" / "쳐주는 것" 섹션, artifacts 디렉터리 필수 레이아웃 포함.
- **Gate postcondition** 추가:
  - `real_interface_invoked: true`
  - `no_interface_mocks: true`
  - `per_surface_artifact_present: true`
- **`critic-watchdog.mjs` R11** (CRITICAL): `.smt/features/<slug>/artifacts/`에 허용 파일 타입(`.webm`, `.mp4`, `.png`, `.jpg`, `.log`, `.transcript`, `.json`, `.sql`, `.exit`)이 하나도 없을 때 E2E pass 기록을 시도하면 exit 2로 차단.
- **신규 fail cause**: `artifact_missing`, `mocked_interface`. 둘 다 `workflow-e2e` self-rerun(올바른 runner / mock 제거)으로 라우팅.
- **`skills/workflow-verify/SKILL.md`** — Phase 3를 "테스트 러너 phase가 아님"으로 명시; 동일한 per-surface artifact 요구.

### Surface별 실제 인터페이스

| Surface | 실 인터페이스 | 필수 artifact |
|---------|--------------|---------------|
| UI / Frontend | Playwright가 실 브라우저 구동 | 영상 (`.webm`) + 스크린샷 (`.png`) + console.log |
| CLI / Script | 실 subprocess (stdin, argv, exit code) | 명령 transcript (`.transcript`) |
| HTTP API | 실 서버 + 실 네트워크 요청 | 요청/응답 로그 |
| Database | 실 DB 엔진 (드라이버 stub 금지) | 쿼리 로그 + before/after state |
| Hook script | 실 `cat payload \| node hook.mjs` 파이프 | input JSON + output JSON + exit code |

### 금지 사항

- `pnpm test` / `vitest run` / `jest` 단독 실행.
- 인터페이스 wrapper 없이 핸들러 함수 in-process 직접 호출.
- 검증 대상 surface를 mock (HTTP surface면 MSW, DB surface면 드라이버 stub 등).
- Playwright dry-run / `--list`.
- 외부 관측 가능한 side effect를 확인하지 않고 return value 검증.

### 스키마

- `CAUSE_ENUM`에 `artifact_missing`, `mocked_interface` 추가 (additive, 하위 호환).
- `SCHEMA_VERSION` → `2.4.1`.

### 문서

- `document/workflow.md` §8 — Real-Interface Contract 섹션 전문 추가; §3 Registry 10행 갱신.
- `document/workflow.md`는 이제 **영문 canonical**; 한국어 번역본은 `document/workflow.ko.md`.
- `RELEASE_NOTES.md`도 **영문 canonical**; 한국어는 `RELEASE_NOTES.ko.md`.
- 버전 `2.4.1`로 일괄 갱신: `plugin.json`, `.claude-plugin/plugin.json`, `package.json`, `CLAUDE.md`, `AGENTS.md`, `state-schema.mjs`.

### 테스트

- `mode-classifier.test.mjs`: 15/15
- `auto-confirm.test.mjs`: 51/51
- `workflow-scenarios.test.mjs`: 111/111
- R11 수동 smoke: 3/3 (artifact 부재 → 차단 / artifact 존재 → 허용 / 비 E2E stage → R11 미발화)

---

## v2.4.0 — `/verify` 모드 (테스트·점검 전용 엔트리)
**릴리즈**: 2026-04-20

비수정 검증 전용 모드 추가 — 테스트 + 정적 점검 + 실제 E2E 인터페이스를 한 번에 수행하고 단일 `verify_report.md`를 생성. "테스트 해봐" / "점검해"가 `/fix` 파이프라인으로 오분기되던 UX 공백을 해소.

### 신규

- **커맨드**: `/verify` — 비수정 검증 (Smelter 커맨드 셋의 6번째).
- **모드**: `verify` — 허용 스킬: `workflow-verify`, `workflow-e2e`, `workflow-e2e-review`, `workflow-human-check`.
- **스킬**: `workflow-verify` — 1회 실행으로 3 phase 수행:
  1. 테스트 코드 실행 (vitest/jest/pytest, 변경 surface scoped)
  2. 코드 로직 정적 점검 (tsc, eslint, state-schema, doc-sync)
  3. E2E 인터페이스 검증 (Playwright / API / CLI, 5-Surface Mapping 준수)
- **산출물**: `verify_report.md` — Phase별 breakdown + 종합 verdict.

### Classifier 변경

- `테스트 해봐 / 돌려봐 / 점검해 / 실행해 / run the tests / health check` → `/verify`
- `점검`은 `/investigate`에서 `/verify`로 **이동** (이유: 점검은 runtime 실행 의미; `/investigate`는 정적 읽기 전용).
- `검증 / 확인 / 체크 / verify / validate / check`는 `/investigate`에 **유지** (정적 read 의미).
- 체인 감지:
  - `테스트하고 고쳐` → `[verify, fix]`
  - `점검하고 수정해` → `[verify, fix]`
  - `run tests then fix` → `[verify, fix]`

### Producer chain

`workflow-verify`의 fail cause(`test_run` / `typecheck` / `lint` / `build` / `assertion`)는 `workflow-coding`으로 라우팅. `/verify` 모드는 coding을 whitelist하지 않으므로 `whitelist_violation` → 사용자 게이트 `/fix` 모드 업그레이드로 surface. 체인 입력이었다면 (`테스트하고 고쳐`) auto-confirm이 체인을 자동 진행.

### 스키마

- `SCHEMA_VERSION` → `2.4.0`
- `WORKFLOW_SKILLS` += `workflow-verify` (총 14개)
- `MODES` += `verify` (총 6개)

### 테스트

- `workflow-scenarios.test.mjs`: 111 시나리오 (skill/mode 카운트 14/6으로 갱신; 점검해 기대값 investigate→verify 이동; 테스트 해봐 / run the tests → verify 추가)
- `mode-classifier.test.mjs`: 15/15 (회귀 없음)
- `auto-confirm.test.mjs`: 51/51 (회귀 없음)
- 신규: `scripts/session-sim.mjs` — 종단 세션 시뮬레이터 (Stop/UserPromptSubmit/PostToolUse)

### 문서

- `document/workflow.md` §1-2에 verify 행 + investigate vs verify 가이드 추가; §3 Registry 13 → 14행.
- `document/implementation-v2.md`: "6 commands × 6 modes × 14 skills"
- `CLAUDE.md` / `AGENTS.md` / `README.md`: 6-command 표, 버전 `2.4.0`
- `plugin.json` / `.claude-plugin/plugin.json` / `package.json` → `2.4.0`

### 의미 정립

| 모드 | 읽음 | 실행 | 수정 |
|------|------|------|------|
| `/investigate` | ✅ | ❌ | ❌ |
| `/verify`      | ✅ | ✅ | ❌ |
| `/fix`, `/implement`, `/simple-fix`, `/plan` | ✅ | ✅ | ✅ |

`/verify`는 세 번째 카테고리의 빈 자리를 채움: 소스 수정 없는 동적 runtime 검증.

---

## v2.3.0 — 스킬 조합 워크플로우 엔진
**릴리즈**: 2026-04-20

Smelter v2.3.0은 고정 Step 1..10 파이프라인을 스킬 조합 모델로 대체한다. 5개 커맨드가 13개 `workflow-*` 스킬을 5개 모드로 조합한다. 실패는 producer chain을 따라 라우팅되며, 재시도는 없다. Auto-confirm은 queue-drop 패턴을 사용하므로 세션이 멈추지 않는다. Review 스킬은 3회 검증 라운드를 의무화한다. Iron Law는 hook으로 runtime 강제된다.

### 주요 변경

- **5개 커맨드** — `/plan`, `/implement`, `/fix`, `/simple-fix`, `/investigate`. 자연어 자동 라우팅(`scripts/mode-classifier.mjs`); 명시 slash 커맨드가 override. 복합 의도(예: `검증하고 수정해` → investigate → fix)도 감지·자동 전환.
- **13개 workflow 스킬** — 각 스킬은 `consumes → produces` 계약과 gate를 `skills/workflow-*/SKILL.md`에 선언. 모드는 스킬의 부분집합 + 진입점.
- **Producer chain 라우팅** (`scripts/route-on-fail.mjs`) — 재시도 없음. 실패 시 아티팩트를 생산한 상류 스킬로 라우팅. `severity` / `cause` / `active_feedback` 분기 인코딩; whitelist 위반은 사용자 게이트 mode upgrade.
- **Queue-drop auto-confirm** (`scripts/auto-confirm.mjs` + `scripts/auto-confirm-consumer.mjs`) — Stop hook이 `.smt/state/auto-confirm-queue.json`에 기록, UserPromptSubmit consumer가 다음 턴에 주입. 세션은 4가지 허용 조건(사용자 stop / human-check 대기 / mode-upgrade 결정 / 활성 state 부재)에서만 halt.
- **Multi-Pass Verification** — 모든 review 스킬이 pass 선언 전 3 라운드(`omission → contradiction → edge_case`) 수행. Anti-evasion 가드가 hook 강제.
- **Stall Cascade** (`scripts/stall-detector.mjs`) — 6개 시그널 + 4-Level cascade (Debugger → Producer reroute → Sub-tasker → Mode upgrade). Level 1-3은 사용자 개입 없이 해소; Level 4만 surface.
- **Team Agent Patterns (A-E)** — Specialist / Team Consensus / Parallel Delegation / Hierarchical / Adversarial Watchdog. 패턴 선택은 `state.team_runtime[skill].pattern`, `workflow-tasker`가 결정.
- **Critic Watchdog (Pattern E)** — 2 레이어: PostToolUse hook (`scripts/critic-watchdog.mjs`, 10 formal rules, CRITICAL=exit 2) + 주기적 semantic agent (`agents/critic-watchdog.md`, ReadOnly).
- **파일 기반 상태** — 모든 task는 `.smt/features/<slug>/task/<task>.state.json`을 schema v2.3.0으로 가짐. `scripts/state-schema.mjs`가 검증.

### Breaking changes (v1 → v2.3.0)

**v1 step-engine 인프라 제거**:
- `workflows/*.yaml` (build / fix / plan step DAG)
- `steps/step-*.md` (11 step 프롬프트)
- `presets/*.json` (build / fix / plan preset)
- `scripts/step-injector.mjs`, `scripts/step-tracker.mjs`
- `scripts/integration-workflow.test.mjs`, `step-engine.test.mjs`, `workflow-seeder.test.mjs`
- `scripts/lib/yaml-parser.mjs`
- `scripts/test-max-attempts.ts`, `test-queue-session-isolation.mjs`
- `commands/build.md` (→ `/implement`로 대체)
- `document-backup/` (legacy 스냅샷)

**커맨드 surface 변경**:
- `/build` → 퇴장. `/implement` (경량) 또는 `/plan` (신규 기능 / 리팩토링 기획 필요) 사용.
- 자연어 입력이 이제 자동 라우팅됨; classifier는 규칙 기반 (Iron Law #2 — 라우팅에 LLM 추론 금지).

**State 스키마**:
- 모든 feature는 `<task>.state.json` (schema 2.3.0) 사용. 잔존 `state/workflow.json`은 `scripts/feature-version-check.mjs`가 `orphan`으로 표시.

**용어**:
- "Step" → "skill"
- "워크플로우 엔진"은 이제 스킬 조합 엔진을 의미 (step-engine 아님).

### 마이그레이션

- `state/workflow.json`만 있는 feature 디렉터리는 `feature-version-check.mjs`가 `orphan` 표시. 이관: `scripts/state-schema.mjs`의 `createInitialState(...)`로 v2 `<task>.state.json` 생성.
- `/build` 호출은 `/implement` (기존 코드 기반 경량 빌드) 또는 `/plan` (greenfield / 기획 필요한 리팩토링)로 교체.
- 기존 `max_retry` 동작: producer chain 라우팅으로 대체. 필드 제거; 상류 실패는 자동으로 producer 스킬로 라우팅됨.

### 도구 & 감사

- 신규 테스트 스위트: `scripts/auto-confirm.test.mjs` (51 케이스), `scripts/mode-classifier.test.mjs` (15 케이스).
- `scripts/session-end.mjs` 체크: `EXPECTED_COMMANDS` 기반 doc-sync, `FORBIDDEN_COMMANDS` 기반 퇴장 커맨드 스캔, step-engine 디렉터리 스캔, magic keyword parity.
- 2026-04-20 5-pass 병렬 감사 완료 (scripts / skills-modes-commands / agents / docs / hooks): 10개 core agent 배치, Smelter core v1 잔존 0, hook target 17/17 resolve, plugin manifest 2.3.0 정합.

### 관련 문서

- Canonical 스펙: [`document/workflow.md`](document/workflow.md)
- 구현 레퍼런스: [`document/implementation-v2.md`](document/implementation-v2.md)
- 페이즈별 구현 현황: [`document/implementation.md`](document/implementation.md)
- 프로젝트 소개: [`document/Introduce.md`](document/Introduce.md)
- 루트 agent 지시: [`CLAUDE.md`](CLAUDE.md), [`AGENTS.md`](AGENTS.md)
