### 1. 인간 워크플로우 그대로 (11-Step Automation)

| Smelter                                          |
| ------------------------------------------------ |
| PM 업무 수령 → 학습 → 설계 → TDD → 구현 → 검증 → 휴먼 리뷰 -> 반복 |
| 10단계 체계적 워크플로우                                   |
| TDD + E2E + 교차 에이전트 리뷰                           |

---

### 2. LLM Wiki를 활용한 파일 기반 Spec / Task 관리

> **Agents do not memorize. Agents read files.**

smelter는 **현재 제품 작업의 spec과 task 상태를 파일로 유지하면서**, 단계적 workflow를 따라 누락된 작업이 없도록 관리한다. 동시에 작업의 흐름을 위키처럼 누적 관리하며, 문서를 기반으로 작업의 검증을 지속한다.

- **Plan / Tasks / PRD**: 현재 작업의 spec과 실행 상태
- **Schema**: AGENT.md (CLAUDE.md)



planning state의 기본 구조:

```
.smelter/
├── features/
│   └── <slug>/
│       ├── task/
│       │   ├── plan.md     ← feature 목표, 범위, acceptance criteria
│       │   └── <task_slug>.md   ← 개별 task (atomic, agent-readable)
│       └── decisions.md         ← 이 작업의 아키텍처 결정 기록
├── wiki/                        ← 프로젝트 지식 베이스
└── session/                     ← 세션 로그
```

이 패턴의 결과:
- 현재 목표와 범위가 파일에 고정됨
- 실행할 task와 상태가 명확히 추적됨
- 계획 수정과 진행 상황이 누적 기록됨
- 관련 문서 간 교차 참조를 유지할 수 있음
- 작업의 검증 여부를 정확하게 확인 할 수 있음
- **작업 중 드러난 변경 사항이나 모순을 문서에 반영할 수 있음**

---

### 3. 학습 시스템 (ECC continuous-learning-v2)

> **ECC(everything-claude-code)의 instinct 학습 시스템 채택.**

일반 LLM은 세션이 끝나면 모든 패턴을 잊는다. smelter는 **관찰 → 패턴 인식 → instinct 생성 → 영구화** 사이클로 실제로 학습한다:

```
도구 호출
   ↓
observe.sh → JSONL 기록 (PreToolUse/PostToolUse)
   ↓
20개 관찰 누적 → Haiku가 패턴 분석
   ↓
confidence 0.3~0.9 instinct YAML 생성
   ↓
/evolve → skill/command/agent로 영구화
```

| 명령 | 역할 |
|------|------|
| `/instinct-status` | 학습된 패턴 조회 |
| `/evolve` | instinct → skill/command 진화 |

저장 경로: `~/.claude/homunculus/projects/{git-hash}/`

---

### 4. 역할 고정 구조 (Fixed-Role Structure)

smelter는 역할 고정 방식으로 동작한다:

| 에이전트 | 주 역할 | 맡지 않는 책임 |
|------|---------|--------------|
| `planner` | planning state, 범위, acceptance criteria, task breakdown | 구현, 최종 검증 |
| `executor` | 할당된 task의 구체적인 코드 변경 | 재계획, 아키텍처 결정, 최종 승인 |
| `architect` | 아키텍처 리뷰, 디버깅 분석, 구현 검증 | 구현, 계획 생성 |
| `tdd-guide` | test-first workflow, 테스트 전략, RED/GREEN discipline | 기능 소유권, 최종 기능 승인 |
| `code-reviewer` | 품질/보안/유지보수성에 대한 독립 리뷰 | 구현, 범위 확장 |

각 에이전트는 주 역할이 분명하며, 필요할 때만 서로 handoff한다.

---

### 6. 다중 검증 구조

smelter는 단순 "실행 후 완료"가 아니라, 최소 3번 이상의 검증을 거쳐 완벽하게 결과물을 '재련'한다.

```
Step 6: 3중 에이전트 리뷰
  → 구현 직후 품질, 누락, 엣지 케이스 점검

Step 9: 팀 에이전트 리뷰
  → 여러 관점의 에이전트들로 파이널 리뷰

Step 10: 휴먼 리뷰
  → Video, Log 등을 기반으로 휴먼 리뷰
```

-----------------

