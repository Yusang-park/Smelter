#!/usr/bin/env node
// auto-confirm-consumer.mjs — UserPromptSubmit hook that consumes queued
// auto-confirm payloads.
//
// Partner of auto-confirm.mjs. When auto-confirm.mjs drops a payload on Stop,
// the next UserPromptSubmit picks it up here and injects it as additionalContext
// so the main agent continues from where it left off.
//
// Behavior:
//   1. Look for `.smt/state/auto-confirm-queue.json`. If absent → exit 0.
//   2. If older than QUEUE_MAX_AGE_MS → delete (stale) and exit 0.
//   3. Otherwise emit `{ continue: true, hookSpecificOutput: { hookEventName,
//      additionalContext } }` per Claude Code UserPromptSubmit schema, and
//      delete the queue so it fires only once.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { queuePath, QUEUE_MAX_AGE_MS } from './auto-confirm.mjs';

function readStdinJson() {
  try { return JSON.parse(readFileSync('/dev/stdin', 'utf-8')); } catch { return {}; }
}

export function consume(cwd, { now = Date.now() } = {}) {
  const path = queuePath(cwd);
  if (!existsSync(path)) return null;

  let entry;
  try {
    entry = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    try { unlinkSync(path); } catch {}
    return null;
  }

  const age = entry.t ? now - new Date(entry.t).getTime() : Infinity;
  if (age > QUEUE_MAX_AGE_MS) {
    try { unlinkSync(path); } catch {}
    return null;
  }

  try { unlinkSync(path); } catch {}
  return entry;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = readStdinJson();
  const cwd = input.cwd || process.cwd();
  const entry = consume(cwd);

  if (!entry || !entry.additionalContext) {
    process.exit(0);
  }

  // UserPromptSubmit schema: use `continue: true` + `hookSpecificOutput`.
  // `decision: 'continue'` is NOT a valid UserPromptSubmit decision value
  // (valid set is undefined | 'block' | 'approve').
  const output = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: entry.additionalContext,
    },
  };
  console.log(JSON.stringify(output));
  process.exit(0);
}
