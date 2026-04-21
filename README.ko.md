<p align="center">
  <img src="assets/smelter-logo.svg" alt="Smelter" width="600" />
</p>

<p align="center">
  <strong>Claude Code용 스킬 조합 워크플로우 엔진 — TDD-first, 파일 기반, 멀티 에이전트.</strong>
</p>

<p align="center">
  <a href="#특징">특징</a> &middot;
  <a href="#커맨드">커맨드</a> &middot;
  <a href="#동작-방식">동작 방식</a> &middot;
  <a href="#iron-laws">Iron Laws</a> &middot;
  <a href="#철학">철학</a>
</p>

<p align="center">
  <code>v3.1.0</code>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a>
</p>

> 이 문서는 [`README.md`](README.md) (영문 canonical)의 한국어 번역본입니다. 영문이 항상 최신입니다.

---

## 설치

### 일반 사용자 (자동 업데이트)

```bash
claude plugin marketplace add Yusang-park/Smelter
claude plugin install smelter@smelter-marketplace
```

세션 시작 시 자동 업데이트.

### 개발자 (Smelter 자체 작업)

저장소 클론 후, 개발용 installer 1회 실행:

```bash
git clone https://github.com/Yusang-park/Smelter.git ~/Smelter
node ~/Smelter/scripts/dev-install.mjs
```

하는 일:
1. `~/.claude/{skills,commands,agents}` → `~/Smelter/{skills,commands,agents}` 심볼릭 링크. 편집이 즉시 반영.
2. `hooks/hooks.json`을 `~/.claude/settings.json`의 `hooks`로 merge. `${CLAUDE_PLUGIN_ROOT}`는 절대 경로로 치환. 항목은 `_smelter_dev_managed: true`로 태깅되어 재실행 시 중복 방지.
3. 운영 플러그인이 설치되어 있으면 실행 거부 (double-fire 방지). `--force`로 우회 가능.

플래그:
- `--dry-run`   — 미리보기, 쓰기 없음
- `--uninstall` — 개발 심볼릭 링크 + dev-managed hook만 제거
- `--force`     — plugin-conflict 검사 우회

활성화: 새 Claude Code 세션 시작 (hook은 session start 시 로드).

---

## 요약

- **5개 커맨드** (v3): `/think`, `/implement`, `/fix`, `/investigate`, `/verify`. 자연어 입력은 자동 라우팅 — 명시 slash 커맨드가 override. v2 `/plan` + `/simple-fix` 제거됨.
- **단일 통합 설정**: `modes/workflow.yaml`이 skills + pipelines + modes + target_type_routing + verification_rounds를 한 파일에 담음.
- **Target-type 분기 (v3.1)**: `/fix`가 `target_type` + 스코프 신호 기반으로 런타임에 파이프라인 선택 — `typo`/`dialogue` → `minimal` (4 스킬), 단순 `bug_fix` → `light` (8), 복잡 → `medium` (11). 사소한 fix의 tasker 오버헤드 제거.
- **14개 workflow 스킬**을 모드로 조합. 각 스킬은 `consumes → produces` 계약; 실패는 **producer chain**으로 라우팅 — 재시도 없음, 회피 없음, 자기 포기 없음.
- **8개 Iron Laws**는 hook (`auto-confirm`, `critic-watchdog`, `pre-tool-enforcer`)으로 runtime 강제.
- **Multi-Pass Verification (v3.1)**: 중간 리뷰 (brainstorm-review, investigate-review, tasker-review, agent-review) **2 라운드** (omission + contradiction). 종단 리뷰 (e2e-review, team-code-review, human-check) **3 라운드**.
- **파일 기반 상태**: 모든 task는 단일 `*.state.json`을 가짐. 에이전트는 메모리가 아닌 파일을 읽는다.
- **Commit gate (v3.1)**: `pre-tool-enforcer`가 `workflow-human-check` 통과 전까지 `git commit` 차단. Shell-unwrap으로 `bash -c`, env prefix, 절대경로 우회 방지.
- **Visual 아티팩트 렌더링 (v3.1)**: `workflow-human-check`이 `AskUserQuestion` 전에 모든 `.png`/`.jpg`/`.webm`을 `Read` tool로 인라인 표시.

---

## 특징

