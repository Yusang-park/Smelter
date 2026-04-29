<p align="center">
  <img src="assets/smelter-logo.svg" alt="Smelter" width="600" />
</p>

<p align="center">
  <strong>Claude Code용 TDD-first 워크플로우 엔진: 파일 기반 상태, 결정적 gate, 멀티 에이전트 실행.</strong>
</p>

<p align="center"><code>v0.55.0</code></p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a>
</p>

> 영문 [`README.md`](README.md)가 canonical입니다.

---

## 설치

```bash
claude plugin marketplace add Yusang-park/Smelter
claude plugin install smelter@smelter-marketplace
```

Smelter 자체 개발:

```bash
git clone https://github.com/Yusang-park/Smelter.git ~/Smelter
node ~/Smelter/scripts/dev-install.mjs
```

`dev-install.mjs`는 `commands/`만 심볼릭 링크하고 repo-managed hook을 `~/.claude/settings.json`에 설치합니다. 예전 Smelter dev용 `skills/`, `agents/` symlink는 제거해 workflow 리소스가 전역 자동 노출되지 않게 합니다. Hook 등록 변경 뒤에는 새 Claude Code 세션을 시작하세요.

---

## v0.55 핵심 변경

- 현재 릴리즈는 `v0.55.0`입니다.
- 사용자용 read-only 모드는 `explore`, 명령은 `/explore`입니다.
- 인프라 작업은 `/infra`를 사용해 cloud/IaC/resource 변경을 제품 코드 TDD와 분리합니다.
- `/fix`는 실행 가능한 스펙 테스트/코딩 전에 compact `tasks.md`, `tasks-review.md` 범위 체크리스트를 기록합니다.
- `workflow-write-test`는 RED 테스트를 구체 예시, 관찰 가능한 결과, 구현 세부사항 비결합을 갖춘 실행 가능한 스펙으로 다룹니다.
- `/explore → /fix|/implement` 같은 전환 재사용은 hook 하드코딩이 아니라 `modes/workflow.yaml → transition_adoptions`에서 선언합니다.
- 실행 스킬 이름은 계속 `workflow-investigate`입니다. Mode는 사용자 의도, skill은 산출물/실행 단계를 뜻합니다.
- retired investigate command는 alias가 아닙니다.
- `/brainstorm`은 유일한 설계/기획 명령입니다. retired think, plan, simple-fix command는 alias가 아닙니다.

---

## 커맨드

| 커맨드 | UserMode | TaskType | 진입 스킬 | 파이프라인 | 용도 |
|---|---|---|---|---|---|
| `/brainstorm` | `brainstorm` | `design` | `workflow-investigate` → `workflow-brainstorm` | `planning_only` | 코드 수정 없는 제품/아키텍처 설계 |
| `/explore` | `explore` | `read` | `workflow-investigate` | `explore_only` | 읽기 전용 코드 탐색과 진단 |
| `/implement` | `implement` | `write` | `workflow-investigate` → `workflow-implementation-plan` | `full` | 기존 코드 기반 기능 구현 |
| `/infra` | `infra` | `infra` | `workflow-investigate` → `workflow-infra-plan` | `infra_ops` | Cloud/resource/IaC 작업과 안전 계획/실행 증거 |
| `/fix` | `fix` | `write` | `workflow-investigate` | runtime-selected | 버그/로직 수정, 텍스트/디자인 표면 수정 |
| `/verify` | `verify` | `verify` | `workflow-verify` | `verify_only` | 비수정 테스트, 정적 점검, 실제 인터페이스 E2E |
| `/dobby` | `dobby` | `freeform` | `workflow-human-check` | `dobby_only` | 명시적 no-pipeline escape hatch |

자연어도 같은 모드로 라우팅됩니다. 예: "analyze this function" → `/explore`, "버그 고쳐줘" → `/fix`, "설계해줘" → `/brainstorm`, "테스트 해봐" → `/verify`.

---

## 계약 모델

Smelter v0.4는 네 계층을 분리합니다.

| 계층 | 역할 |
|---|---|
| `UserMode` | 사용자 의도: `brainstorm`, `explore`, `implement`, `infra`, `fix`, `verify`, `dobby` |
| `TaskType` | side-effect 계약: `design`, `read`, `write`, `infra`, `verify`, `freeform` |
| `Step` | 결정적 FSM 위치: `INTENT`, `DISCOVERY`, `PLAN`, `TEST_DESIGN`, `EXECUTE`, `VERIFY`, `HUMAN_CHECK`, `DONE` |
| `Guard` | 현재 `(task_type, step, state)`에 대한 tool/action validator |

따라서 read/design/verify 모드는 source를 수정할 수 없고, write 모드는 실행 가능한 스펙 RED 증거 전 product code를 수정할 수 없으며, commit은 `workflow-human-check` 통과 전 차단됩니다.

---

## 상태와 검증

- 모든 plan/task/decision/event는 `.smt/` 파일에 기록됩니다.
- 구현 작업은 실행 가능한 스펙 테스트 먼저 작성, RED 확인, 구현, GREEN 확인 순서를 지킵니다.
- UI/CLI/API/hook/script 등 interface 변경은 실제 인터페이스 E2E가 필요합니다.
- CSS/style, i18n/copy-only, typo, pure-dialogue는 TDD 면제 표면입니다.

---

## 상태

- Version: `0.55.0`
- Canonical spec: [`document/workflow.md`](document/workflow.md)
- Implementation status: [`document/implementation.md`](document/implementation.md)
- Main verification: `npm test`, `npm run typecheck`
