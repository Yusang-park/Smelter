/**
 * state-seeder.test.mjs — RED tests for state-seeder UserPromptSubmit hook.
 *
 * Target: scripts/state-seeder.mjs (does not exist).
 * Reads .smt/state/last-detection-<sid>.json and seeds .smt/features/<slug>/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'state-seeder.mjs');

function seedDetection(cwd, sessionId, detection) {
  mkdirSync(join(cwd, '.smt', 'state'), { recursive: true });
  const file = join(cwd, '.smt', 'state', `last-detection-${sessionId}.json`);
  writeFileSync(file, JSON.stringify({
    session_id: sessionId, ts: Date.now(), prompt_hash: 'h', detection,
  }));
  return file;
}

function runSeeder({ cwd, prompt, sessionId = 'seed-test', env = {} }) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify({ cwd, session_id: sessionId, prompt }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function findFeature(cwd) {
  const dir = join(cwd, '.smt', 'features');
  if (!existsSync(dir)) return null;
  const slugs = readdirSync(dir);
  return slugs.length ? slugs[0] : null;
}

test('SS1 slash detection seeds feature dir + state.json (happy path)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'state-seeder-'));
  try {
    seedDetection(cwd, 'sid-1', {
      kind: 'slash', name: 'fix', args: 'login bug', source: 'slash', intent: 'new',
    });
    const out = runSeeder({ cwd, prompt: '/fix login bug', sessionId: 'sid-1' });
    assert.equal(out.status, 0, `stderr=${out.stderr}`);
    const slug = findFeature(cwd);
    assert.ok(slug, 'feature dir not created');
    const state = JSON.parse(readFileSync(join(cwd, '.smt', 'features', slug, 'task', `${slug}.state.json`), 'utf8'));
    assert.equal(state.mode, 'fix');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SS2 magic detection with intent=new creates new feature', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'state-seeder-'));
  try {
    seedDetection(cwd, 'sid-2', {
      kind: 'magic', name: 'fix', args: '버그', source: 'magic', intent: 'new',
    });
    runSeeder({ cwd, prompt: '버그 고쳐줘', sessionId: 'sid-2' });
    const slug = findFeature(cwd);
    assert.ok(slug, 'new feature must be created on intent=new');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SS3 magic detection with intent=continue reuses active feature', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'state-seeder-'));
  try {
    seedDetection(cwd, 'sid-3a', { kind: 'magic', name: 'fix', source: 'magic', intent: 'new', args: 'x' });
    runSeeder({ cwd, prompt: 'first', sessionId: 'sid-3a' });
    const firstSlug = findFeature(cwd);

    seedDetection(cwd, 'sid-3a', { kind: 'magic', name: 'fix', source: 'magic', intent: 'continue', args: 'y' });
    runSeeder({ cwd, prompt: 'continue', sessionId: 'sid-3a' });
    const slugs = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(slugs.length, 1, 'continue must not create new feature');
    assert.equal(slugs[0], firstSlug);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SS4 cancelled flag in detection skips seeding', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'state-seeder-'));
  try {
    seedDetection(cwd, 'sid-4', { kind: 'cancel', name: 'cancel', cancelled: true });
    runSeeder({ cwd, prompt: '/cancel', sessionId: 'sid-4' });
    assert.equal(existsSync(join(cwd, '.smt', 'features')), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SS5 passthrough detection skipped (no feature seeded)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'state-seeder-'));
  try {
    seedDetection(cwd, 'sid-5', { kind: 'passthrough', name: null });
    runSeeder({ cwd, prompt: 'git status', sessionId: 'sid-5' });
    assert.equal(existsSync(join(cwd, '.smt', 'features')), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SS6 no last-detection.json present is no-op {continue:true}', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'state-seeder-'));
  try {
    mkdirSync(join(cwd, '.smt', 'state'), { recursive: true });
    const out = runSeeder({ cwd, prompt: 'whatever', sessionId: 'sid-6' });
    assert.equal(out.status, 0);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.continue, true);
    assert.equal(existsSync(join(cwd, '.smt', 'features')), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SS7 reentrancy guard bails on SMELTER_CLASSIFIER_SUBPROCESS=1', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'state-seeder-'));
  try {
    seedDetection(cwd, 'sid-7', { kind: 'slash', name: 'fix', source: 'slash' });
    runSeeder({ cwd, prompt: '/fix x', sessionId: 'sid-7', env: { SMELTER_CLASSIFIER_SUBPROCESS: '1' } });
    assert.equal(existsSync(join(cwd, '.smt', 'features')), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SS8 detection without classifier success (kind=none) skips seeding', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'state-seeder-'));
  try {
    seedDetection(cwd, 'sid-8', { kind: 'none', name: null });
    const out = runSeeder({ cwd, prompt: 'foo', sessionId: 'sid-8' });
    assert.equal(out.status, 0);
    assert.equal(existsSync(join(cwd, '.smt', 'features')), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