| # | 특징 | 제공 기능 |
|---|------|-----------|
| 1 | 자동 라우팅 모드 classifier | `scripts/mode-classifier.mjs`가 `"버그 고쳐줘"` → `/fix`, `"검증하고 수정해"` → `investigate → fix chain` 매핑 |
| 2 | Producer chain 라우팅 | 실패 시 엔진이 해당 artifact를 생산한 상류 스킬로 라우팅 — 무작정 재시도 *없음* |
| 3 | Auto-confirm (never-halt) | Stop hook이 `.smt/state/auto-confirm-queue.json`에 계속 진행 payload를 drop; `UserPromptSubmit` consumer가 다음 턴에 주입. 세션은 계속 진행 |
| 4 | 리스크 자동 태스크화 | 에이전트 응답에 "리스크", "TODO", "나중에" 등 키워드 감지 시 `sub-tasker`가 task를 자동 생성하여 우려사항 유실 방지 |
| 5 | Stall Cascade (4 레벨) | `scripts/stall-detector.mjs`가 6개 시그널 방출; Level 1은 ReadOnly `debugger` spawn, Level 2는 producer chain 리라우팅, Level 3는 blocker sub-task화, Level 4는 mode upgrade 요청 |
| 6 | Team Agent Patterns | A (Specialist) • B (95% Consensus: advocate + critic + arbitrator) • C (Parallel Delegation + Aggregator + Conflict-Resolver) • D (Hierarchical Lead + sub-agents) • E (Critic Watchdog) |
| 7 | Critic Watchdog (2 레이어) | Layer 1: `PostToolUse` hook, 11개 formal rules, CRITICAL = exit 2 (block). Layer 2: `workflow-coding` 중 매 5-10 tool call마다 semantic ReadOnly agent |
| 8 | Multi-Pass Verification | Review 스킬은 `omission → contradiction → edge_case` 라운드 수행; 3 라운드 pass 필수; 이전 라운드 결론 leak 없음 |
| 9 | Surface 기반 면제 | CSS / i18n / typo / dialogue surface는 TDD 자동 skip; 각 모드에 키워드 테이블 인코딩 |
| 10 | 파일 기반 단일 출처 | `.smt/features/<slug>/task/<task>.state.json` (schema v2.4.1)이 단일 진실 — 인메모리 상태 없음, 숨은 재시도 없음 |
| 11 | **E2E 실제 인터페이스 강제** | `workflow-e2e`와 `workflow-verify` Phase 3는 **실제 사용자 인터페이스**(실 브라우저, 실 subprocess, 실 HTTP 포트, 실 DB 엔진, 실 hook pipe)를 구동하고 surface별 artifact를 남겨야 함. 테스트 러너 stdout만으로는 pass 불가. Critic Watchdog R11 (CRITICAL)이 위반 차단 |

---

## 커맨드 (v3)

| 커맨드 | 모드 | 진입 스킬 | 파이프라인 | 사용 시점 |
|--------|------|-----------|------------|-----------|
| `/think`       | `think`       | `workflow-brainstorm` (deep)     | `planning_only`    | 기획+계획. 코드 변경 없음 (v2 `/plan`에서 이름 변경) |
| `/implement`   | `implement`   | `workflow-brainstorm` (light)    | `full` (13)        | 기존 코드 위에 빌드; 경량 인터뷰 |
| `/fix`         | `fix`         | `workflow-investigate`           | 런타임 선택       | 버그/로직 수리. `typo`/`dialogue` → `minimal` (4) · 단순 `bug_fix` → `light` (8) · 복잡 / `extend_existing` → `medium` (11) |
| `/investigate` | `investigate` | `workflow-investigate`           | `investigate_only` | 정적 읽기 (맥락·근거 파악); mode transition으로 종료 |
| `/verify`      | `verify`      | `workflow-verify`                | `verify_only`      | 비수정 검증 (테스트·점검·실 E2E 인터페이스를 1회에) |

v3 마이그레이션: `/plan` → `/think`. `/simple-fix`는 `/fix` + magic keyword (`typo`/`dialogue`/`css`)로 흡수.

자연어 자동 라우팅은 한글 + 영어 동사 (`검증`, `분석`, `파악`, `만들어줘`, `리팩토링`, `verify`, `validate`, `implement`, …)와 복합 의도 (`검증하고 수정해` → `investigate → fix`)를 커버.

---

## 동작 방식

### 1. 스킬 조합 (고정 step 대신)

각 모드는 **14개 workflow 스킬의 부분집합** + 진입점.

```
fix 모드:
  investigate → investigate-review → tasker → tasker-review →
  write-test → coding → agent-review →
  e2e (real interface) → e2e-review → team-code-review → human-check
```

모든 스킬은 `skills/workflow-*/SKILL.md`에 계약 선언:

