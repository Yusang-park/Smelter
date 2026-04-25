#!/usr/bin/env node
/**
 * state-seeder.mjs — UserPromptSubmit hook bridge for cached detections.
 *
 * keyword-detector writes `.smt/state/last-detection-<sid>.json`; this hook
 * consumes that cache and delegates filesystem mutation to the pure
 * workflow-state-seeder library.
 */

import { readFileSync } from 'node:fs';

import { seedWorkflowState } from './lib/workflow-state-seeder.mjs';
import { sanitizeSessionId } from './lib/session-paths.mjs';
import { readLastDetection } from './lib/hook-guards.mjs';

function readStdin() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

function shouldSeed(detection) {
  if (!detection || detection.cancelled) return false;
  if (detection.kind !== 'slash' && detection.kind !== 'magic') return false;
  if (!detection.name) return false;
  return true;
}

async function main() {
  if (process.env.SMELTER_CLASSIFIER_SUBPROCESS === '1') {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { input = {}; }

  const cwd = input.cwd || process.cwd();
  const sessionId = sanitizeSessionId(input.session_id || input.sessionId || '');
  if (!sessionId) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const cached = readLastDetection({ cwd, sessionId });
  const detection = cached?.detection;
  if (!shouldSeed(detection)) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  seedWorkflowState({
    directory: cwd,
    commandName: detection.name,
    prompt: input.prompt || '',
    sessionId,
    args: detection.args || '',
    chainedModes: detection.chained_modes || detection.chainedModes || null,
    source: detection.source || detection.kind,
    preClassification: detection.classification || null,
    silent: true,
  });

  console.log(JSON.stringify({ continue: true }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
});
