---
name: brainstorm
description: Entry shim for Smelter /brainstorm planning mode. Use when Smelter asks to enter brainstorming workflow; immediately continue with workflow-investigate.
---

# brainstorm

This is a Smelter command-entry shim, not the brainstorming executor.

When this skill loads:

1. Treat the request as `/brainstorm` planning-only mode.
2. Preserve any hook-injected Smelter context.
3. Do not edit product source files.
4. Invoke `workflow-investigate` next unless the hook output explicitly names a different `workflow-*` skill.
