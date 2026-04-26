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
import { dirname, join } from 'node:path';

import { appendEvent, writeState } from './state-schema.mjs';
import { resolveHookSessionId } from './lib/session-paths.mjs';

const TEST_COMMAND_RE = /\b(?:node\s+--test|node\s+--experimental-test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::[\w-]+)?|(?:npm|pnpm|yarn)\s+(?:exec\s+)?vitest\b|bun\s+test|vitest\b|npx\s+vitest\b)/;
const DEDUPE_WINDOW_MS = 5_000;

function readStdin() {
  try { return JSON.parse(readFileSync('/dev/stdin', 'utf-8')); }
  catch { return null; }
}

function emit(out) { process.stdout.write(JSON.stringify(out)); }

function outputText(input) {
  const chunks = [];
  for (const key of ['tool_response', 'toolResponse', 'tool_output', 'toolOutput', 'output']) {
    const value = input?.[key];
    if (!value) continue;
    if (typeof value === 'string') chunks.push(value);
    else if (typeof value === 'object') {
      for (const field of ['stdout', 'stderr', 'error', 'message']) {
        if (value[field]) chunks.push(String(value[field]));
      }
    }
  }
  for (const field of ['error', 'message']) {
    if (input?.[field]) chunks.push(String(input[field]));
  }
  return chunks.join('\n');
}

function hasMaskedFailureOutput(input) {
  return /^\s*exit=[1-9]\d*\s*$/m.test(outputText(input));
}

function normalizeExitCode(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function extractStructuredExitCode(input) {
  const sources = [
    input?.tool_response,
    input?.toolResponse,
    input?.tool_output,
    input?.toolOutput,
    input,
  ];

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of ['exit_code', 'exitCode', 'status']) {
      const code = normalizeExitCode(source[field]);
      if (code !== undefined) return code;
    }
  }

  return undefined;
}

function isBashToolName(toolName) {
  return /^Bash(?:\b|\()/i.test(String(toolName || ''));
}

function resolveWorkflowRoot(directory) {
  let current = directory || process.cwd();
  while (current) {
    if (existsSync(join(current, '.smt'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directory || process.cwd();
}

function resolveActiveStatePath(cwd, sessionId) {
  if (!cwd) return null;
  const root = resolveWorkflowRoot(cwd);
  const candidates = sessionId
    ? [join(root, '.smt', 'state', `active-feature-${sessionId}.json`)]
    : [];
  candidates.push(join(root, '.smt', 'state', 'active-feature.json'));

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let ptr;
    try { ptr = JSON.parse(readFileSync(p, 'utf-8')); }
    catch { continue; }
    if (!ptr?.slug) continue;

    // With a session id, the unscoped pointer is considered only when it
    // explicitly belongs to the same session. This reconciles pointer drift
    // without reading another session's workflow state.
    if (sessionId && p.endsWith('active-feature.json') && ptr.session_id !== sessionId) continue;

    const target = join(root, '.smt', 'features', ptr.slug, 'task', `${ptr.slug}.state.json`);
    if (!existsSync(target)) continue;

    let state;
    try { state = JSON.parse(readFileSync(target, 'utf-8')); }
    catch { continue; }
    if (shouldRecord(state)) return target;
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
  if (!isBashToolName(input.tool_name || input.toolName)) { emit({ continue: true }); return; }

  const command = input.tool_input?.command ?? input.toolInput?.command ?? '';
  if (!TEST_COMMAND_RE.test(command)) { emit({ continue: true }); return; }

  const exitCode = extractStructuredExitCode(input);
  if (exitCode === 0 || exitCode === undefined || exitCode === null) {
    if (exitCode === 0 && hasMaskedFailureOutput(input)) {
      emit({
        continue: true,
        systemMessage: '[SMELTER] RED not recorded: the actual Bash exit code was 0 even though output contained a non-zero exit=... line. Remove `; echo "exit=$?"` and let the test command itself exit non-zero, e.g. `set -o pipefail && node --test path/to/test.mjs`.',
      });
      return;
    }
    if (exitCode === undefined || exitCode === null) {
      emit({
        continue: true,
        systemMessage: '[SMELTER] RED not recorded: Bash PostToolUse payload had no structured exit code field. Trusted fields are tool_response/toolResponse/tool_output/toolOutput/output/top-level exit_code, exitCode, or status. Text output is not parsed as RED evidence.',
      });
      return;
    }
    emit({ continue: true });
    return;
  }

  const statePath = resolveActiveStatePath(input.cwd, resolveHookSessionId(input));
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