```yaml
name: workflow-coding
consumes: *.test.* (RED) OR active_feedback
produces: src files changed
default_pattern: A
default_agent: executor
supports_patterns: [A, C]
gate:
  pre:
    - tdd_cycle: "test_cycles has action=added_case|modified_case + run_result=fail"
  post:
    - src_changed: true
    - typecheck_clean: true
    - scoped_tests_pass: true
```

### 2. Producer chain 라우팅 (재시도 없음)

스킬 실패 시 `scripts/route-on-fail.mjs`가 producer 조회:

```
workflow-coding (tdd_cycle fail) → workflow-write-test
workflow-coding (scope_mismatch fail) → workflow-tasker
workflow-team-code-review (CRITICAL) → workflow-tasker
workflow-team-code-review (MEDIUM)   → workflow-coding
workflow-e2e (artifact_missing)      → workflow-e2e (self-rerun)
workflow-e2e (mocked_interface)      → workflow-e2e (self-rerun)
workflow-e2e-review (file_absent)    → workflow-e2e
workflow-e2e-review (insufficient_scenario) → workflow-coding
workflow-verify (any runtime fail)   → workflow-coding (→ /fix upgrade)
workflow-human-check (rework)         → active_feedback[].target_skill
```

라우팅 대상이 모드의 `allowed_skills` 밖이면 엔진은 **mode upgrade** 요청 — 사용자 게이트.

### 3. Queue-drop auto-confirm

Stop hook은 15초 cap이 있다. Smelter는 "never halt" 로직을 분리:

- `scripts/auto-confirm.mjs` (Stop) — `*.state.json` 읽기, decide tree 실행, injection payload를 `.smt/state/auto-confirm-queue.json`에 drop, `block` 결정 방출.
- `scripts/auto-confirm-consumer.mjs` (UserPromptSubmit) — 큐 읽기 (5분 이상 오래된 항목 무시), `additionalContext`로 주입, 큐 삭제.

유일한 halt 조건: 명시적 사용자 stop, `workflow-human-check` 대기, mode-upgrade 결정, 활성 state 없음.

### 4. Team patterns (A–E)

`workflow-tasker`가 plan 시점에 선택; `state.team_runtime[skill]`에 저장:

- **A. Specialist** — 1 스킬, 1 agent. 대부분의 스킬 기본값.
- **B. Team Consensus (95%)** — `advocate` + `critic` + `arbitrator`가 합의 ≥95% 도달까지 라운드 반복. `workflow-tasker-review`, `workflow-team-code-review` 기본; `workflow-agent-review`는 Pattern B dual (code-reviewer + security-reviewer → arbitrator) 사용.
- **C. Parallel Delegation** — N agent가 area / file / module로 분할, `aggregator`가 `sync_point`에서 병합, `conflict-resolver`가 병합 실패 시 중재. `workflow-investigate` (area), `workflow-write-test` (file), `workflow-coding` (module, 분할 시) 기본.
- **D. Hierarchical** — lead agent가 sub-agents 조율. `workflow-tasker` (architect + researcher + executor), `workflow-brainstorm` deep (planner + product/engineer/design 페르소나) 기본.
- **E. Adversarial Watchdog** — `scripts/critic-watchdog.mjs` (Layer 1, hook) + `agents/critic-watchdog.md` (Layer 2, periodic agent). `workflow-coding` 진행 중 상시 활성.

### 5. Multi-Pass Verification (review 스킬 전용)

모든 review 스킬은 3 라운드 의무:

| 라운드 | 포커스 | 질문 |
|--------|--------|------|
| 1      | omission       | artifact에서 무엇이 빠졌나? |
| 2      | contradiction  | 내부 모순 또는 상류와의 충돌은? |
| 3      | edge_case      | 어떤 경계 케이스가 미해결인가? |

라운드는 `state.team_runtime[skill].rounds[]`에 기록. `pass`는 `completed_rounds === 3` + 모든 라운드 `result === 'pass'` 필수. 조기 `pass` 선언은 hook-blocked.

### 6. Stall Cascade (§11-6)

6개 시그널: parallel-agent tool-inactive, repeated fail, sync-point wait, tdd-no-green, feedback backlog, state stale.

```
Level 1 debugger (ReadOnly)   — 진단 + unblock 제안
Level 2 producer reroute      — 상류 jump
Level 3 sub-tasker extract    — blocker가 새 task로
Level 4 mode upgrade          — 유일한 user-facing 레벨
```

### 7. E2E 실제 인터페이스 강제 (v2.4.1)

`workflow-e2e`와 `workflow-verify` Phase 3는 **테스트 러너 stdout만**으로는 pass 불가. 각 surface별로:

