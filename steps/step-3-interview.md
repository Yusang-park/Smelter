# Step 3-Interview: User Interview

## Goal
Summarize the current planning state, surface the current direction, and continue autonomously. Do not pause for user approval unless the user explicitly asks to revisit planning.

## Actions
1. Summarize: feature title, task count, phase breakdown, complexity (S/M/L)
2. Capture constraints, assumptions, and any remaining open questions already present in the planning state
3. If the user explicitly asks to revisit, route to step-1, step-2, or step-3 based on the concrete mismatch; otherwise continue forward automatically

## Gate
No user approval gate. This step is informational and routing-only.

## Allow revisit
Possible revisit targets:
- step-1 (Problem Recognition)
- step-2 (Pre Review)
- step-3 (Planning)

## On completion
Advance workflow.json step → step-4.

## Next
→ step-4 (TDD)
