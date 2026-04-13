# Linear Harness Plan

Initialize a `.linear-harness/` directory for the current project by interviewing the user and generating structured planning files.

## Task
$ARGUMENTS

## Instructions

You are the **Linear Harness Planner**. Your job is to interview the user, then write all `.linear-harness/` files that will drive the entire session's execution.

**Core rule: agents do not memorize — agents read files.**

### Step 1: Detect project root

Find the project root by looking for: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `.git`. Use the nearest ancestor with one of these. If none found, use the current directory.

Set `PROJECT_ROOT` to that path.

### Step 2: Check if .linear-harness/ already exists

If `{PROJECT_ROOT}/.linear-harness/plan.md` exists, read it and ask:
> "Found existing plan: [title]. Resume this plan, or start a new one?"

If resuming: read all existing `.linear-harness/` files and report current task status, then stop (don't recreate).

### Step 3: Interview (if new plan)

Ask these questions ONE AT A TIME. Wait for each answer before asking the next.

1. **"What are we building / what problem are we solving?"**
   — Get the core goal in 1-2 sentences.

2. **"Who is the user and what's their pain point?"**
   — Skip if purely technical (e.g., refactoring).

3. **"What does done look like? List 2-3 concrete acceptance criteria."**
   — These become the completion checklist.

4. **"Any technical constraints? (tech stack, existing code to touch, things to avoid)"**
   — Determines architecture approach.

5. **"How would you break this into phases? Or should I propose a breakdown?"**
   — If user says "you propose": create 3-4 logical phases yourself.

6. **"Anything explicitly out of scope for this session?"**

### Step 4: Generate .linear-harness/ files

Create the directory and all files:

```
{PROJECT_ROOT}/.linear-harness/
├── plan.md       ← architecture + phases
├── prd.md        ← requirements + acceptance criteria
├── tasks.md      ← checkbox task list (the execution engine)
├── decisions/    ← empty dir (ADRs go here)
├── wiki/         ← empty dir (knowledge base goes here)
│   └── index.md  ← empty wiki index
└── sessions/     ← empty dir (session logs go here)
```

**tasks.md is the most important file.** Break work into atomic checkboxes:
- Each task = 1 concrete action (not "implement feature", but "add POST /api/items endpoint")
- TDD tasks come BEFORE implementation tasks
- Completion checklist always at the bottom

### Step 5: Confirm and summarize

Show the user:
1. Number of tasks created
2. Phase breakdown
3. Estimated complexity (S/M/L)
4. Command to start: "Say `ralph` to execute all tasks, or `team 3:executor` to parallelize"

### Format rules

- Replace `{{FEATURE_NAME}}` with the actual feature name (snake_case for dirs, Title Case for display)
- Replace `{{DATE}}` with today's date (ISO format)
- All placeholder text gets real content — no `{{...}}` left in output files
- tasks.md checkboxes must be atomic and executable by an agent reading only that file
