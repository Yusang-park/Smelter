#!/usr/bin/env node
/**
 * auto-confirm-consumer.mjs — UserPromptSubmit hook.
 *
 * Consumes the queue file dropped by `auto-confirm.mjs` on the prior Stop event.
 * If `.smt/state/auto-confirm-queue.json` exists, this hook reads
 * and deletes it, then injects its content as `additionalContext` so the main
 * agent can act on the forwarded summary on this turn.
 *
 * The Stop hook cannot spawn a sub-agent within its 15s cap, so we split the
 * roundtrip: Stop drops → next UserPromptSubmit consumes.
 *
 * Output (queue present): { continue: true, hookSpecificOutput: { additionalContext } }
 * Output (queue absent):  { continue: true }
 */

import { existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printTag } from './lib/yellow-tag.mjs';

const __filename = fileURLToPath(import.meta.url);

function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

const STALE_MS = 30 * 60 * 1000; // 30 min
// Legacy sid-less queue files: give the owning session a grace window before
// any consumer is allowed to adopt the file. Prevents a racing consumer from
// stealing a payload the owning session is about to claim on its next prompt.
const LEGACY_ADOPT_MIN_AGE_MS = 5 * 1000;

function listQueueCandidates(stateDir) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(stateDir); } catch { return out; }
  for (const name of entries) {
    if (name === 'auto-confirm-queue.json') {
      out.push(join(stateDir, name)); // legacy single-file layout
      continue;
    }
    if (/^queue-.+\.json$/.test(name) && !name.includes('.tmp.')) {
      out.push(join(stateDir, name));
    }
  }
  return out;
}

function peekPayload(path) {
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // Unreadable/garbage file — safe to unlink immediately; it cannot match any session.
    try { unlinkSync(path); } catch {}
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.timestamp && Date.now() - payload.timestamp > STALE_MS) {
    try { unlinkSync(path); } catch {}
    return null;
  }
  return payload;
}

function unlinkSafe(path) {
  try { unlinkSync(path); } catch {}
}

function extractSessionFromFilename(path) {
  // OS-agnostic: strip directory first, then match.
  const m = basename(path).match(/^queue-(.+)\.json$/);
  return m ? m[1] : null;
}

export function consumeQueueFile(projectDir, sessionId = '') {
  const stateDir = join(projectDir, '.smt', 'state');
  if (!existsSync(stateDir)) return null;
  const candidates = listQueueCandidates(stateDir);
  if (candidates.length === 0) return null;

  const sid = String(sessionId || '').replace(/[^a-zA-Z0-9_.-]/g, '_');

  // Strict session scoping: only consume files that belong to this session
  // (filename match) OR legacy single-file layout. Peer-session queues are
  // left untouched so that session owner can consume later.
  for (const p of candidates) {
    const fileSid = extractSessionFromFilename(p);
    if (fileSid !== null) {
      // Session-scoped file — consume only if it matches current session.
      if (!sid || fileSid !== sid) continue;
      // Filename-matched session file: safe to read + unlink atomically.
      const payload = peekPayload(p);
      if (!payload) continue;
      unlinkSafe(p);
      if (payload.session_id && sessionId && payload.session_id !== sessionId) {
        continue;
      }
      return payload;
    }
    // Legacy single-file (auto-confirm-queue.json): peek FIRST, then only
    // unlink if the payload's session_id matches (or has none). This prevents
    // racing sessions from destroying each other's legacy payloads.
    const payload = peekPayload(p);
    if (!payload) continue;
    if (payload.session_id && sessionId && payload.session_id !== sessionId) {
      // Not ours — leave the file for the owning session to consume.
      continue;
    }
    // sid-less legacy file: require a minimum age before adopting so the
    // owning session has a chance to claim it. Too-young → skip + leave intact.
    if (!payload.session_id) {
      let ageMs = Infinity;
      try {
        const st = statSync(p);
        ageMs = Date.now() - st.mtimeMs;
      } catch {}
      if (ageMs < LEGACY_ADOPT_MIN_AGE_MS) continue;
    }
    unlinkSafe(p);
    return payload;
  }
  return null;
}

export function formatContext(payload) {
  const tasks = Array.isArray(payload.pending_tasks) ? payload.pending_tasks : [];
  const taskLines = tasks.length > 0
    ? tasks.map(t => `  - [${t.status || 'pending'}] ${t.title || ''}`).join('\n')
    : '  (none tracked)';
  const lastMsg = (payload.last_message || '').trim();
  return `[AUTO-CONFIRM FORWARD]\n\nOn the previous turn you ended while pending tasks remained in .smt/. Continue that work now — do not ask for confirmation.\n\n## Your prior last message (verbatim, truncated)\n${lastMsg || '(empty)'}\n\n## Pending tasks\n${taskLines}\n\nAct on the next concrete step. Name files/commands directly.`;
}

async function main() {
  try {
    const input = readStdinSync();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';
    const payload = consumeQueueFile(directory, sessionId);
    if (!payload) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    printTag('Auto-Confirm: consumed');
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: formatContext(payload),
      },
    }));
  } catch {
    console.log(JSON.stringify({ continue: true }));
  }
}

if (process.argv[1] && process.argv[1] === __filename) {
  main();
}
