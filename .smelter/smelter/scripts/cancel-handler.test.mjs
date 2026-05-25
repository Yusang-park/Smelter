/**
 * cancel-handler.test.mjs — RED tests for cancel/queue UserPromptSubmit hook.
 *
 * Target: scripts/cancel-handler.mjs (does not exist).
 * Surface: spawn child_process with stdin {cwd, session_id, prompt} and
 * pre-written .smt/state/last-detection-<sid>.json (produced upstream by
 * keyword-detector). Output is JSON on stdout: {continue, hookSpecificOutput}.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'cancel-handler.mjs');

function seedDetection(cwd, sessionId, detection) {
  mkdirSync(join(cwd, '.smt', 'state'), { recursive: true });
  const file = join(cwd, '.smt', 'state', `last-detection-${sessionId}.json`);
  const payload = {
    session_id: sessionId,
    ts: Date.now(),
    prompt_hash: 'abc123',
    detection,
  };
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

function runHandler({ cwd, prompt, sessionId = 'cancel-test', env = {} }) {
  const input = JSON.stringify({ cwd, session_id: sessionId, prompt });
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    input, encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return result;
}

test('CH1 cancel detection emits [CANCEL] additionalContext', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cancel-handler-'));
  try {
    seedDetection(cwd, 'sess-cancel', { kind: 'cancel', name: 'cancel', args: '' });
    const out = runHandler({ cwd, prompt: '/cancel', sessionId: 'sess-cancel' });
    assert.equal(out.status, 0, `stderr=${out.stderr}`);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.continue, true);
    assert.match(parsed.hookSpecificOutput?.additionalContext ?? '', /\[CANCEL\]/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CH2 queue detection emits [QUEUED] additionalContext', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cancel-handler-'));
  try {
    seedDetection(cwd, 'sess-queue', { kind: 'queue', name: 'queue', args: '나중에 로그인 수정' });
    const out = runHandler({ cwd, prompt: '/queue 나중에 로그인 수정', sessionId: 'sess-queue' });
    assert.equal(out.status, 0);
    const parsed = JSON.parse(out.stdout);
    assert.match(parsed.hookSpecificOutput?.additionalContext ?? '', /\[QUEUED\]/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CH3 no-detection-file is no-op {continue:true}', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cancel-handler-'));
  try {
    mkdirSync(join(cwd, '.smt', 'state'), { recursive: true });
    const out = runHandler({ cwd, prompt: 'hi', sessionId: 'sess-none' });
    assert.equal(out.status, 0);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.continue, true);
    assert.equal(parsed.hookSpecificOutput, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CH4 passthrough detection skipped (no [CANCEL] emit)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cancel-handler-'));
  try {
    seedDetection(cwd, 'sess-pass', { kind: 'passthrough', name: null, args: '' });
    const out = runHandler({ cwd, prompt: 'git status', sessionId: 'sess-pass' });
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.continue, true);
    assert.equal(parsed.hookSpecificOutput, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CH5 reentrancy guard bails on SMELTER_CLASSIFIER_SUBPROCESS=1', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cancel-handler-'));
  try {
    seedDetection(cwd, 'sess-re', { kind: 'cancel', name: 'cancel' });
    const out = runHandler({
      cwd, prompt: '/cancel', sessionId: 'sess-re',
      env: { SMELTER_CLASSIFIER_SUBPROCESS: '1' },
    });
    assert.equal(out.status, 0);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.continue, true);
    assert.equal(parsed.hookSpecificOutput, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CH6 cancel sets cancelled=true in last-detection.json (downstream skip signal)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cancel-handler-'));
  try {
    const file = seedDetection(cwd, 'sess-flag', { kind: 'cancel', name: 'cancel' });
    runHandler({ cwd, prompt: '/cancel', sessionId: 'sess-flag' });
    assert.equal(existsSync(file), true);
    const updated = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(updated.detection.cancelled, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
