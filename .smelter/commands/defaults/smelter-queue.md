# Smelter: /queue — Soft-redirect next intent

Queue a new intent **without interrupting current work**. In the Smelter-native migration this is advisory guidance, not an enforced state transition.

This is a **utility command** — it does NOT enter a workflow mode.

## Usage

```
/queue <what to do next>
```

## Examples

```
/queue fix the CSS overflow on mobile nav
/queue write unit tests for the auth module
/queue run the test suite and report failures
```

## How it works

1. Record the queued intent in the current response or workflow artifact when useful.
2. Finish the current atomic step without blocking tool execution.
3. Start a new Smelter workflow for the queued intent after the current step completes.

## Differences

| Command | Current tool execution | How redirect is delivered |
|---------|------------------------|---------------------------|
| `/queue <intent>` | **continues** | Advisory next-intent note |
| `/cancel hard` | not implemented in Smelter-native queue | Use workflow abandon/cancel surfaces |
| Escape / Ctrl+C | interrupted | `[INTERRUPTED]` marker on next prompt |

## Scope and caveats

- Utility command — no state-machine transition.
- Not governed by Iron Law whitelist (mode-agnostic).
- Works in any mode (brainstorm / fix / explore / implement / verify / infra).
- The redirect is **advisory**. The agent should not ignore a posted redirect indefinitely.
