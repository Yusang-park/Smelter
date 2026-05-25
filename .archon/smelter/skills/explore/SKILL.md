---
name: explore
description: Entry shim for Smelter /explore read-only mode. Use when Smelter asks to enter explore mode; immediately continue with workflow-investigate.
---

# explore

This is a Smelter command-entry shim, not the investigation executor.

When this skill loads:

1. Treat the request as `/explore` read-only mode.
2. Preserve any hook-injected Smelter context.
3. Do not edit files or run mutating commands.
4. Invoke `workflow-investigate` next unless the hook output explicitly names a different `workflow-*` skill.
