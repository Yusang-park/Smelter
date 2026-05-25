---
name: verify
description: Entry shim for Smelter /verify mode. Use when Smelter asks to enter verification workflow; immediately continue with workflow-verify.
---

# verify

This is a Smelter command-entry shim, not the verification executor.

When this skill loads:

1. Treat the request as `/verify` non-mutating verification mode.
2. Preserve any hook-injected Smelter context.
3. Do not edit files.
4. Invoke `workflow-verify` next unless the hook output explicitly names a different `workflow-*` skill.
