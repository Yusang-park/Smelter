#!/usr/bin/env node
/**
 * posttool-test-red-recorder.mjs — PostToolUse:Bash hook.
 *
 * On `node --test` / `npm test` / equivalent failures, append a
 * `{type: 'test_red'}` event to the active feature's state.json so
 * workflow-v4-guard.hasRedTest() unblocks source writes at EXECUTE.
 *
 * Idempotent within a 5s window. Uses SMT_HOOK_WRITE=1 escape hatch.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { appendEvent, writeState } from './state-schema.mjs';

const TEST_COMMAND_RE = /\b(?:node\s+--test|node\s+--experimental-test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|bun\s+test)\b/;
const DEDUPE_WINDOW_MS = 5_000;

function readStdin() {
  try { return JSON.parse(readFileSync('/dev/stdin', 'utf-8')); }
  catch { return null; }
}

function emit(out) { process.stdout.write(JSON.stringify(out)); }

function resolveActiveStatePath(cwd, sessionId) {
  if (!cwd) return null;
  const candidates = sessionId
    ? [join(cwd, '.smt', 'state', `active-feature-${sessionId}.json`)]
    : [];
  candidates.push(join(cwd, '.smt', 'state', 'active-feature.json'));
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let ptr;
    try { ptr = JSON.parse(readFileSync(p, 'utf-8')); }
    catch { continue; }
    if (!ptr?.slug) continue;
    const target = join(cwd, '.smt', 'features', ptr.slug, 'task', `${ptr.slug}.state.json`);
    if (existsSync(target)) return target;
  }
  return null;
}

function shouldRecord(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.task_type !== 'write') return false;
  if (!['TEST_DESIGN', 'EXECUTE'].includes(state.step)) return false;
  return true;
}

function alreadyRecordedRecently(state) {
  if (!Array.isArray(state.events)) return false;
  const now = Date.now();
  return state.events.some((e) => {
    if (e?.type !== 'test_red') return false;
    if (!e.t) return true;
    const ts = Date.parse(e.t);
    if (!Number.isFinite(ts)) return true;
    return now - ts < DEDUPE_WINDOW_MS;
  });
}

function main() {
  const input = readStdin();
  if (!input) { emit({ continue: true }); return; }
  if (input.tool_name !== 'Bash') { emit({ continue: true }); return; }

  const command = input.tool_input?.command ?? '';
  if (!TEST_COMMAND_RE.test(command)) { emit({ continue: true }); return; }

  const exitCode = input.tool_response?.exit_code;
  if (exitCode === 0 || exitCode === undefined || exitCode === null) {
    emit({ continue: true });
    return;
  }

  const statePath = resolveActiveStatePath(input.cwd, input.session_id);
  if (!statePath) { emit({ continue: true }); return; }

  let state;
  try { state = JSON.parse(readFileSync(statePath, 'utf-8')); }
  catch { emit({ continue: true }); return; }

  if (!shouldRecord(state)) { emit({ continue: true }); return; }
  if (alreadyRecordedRecently(state)) { emit({ continue: true }); return; }

  appendEvent(state, {
    type: 'test_red',
    skill: 'workflow-write-test',
    result: 'pass',
    declarer: 'hook',
    evidence: { type: 'exit_code', code: exitCode },
  });

  const prevFlag = process.env.SMT_HOOK_WRITE;
  process.env.SMT_HOOK_WRITE = '1';
  try {
    writeState(statePath, state);
  } catch {
    // Validation failed — do not crash the hook chain.
  } finally {
    if (prevFlag === undefined) delete process.env.SMT_HOOK_WRITE;
    else process.env.SMT_HOOK_WRITE = prevFlag;
  }

  emit({ continue: true });
}

main();
