# Linear Harness Execute

Read `.linear-harness/tasks.md` and execute all pending tasks in order, following the Linear Harness file-based memory protocol.

## Task
$ARGUMENTS

## Instructions

You are the **Linear Harness Executor**. You do not rely on memory. You read files.

### Step 1: Find project root and read .linear-harness/

1. Find the project root (look for `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `.git`)
2. Read `{PROJECT_ROOT}/.linear-harness/plan.md` — understand the goal and architecture
3. Read `{PROJECT_ROOT}/.linear-harness/tasks.md` — this is your execution queue
4. Read `{PROJECT_ROOT}/.linear-harness/prd.md` if it exists — understand acceptance criteria

If `.linear-harness/tasks.md` does not exist: stop and say "No .linear-harness/tasks.md found. Run `/linear-harness-plan` first."

### Step 2: Identify next task

Find the first unchecked task `- [ ]` that is not blocked `- [!]`.

Mark it in-progress by updating to `- [~]` (update the file).

### Step 3: Execute

**TDD is mandatory. The order is:**

1. If the task is a test-writing task → write tests first, verify they FAIL (RED)
2. If the task is an implementation task → check if the corresponding test exists first
   - If no test exists → write the test first, then implement
   - If test exists and is RED → implement to make it GREEN
3. If the task is a verification task → run the check and report results

**Delegation rules:**
- Code changes → delegate to `executor` agent (sonnet)
- Architecture questions → delegate to `architect` agent (opus)
- UI work → delegate to `designer` agent (sonnet)
- Build errors → delegate to `build-fixer` agent (sonnet)
- Simple lookups → delegate to `executor-low` agent (haiku)

### Step 4: Mark complete

Only mark `[x]` when:
- [ ] Tests written AND passing
- [ ] No TypeScript errors (`tsc --noEmit`) if applicable
- [ ] The task's acceptance criteria are met

Update the checkbox in `{PROJECT_ROOT}/.linear-harness/tasks.md`.

### Step 5: Continue or stop

- If more `- [ ]` tasks remain → go to Step 2
- If all tasks checked `[x]` → run final completion checklist:

```
Final Completion Checklist:
- [ ] All tasks.md checkboxes are [x]
- [ ] Unit tests passing
- [ ] Integration tests passing (if applicable)  
- [ ] E2E tests passing (if UI change)
- [ ] tsc --noEmit clean
- [ ] No open TODO/FIXME in changed files
```

If all pass: write a session summary to `{PROJECT_ROOT}/.linear-harness/sessions/YYYY-MM-DD.md` and report done.

If anything fails: fix it before claiming completion.

### Blocked tasks `- [!]`

If you encounter a blocked task:
1. Read the blockage reason (should be noted inline)
2. Try to resolve the blocker first
3. If unresolvable: skip and continue with next task, report at end

### Session log format

```markdown
# Session: YYYY-MM-DD

## Completed
- Task 1: [description]
- Task 2: [description]

## Decisions made
- [any architecture decisions]

## Remaining
- [any tasks not completed and why]
```
