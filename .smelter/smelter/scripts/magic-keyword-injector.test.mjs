/**
 * magic-keyword-injector.test.mjs — RED tests for magic-keyword-injector hook.
 *
 * Target: scripts/magic-keyword-injector.mjs (does not exist).
 * Reads .smt/state/last-detection-<sid>.json and emits [MAGIC KEYWORD]/
 * mode banner / [INTERRUPTED] additionalContext payloads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'magic-keyword-injector.mjs');

function seedDetection(cwd, sessionId, detection) {
  mkdirSync(join(cwd, '.smt', 'state'), { recursive: true });
  const file = join(cwd, '.smt', 'state', `last-detection-${sessionId}.json`);
  writeFileSync(file, JSON.stringify({
    session_id: sessionId, ts: Date.now(), prompt_hash: 'h', detection,
  }));
  return file;
}

function runInjector({ cwd, prompt, sessionId = 'inj-test', env = {} }) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify({ cwd, session_id: sessionId, prompt }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('MK1 slash detection emits [MAGIC KEYWORD: FIX] additionalContext', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mk-inj-'));
  try {
    seedDetection(cwd, 'mk-1', { kind: 'slash', name: 'fix', args: 'login bug', source: 'slash' });
    const out = runInjector({ cwd, prompt: '/fix login bug', sessionId: 'mk-1' });
    assert.equal(out.status, 0, `stderr=${out.stderr}`);
    const parsed = JSON.parse(out.stdout);
    assert.match(parsed.hookSpecificOutput?.additionalContext ?? '', /\[MAGIC KEYWORD: FIX\]/);
    assert.match(parsed.hookSpecificOutput?.additionalContext ?? '', /Skill: fix/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('MK2 magic detection emits [MAGIC KEYWORD: <NAME>] additionalContext', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mk-inj-'));
  try {
    seedDetection(cwd, 'mk-2', { kind: 'magic', name: 'fix', args: '버그', source: 'magic' });
    const out = runInjector({ cwd, prompt: '버그 고쳐줘', sessionId: 'mk-2' });
    const parsed = JSON.parse(out.stdout);
    assert.match(parsed.hookSpecificOutput?.additionalContext ?? '', /\[MAGIC KEYWORD: FIX\]/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('MK3 interrupted detection emits [INTERRUPTED] context', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mk-inj-'));
  try {
    seedDetection(cwd, 'mk-3', { kind: 'interrupt', name: null, interrupted: true });
    const out = runInjector({ cwd, prompt: 'whatever', sessionId: 'mk-3' });
    const parsed = JSON.parse(out.stdout);
    assert.match(parsed.hookSpecificOutput?.additionalContext ?? '', /INTERRUPTED|interrupt/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('MK4 cancelled flag skips emission', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mk-inj-'));
  try {
    seedDetection(cwd, 'mk-4', { kind: 'cancel', name: 'cancel', cancelled: true });
    const out = runInjector({ cwd, prompt: '/cancel', sessionId: 'mk-4' });
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.continue, true);
    assert.equal(parsed.hookSpecificOutput, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('MK5 passthrough detection skipped', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mk-inj-'));
  try {
    seedDetection(cwd, 'mk-5', { kind: 'passthrough', name: null });
    const out = runInjector({ cwd, prompt: 'git status', sessionId: 'mk-5' });
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.continue, true);
    assert.equal(parsed.hookSpecificOutput, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('MK6 mode banner emitted only once per session per mode', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mk-inj-'));
  try {
    seedDetection(cwd, 'mk-6', { kind: 'slash', name: 'fix', args: 'a', source: 'slash' });
    const first = runInjector({ cwd, prompt: '/fix a', sessionId: 'mk-6' });
    seedDetection(cwd, 'mk-6', { kind: 'slash', name: 'fix', args: 'b', source: 'slash' });
    const second = runInjector({ cwd, prompt: '/fix b', sessionId: 'mk-6' });
    const firstCtx = JSON.parse(first.stdout).hookSpecificOutput?.additionalContext ?? '';
    const secondCtx = JSON.parse(second.stdout).hookSpecificOutput?.additionalContext ?? '';
    const bannerRe = /Mode Banner|MODE: FIX/i;
    const firstHas = bannerRe.test(firstCtx);
    const secondHas = bannerRe.test(secondCtx);
    assert.ok(firstHas !== secondHas || (!firstHas && !secondHas), 'banner must not appear in both invocations');
    assert.ok(existsSync(join(cwd, '.smt', 'state', 'mode-emitted-mk-6.json')), 'mode-emitted bookkeeping must exist');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('MK7 reentrancy guard bails on SMELTER_CLASSIFIER_SUBPROCESS=1', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mk-inj-'));
  try {
    seedDetection(cwd, 'mk-7', { kind: 'slash', name: 'fix', source: 'slash' });
    const out = runInjector({
      cwd, prompt: '/fix x', sessionId: 'mk-7',
      env: { SMELTER_CLASSIFIER_SUBPROCESS: '1' },
    });
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.continue, true);
    assert.equal(parsed.hookSpecificOutput, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
