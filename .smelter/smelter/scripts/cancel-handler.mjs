#!/usr/bin/env node
/**
 * cancel-handler.mjs — UserPromptSubmit hook for cancel/queue detections.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveHookSessionId } from './lib/session-paths.mjs';
import { readLastDetection } from './lib/hook-guards.mjs';

function readStdin() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function output(additionalContext = '') {
  const payload = additionalContext
    ? { continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }
    : { continue: true };
  console.log(JSON.stringify(payload));
}

async function main() {
  if (process.env.SMELTER_CLASSIFIER_SUBPROCESS === '1') return output();

  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { input = {}; }

  const cwd = input.cwd || process.cwd();
  const sessionId = resolveHookSessionId(input);
  if (!sessionId) return output();

  const file = join(cwd, '.smt', 'state', `last-detection-${sessionId}.json`);
  if (!existsSync(file)) return output();

  const cached = readLastDetection({ cwd, sessionId });
  const detection = cached?.detection;
  if (!detection) return output();

  if (detection.kind === 'cancel' || detection.name === 'cancel') {
    detection.cancelled = true;
    cached.detection = detection;
    writeJson(file, cached);
    return output('[CANCEL] Current Smelter workflow request was cancelled. Do not seed downstream workflow state.');
  }

  if (detection.kind === 'queue' || detection.name === 'queue') {
    const args = detection.args ? ` ${detection.args}` : '';
    return output(`[QUEUED]${args}`.trim());
  }

  return output();
}

main().catch(() => output());
