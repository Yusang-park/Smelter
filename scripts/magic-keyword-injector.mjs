#!/usr/bin/env node
/**
 * magic-keyword-injector.mjs — emits mode/skill context from cached detections.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveHookSessionId } from './lib/session-paths.mjs';
import { readLastDetection } from './lib/hook-guards.mjs';

function readStdin() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function output(additionalContext = '') {
  const payload = additionalContext
    ? { continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }
    : { continue: true };
  console.log(JSON.stringify(payload));
}

function modeBookPath(cwd, sessionId) {
  return join(cwd, '.smt', 'state', `mode-emitted-${sessionId}.json`);
}

function maybeModeBanner(cwd, sessionId, name) {
  const path = modeBookPath(cwd, sessionId);
  const emitted = readJson(path) || {};
  if (emitted[name]) return '';
  emitted[name] = true;
  writeJson(path, emitted);
  return `\n[Mode Banner] MODE: ${String(name).toUpperCase()}`;
}

async function main() {
  if (process.env.SMELTER_CLASSIFIER_SUBPROCESS === '1') return output();

  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { input = {}; }

  const cwd = input.cwd || process.cwd();
  const sessionId = resolveHookSessionId(input);
  if (!sessionId) return output();

  const cached = readLastDetection({ cwd, sessionId });
  const detection = cached?.detection;
  if (!detection || detection.cancelled) return output();

  if (detection.kind === 'interrupt' || detection.interrupted) {
    return output('[INTERRUPTED] Prior workflow signal was interrupted; preserve state and wait for the next explicit intent.');
  }

  if ((detection.kind === 'slash' || detection.kind === 'magic') && detection.name) {
    const name = String(detection.name);
    const banner = maybeModeBanner(cwd, sessionId, name);
    const skillLine = detection.kind === 'slash' ? `\nSkill: ${name}` : '';
    return output(`[MAGIC KEYWORD: ${name.toUpperCase()}]${skillLine}${banner}`);
  }

  return output();
}

main().catch(() => output());
