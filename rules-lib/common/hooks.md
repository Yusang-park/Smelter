# Hooks System

**Hook types:** PreToolUse (validation/param modification), PostToolUse (checks/format), Stop (final verification), SessionStart/End.

**Permissions:** Configure `allowedTools` in settings. Never use `--dangerously-skip-permissions`.

**Note:** Smelter does NOT use TodoWrite. Track tasks in `.smt/features/<slug>/task/*.md` only.
