#!/usr/bin/env node
/**
 * auto-confirm-consumer.mjs — UserPromptSubmit hook.
 *
 * If a same-session queue signal exists, consume it immediately and inject the
 * queued intent back into the model context so work continues without waiting
 * for another stop cycle.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { printTag } from './lib/yellow-tag.mjs';
import { readCancel, clearCancel } from './lib/cancel-signal.mjs';

const __filename = fileURLToPath(import.meta.url);

function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

async function main() {
  printTag('Auto-Confirm Consumer');
  const input = readStdinSync();
  let data = {};
  try { data = JSON.parse(input); } catch {}
  const directory = data.cwd || data.directory || process.cwd();
  const sessionId = data.session_id || data.sessionId || '';
  const signal = readCancel(directory, sessionId);
  if (signal?.type === 'queue' && signal.queued_intent) {
    clearCancel(directory);
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: signal.queued_intent,
      },
    }));
    return;
  }
  console.log(JSON.stringify({ continue: true }));
}

if (process.argv[1] && process.argv[1] === __filename) {
  main();
}
