---
name: implement
description: Entry shim for Smelter /implement mode. Use when Smelter asks to enter implementation workflow; immediately continue with workflow-investigate.
---

# implement

This is a Smelter command-entry shim, not the implementation executor.

When this skill loads:

1. Treat the request as `/implement` feature implementation mode.
2. Preserve any hook-injected Smelter context.
3. Do not edit source files yet.
4. Invoke `workflow-investigate` next unless the hook output explicitly names a different `workflow-*` skill.