| Surface | 실 인터페이스 | 필수 artifact |
|---------|--------------|---------------|
| UI | Playwright가 구동한 실 브라우저 | `.webm` + `.png` + console.log |
| CLI | 실 subprocess (stdin/argv/exit) | `.transcript` |
| HTTP API | 실 서버 + 실 요청 | request/response `.log` |
| Database | 실 DB 엔진 (stub 금지) | `.sql.log` + state |
| Hook | 실 `cat payload \| node hook.mjs` | input/output `.json` + `.exit` |

Critic Watchdog R11 (CRITICAL)이 `.smt/features/<slug>/artifacts/` artifact 없이 pass 기록 시도를 차단. 신규 cause: `artifact_missing`, `mocked_interface` (둘 다 self-rerun).

---

## Iron Laws

양보 불가. Runtime 강제.

1. **실패 후 halt 금지** — 세션은 producer chain + queue-drop으로 계속 진행.
2. **회피 금지** — 응답의 리스크 키워드는 sub-task 자동 생성; critic-watchdog R08이 `??`-chain / TODO 회피 표시.
3. **스킬 자기 실패 금지** — `events[].declarer` ∈ `{hook, user}`; skill-declared fail은 state schema가 거부.
4. **재시도 없음** — Producer chain 라우팅이 `max_retry`를 대체. 상류 상태 변경 후 같은 스킬의 self-rerun은 재시도가 아님.
5. **파일이 진실** — 에이전트는 `.state.json`을 읽지 인메모리 주장을 안 읽음.
6. **Workflow whitelist는 사용자 결정** — 모드의 allowed 밖 `workflow-*`는 사용자 게이트 mode upgrade 필요.
7. **독립 queue, 공유 세션** — task별 queue; specialist agent 할당 가능.
8. **Scoped testing** — 전체 회귀는 `workflow-human-check`에서만.

상세: `document/workflow.md` §0.

---

## 프로젝트 레이아웃

```
agents/                          ← 39개 sub-agent 정의 (v2.4.1 core 10 + 전문가 29)
commands/                        ← 6개 slash-command 진입점
document/                        ← workflow.md (스펙), implementation-v2.md, Introduce.md, index.md
hooks/hooks.json                 ← Claude Code hook 등록
modes/                           ← 6개 mode JSON
scripts/                         ← runtime 스크립트 (auto-confirm, mode-classifier, route-on-fail, stall-detector, critic-watchdog, …)
skills/                          ← 14개 workflow-* 스킬 + utility 스킬 (deep-interview, queue)
src/                             ← 코어 TypeScript 엔진
.smt/                            ← 프로젝트 로컬 상태 (features, state, session, wiki)
```

---

## 철학

> **에이전트는 기억하지 않는다. 에이전트는 파일을 읽는다.**

모든 plan, task, decision, event는 `.smt/`에 저장. 세션 시작 = 파일 재읽기. 진행 = 파일 업데이트. 메모리는 파일에 있지 context window에 없다.

> **실제 인간 개발자 워크플로우를 자동화한다.**

업무 수령 → 조사 → 기획 → TDD → 구현 → 리뷰(셀프 + 팀) → 검증(E2E) → 휴먼 체크 → 배포. Smelter는 이것을 스킬 그래프로 모델링; Claude Code가 실행.

> **자율이 아닌 사용자 주도.**

Mode upgrade, human-check 결정, mode transition은 사용자가 게이트. 나머지는 계속 진행.

---

## 상태

- 버전: `2.4.7`
- Canonical 스펙: [`document/workflow.md`](document/workflow.md) (영문) · [`document/workflow.ko.md`](document/workflow.ko.md) (한국어)
- 구현 레퍼런스: [`document/implementation-v2.md`](document/implementation-v2.md)
- Agent 지시: [`CLAUDE.md`](CLAUDE.md), [`AGENTS.md`](AGENTS.md)
- 릴리즈 노트: [`RELEASE_NOTES.md`](RELEASE_NOTES.md) (영문) · [`RELEASE_NOTES.ko.md`](RELEASE_NOTES.ko.md) (한국어)
- 테스트 스위트: `scripts/auto-confirm.test.mjs` (51 cases), `scripts/mode-classifier.test.mjs` (15 cases), `scripts/workflow-scenarios.test.mjs` (111 cases)

macOS 14+ / Node 20+ 에서 테스트됨. Plugin-scope 설치는 `claude plugin install`.

---

## 라이선스

Private. 메타데이터는 `plugin.json` 참조.
