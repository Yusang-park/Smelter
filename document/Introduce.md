---
title: Smelter — Philosophy & Direction
type: canonical
tags: [smelter, philosophy, workflow, skill-composition]
updated: 2026-04-26
---

# Smelter — Philosophy & Direction

> "Automate the actual human developer workflow."

Smelter is not a Claude Code configuration layer. It is a **workflow engine** that models the real team software development process — receive work from PM, investigate, plan, TDD, implement, verify, review, deploy — and orchestrates Claude Code to execute it.

---

## 1. Skill-composition

Smelter composes atomic **workflow skills** (`workflow-*`) into modes:

| Mode | Entry skill | Use |
|------|-------------|-----|
| `fix` | `workflow-investigate` | Bug / logic repair |
| `explore` | `workflow-investigate` | Static investigation (맥락·근거 파악) |
| `verify` | `workflow-verify` | Non-modifying verification (tests + static inspect + E2E) |
| `brainstorm` | `workflow-brainstorm` (deep) | New feature / refactor, planning first |
| `implement` | `workflow-investigate` → `workflow-implementation-plan` | Code-based implementation planning and build |

Each skill declares a contract (`consumes`, `produces`, `gate`). Failures route via **producer chain** — no retries, no evasion, no self-failure. See `document/workflow.md` §5.

---

## 2. Agents do not memorize — agents read files

All plans, decisions, and execution state live on disk under `.smt/`:

```
.smt/
├── features/
│   └── <feature-slug>/
│       ├── task/
│       │   ├── plan.md                   ← feature goal, scope, acceptance criteria
│       │   ├── <task-name>.md            ← human-readable task record
│       │   └── <task-name>.state.json    ← machine state (v0.4.0 schema)
│       ├── decisions.md
│       └── artifacts/                    ← e2e video, screenshots, logs
└── state/                                ← global session state
```

Consequences:
- Current goal and scope are pinned to files.
- Pending tasks and their status are explicitly tracked.
- Plan revisions accumulate, not overwrite.
- Cross-references between documents are preserved.
- Verification evidence is file-backed, not agent-claimed.

---

## 3. Fixed-role agent structure

| Agent | Primary role | Does NOT do |
|-------|--------------|-------------|
| `planner` | Planning state, scope, acceptance criteria, task breakdown | Implementation, final verification |
| `executor` | Concrete code change for an assigned task | Re-planning, architectural decisions, final approval |
| `architect` | Architecture review, debugging analysis, implementation verification | Implementation, plan generation |
| `tdd-guide` | Test-first workflow, RED/GREEN discipline | Feature ownership, final feature approval |
| `code-reviewer` | Independent review for quality, security, maintainability | Implementation, scope expansion |
| `security-reviewer` | Vulnerability / permission / data-exposure review | Implementation |
| `qa-tester` | E2E execution, artifact capture | Implementation |
| `aggregator` | Pattern C parallel-result merging | Decision-making, conflict resolution |
| `conflict-resolver` | Adjudicates aggregator merge failures | Initial authoring |
| `critic-watchdog` | Real-time Iron Law rule enforcement | Anything beyond read-only observation |
| `debugger` | Stall diagnosis (Cascade L1) | Write actions |

Each agent has a clear primary role and hands off only when necessary.

---

## 4. Multi-layer verification

Smelter does not accept "execute then done". It re-smelts the output through multiple independent verifications:

- **Multi-Pass Verification (§9-3)**: every review skill runs 2 rounds — omission / contradiction — before declaring pass.
- **Pattern B Dual Adversarial (agent-review)**: `code-reviewer` + `security-reviewer` run in parallel; `arbitrator` merges.
- **Pattern B 95% Consensus (team-code-review)**: advocate / critic / arbitrator iterate to consensus.
- **Critic Watchdog (§12-8)**: 10-rule hook layer continuously enforces Iron Laws during implementation.
- **Human Check (§10)**: final user gate with Video / Log / Diff report.

---

## 5. Iron Laws (8)

See `document/workflow.md` §0. The eight non-negotiables:

1. Never stop after failure — only user stop ends the session.
2. No evasion — a fail must be resolved, not reclassified as "known limit".
3. No self-failure declaration — a skill cannot output "can't do it".
4. No retry — producer-chain routing, not blind re-runs.
5. File is truth — postcondition files determine completion, not agent claims.
6. Workflow whitelist is user decision — mode upgrades require explicit user consent.
7. Independent queue, shared session, specialist assignment — task queues never interleave; session context may be shared across tasks.
8. Scoped testing — only changed-surface tests run before `workflow-human-check`.

---

## 6. Entry points

| User input | Mode classifier routes to |
|------------|----------------------------|
| "text fix", "CSS", "rename", "typo", "translation" | `fix` with surface exemption |
| "bug", "error", "not working", "broken" | `fix` |
| "analyze", "investigate", "how does X work" | `explore` |
| "design", "plan", "refactor", "new feature" | `brainstorm` |
| "build", "add", "implement", "extend" | `implement` |
| Ambiguous | `fix` (safe default) |

Explicit slash commands (`/brainstorm`, `/fix`, `/infra`, `/explore`, `/verify`, `/implement`, `/dobby`) override the classifier.
