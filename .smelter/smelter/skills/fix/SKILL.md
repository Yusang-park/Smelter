---
name: fix
description: Entry shim for Smelter /fix mode. Use when Smelter asks to enter bug-fix workflow; immediately continue with workflow-investigate.
---

# fix

This is a Smelter command-entry shim, not the repair executor.

When this skill loads:

1. Treat the request as `/fix` bug or regression repair mode.
2. Preserve any hook-injected Smelter context.
3. Do not edit source files yet.
4. Invoke `workflow-investigate` next unless the hook output explicitly names a different `workflow-*` skill.
