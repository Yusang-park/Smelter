# Linear Harness

You are an AI assistant operating under the **Linear Harness** — a TDD-first, file-based, multi-agent system.

---

## Core Philosophy

**"Agents do not memorize. Agents read files."**

- All plans, tasks, decisions → written to `.linear-harness/` files
- Agent reads `.linear-harness/plan.md` + `.linear-harness/tasks.md` at session start
- Progress tracked by updating `.linear-harness/tasks.md` checkboxes
- Memory lives in files, not in context

---

## TDD is Mandatory

```
RULE 1: NEVER write implementation before tests
RULE 2: Test file MUST exist before source file
RULE 3: Tests MUST fail first (RED), then pass (GREEN)
RULE 4: E2E tests required for all UI/feature changes
RULE 5: NEVER mark a task complete without passing tests
```

Enforcement is automatic via hooks (`session-start-linear-harness.mjs`, `pre-tool-enforcer.mjs`).

---

## Modes (3 only)

| Mode | Trigger | Use |
|------|---------|-----|
| `autopilot` | "autopilot", "build me" | End-to-end feature work |
| `ralph` | "ralph", "끝까지", "must complete" | Persist until all tasks verified |
| `team` | `/team N:executor "..."` | Parallel multi-agent execution |

**ralph includes team parallelism.** No other modes needed.

---

## Agents (core only)

| Task | Agent | Model |
|------|-------|-------|
| Code implementation | `executor` | sonnet |
| Simple fix / lookup | `executor-low` | haiku |
| Complex refactoring | `executor-high` | opus |
| Architecture / debug | `architect` | opus |
| Quick analysis | `architect-low` | haiku |
| File/code search | `explore` | haiku |
| Deep codebase search | `explore-high` | opus |
| TDD enforcement | `tdd-guide` | sonnet |
| E2E testing | `qa-tester` | sonnet |
| UI/frontend | `designer` | sonnet |
| Code review | `code-reviewer` | opus |
| Security review | `security-reviewer` | opus |
| Build errors | `build-fixer` | sonnet |
| Git operations | `git-master` | sonnet |

Use `Task(subagent_type="<agent>", model="<model>", prompt="...")`.

---

## File-Based Memory (.linear-harness/)

Every project session uses `.linear-harness/` as the source of truth:

```
{project}/
└── .linear-harness/
    ├── plan.md          ← current goal (READ FIRST at session start)
    ├── prd.md           ← product requirements
    ├── tasks.md         ← checkbox task list (update in real-time)
    ├── decisions/       ← architecture decision records
    ├── wiki/            ← knowledge base (index.md + topic pages)
    └── sessions/        ← session logs
```

**Protocol:**
1. Session start → Read `.linear-harness/plan.md` + `.linear-harness/tasks.md`
2. Before coding → verify task exists in `tasks.md`
3. Task complete → update checkbox in `tasks.md`
4. New decision → write to `decisions/`
5. Session end → append to `sessions/YYYY-MM-DD.md`

---

## Workflow

```
/plan "feature"         → interview → create .linear-harness/ files
/team 3:executor "..."  → read tasks.md → parallel execution
/ralph "..."            → execute until all tasks.md ✅ + E2E pass
```

**Autopilot pipeline** (from `workflows/autopilot.yaml`):
```
analyze → architect → critique → implement (TDD) → E2E
```

---

## Completion Rules

Before marking ANY task complete:
- [ ] Unit tests written AND passing
- [ ] Integration tests passing (if applicable)
- [ ] E2E tests passing (if UI change)
- [ ] `tasks.md` checkbox updated
- [ ] No TypeScript errors (`tsc --noEmit`)

**If ANY unchecked → CONTINUE WORKING.**

---

## ECC Instinct Learning

Sessions are observed automatically. Patterns become instincts:
- `/instinct-status` — view learned patterns
- `/evolve` — cluster instincts into skills
- Instincts auto-inject on future sessions

---

## State Paths

| Path | Purpose |
|------|---------|
| `{project}/.linear-harness/` | File-based memory (plans, tasks, wiki) |
| `{worktree}/.omc/state/` | Mode state (ralph, autopilot) |
| `~/.claude/homunculus/` | ECC instinct data |

---

## Cancel

To stop ralph/autopilot: invoke `/cancel` skill or delete `.omc/state/ralph-state.json`.
