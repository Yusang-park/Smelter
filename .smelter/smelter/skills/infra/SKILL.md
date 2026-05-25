---
name: infra
description: Entry shim for Smelter /infra mode. Use when Smelter asks to enter infrastructure workflow; immediately continue with workflow-investigate.
---

# infra

This is a Smelter command-entry shim, not the infrastructure executor.

When this skill loads:

1. Treat the request as `/infra` infrastructure or IaC mode.
2. Preserve any hook-injected Smelter context.
3. Do not mutate infrastructure or files yet.
4. Invoke `workflow-investigate` next unless the hook output explicitly names a different `workflow-*` skill.
