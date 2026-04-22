# Smelter: /queue — Soft-redirect next intent

Queue a new intent **without interrupting current work**. Current tool execution and the current turn continue normally; a `[QUEUED REDIRECT]` reminder is injected on every subsequent tool call so the agent naturally switches to the queued intent after the current atomic step completes.

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

## How it works (actual implementation, traced)

1. **UserPromptSubmit** — `scripts/keyword-detector.mjs` detects `/queue <intent>` and calls `propagateQueueCancel(directory, intent, sessionId)` (from `scripts/cancel-propagator.mjs`).
2. Writes `.smt/state/cancel-signal.json`:
   ```json
   {
     "type": "queue",
     "queued_intent": "<intent>",
     "session_id": "<sess>",
     "timestamp": <now>
   }
   ```
3. Current turn continues. **No tool execution is blocked.**
4. **PreToolUse (every subsequent tool call)** — `scripts/pre-tool-enforcer.mjs` reads the signal. When `type === 'queue'`, emits:
   ```json
   {
     "continue": true,
     "hookSpecificOutput": {
       "additionalContext": "<tool desc> | [QUEUED REDIRECT] After current step, switch to: \"<intent>\""
     }
   }
   ```
5. `continue: true` means tools still execute; the banner is purely informational context so the agent sees the pending redirect on every step.
6. After the current atomic step completes, the agent organically transitions to the queued intent (it has been seeing the banner repeatedly).
7. Signal auto-expires after 5 minutes (`EXPIRY_MS` in `scripts/lib/cancel-signal.mjs`) so stale signals never wedge future sessions.

## Differences

| Command | Current tool execution | How redirect is delivered |
|---------|------------------------|---------------------------|
| `/queue <intent>` | **continues** | `[QUEUED REDIRECT]` banner injected on every PreToolUse |
| `/cancel hard` | **blocked** (PreToolUse emits `decision: block`) | Immediate halt, `[CANCELLED]` banner |
| Escape / Ctrl+C | interrupted | `[INTERRUPTED]` marker on next prompt |

## Scope and caveats

- Utility command — no `modes/queue.json`, no state-machine transition.
- Not governed by Iron Law whitelist (mode-agnostic).
- Works in any mode (plan / fix / investigate / implement / verify).
- The redirect is **advisory**, not enforced. The agent must read the banner and act on it. Iron Law #2 (no evasion) applies — the agent should not ignore a posted redirect indefinitely.
- The `auto-confirm.mjs` Stop hook and `auto-confirm-consumer.mjs` operate on a SEPARATE queue file — **session-scoped** at `.smt/state/auto-confirm-queue-<sessionId>.json` — used for workflow-skill continuation, not for `/queue` redirects. The session scoping prevents parallel Claude sessions in the same project from consuming each other's queued continuation payloads.
