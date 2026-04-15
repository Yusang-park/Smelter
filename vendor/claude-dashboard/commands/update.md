---
description: Update statusLine path to latest plugin version
allowed-tools: Read, Bash(jq:*), Bash(ls:*), Bash(sort:*), Bash(tail:*), Bash(mv:*)
---

# Claude Dashboard Update

Update the statusLine path in settings.json to point to the latest cached plugin version.

Run this command after updating the plugin via `/plugin update claude-dashboard`.

## Task

1. Find the latest version in the plugin cache:
```bash
ls -d ~/.claude/plugins/cache/claude-dashboard/claude-dashboard/*/ 2>/dev/null | grep -E '/[0-9]+\.[0-9]+\.[0-9]+/$' | sort -V | tail -1
```

2. Update settings.json with the latest version path:
```bash
LATEST_VERSION=$(ls -d ~/.claude/plugins/cache/claude-dashboard/claude-dashboard/*/ 2>/dev/null | grep -E '/[0-9]+\.[0-9]+\.[0-9]+/$' | sort -V | tail -1 | xargs basename)
jq --arg path "node ~/.claude/plugins/cache/claude-dashboard/claude-dashboard/${LATEST_VERSION}/dist/index.js" '.statusLine.command = $path' ~/.claude/settings.json > ~/.claude/settings.json.tmp && mv ~/.claude/settings.json.tmp ~/.claude/settings.json
```

3. Show the user what was updated:
   - Previous version (if changed)
   - New version path
   - Remind them to restart Claude Code for changes to take effect

## Example Output

```
Updated statusLine to version 1.7.0
Path: ~/.claude/plugins/cache/claude-dashboard/claude-dashboard/1.7.0/dist/index.js

Restart Claude Code for changes to take effect.
```
