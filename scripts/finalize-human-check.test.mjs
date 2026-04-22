#!/usr/bin/env node
/**
 * finalize-human-check.test.mjs — PostToolUse:Write hook that closes the
 * workflow-human-check deadlock by writing pass event + completed_stages +
 * current_stage='done' when the agent writes `results.md` under a canonical
 * task directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'finalize-human-check.mjs');

function runHook({ cwd, toolName = 'Write', filePath, content = 'ok' }) {
  // The hook only needs file_path; content on disk is what matters (the hook
  // reads the file via fs.statSync). Caller is responsible for pre-seeding.
  const payload = JSON.stringify({
    cwd,
    tool_name: toolName,
    tool_input: { file_path: filePath, content },
  });
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env },
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

function seedFeature(cwd, { slug = 'my-feat', mode = 'fix', currentStage = 'workflow-human-check', events = [], completed = [] } = {}) {
  const taskDir = join(cwd, '.smt', 'features', slug, 'task');
  mkdirSync(taskDir, { recursive: true });
  const statePath = join(taskDir, `${slug}.state.json`);
  const state = {
    schema_version: '2.4.1',
    task_id: slug,
    mode,
    allowed_skills: ['workflow-coding', 'workflow-human-check'],
    current_stage: currentStage,
    completed_stages: completed,
    events,
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { taskDir, statePath, resultsPath: join(taskDir, 'results.md') };
}

function readState(p) { return JSON.parse(readFileSync(p, 'utf-8')); }

// ── Happy path ─────────────────────────────────────────────────────────────
test('H1: Write of results.md at workflow-human-check stage finalizes state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-h1-'));
  try {
    const { statePath, resultsPath } = seedFeature(cwd);
    writeFileSync(resultsPath, '# results\n\ncomplete');
    const r = runHook({ cwd, filePath: resultsPath });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    const state = readState(statePath);
    // current_stage stays at 'workflow-human-check' — WORKFLOW_SKILLS enum
    // rejects 'done'. Terminal release relies on completed_stages + events.
    assert.equal(state.current_stage, 'workflow-human-check');
    assert.ok(state.completed_stages.includes('workflow-human-check'), 'completed_stages must include workflow-human-check');
    const pass = state.events.find(e => e.skill === 'workflow-human-check' && e.result === 'pass');
    assert.ok(pass, 'pass event must be present');
    assert.equal(pass.evidence?.path, 'results.md');
    assert.equal(pass.declarer, 'hook');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('H2: idempotent — second invocation does not duplicate pass event', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-h2-'));
  try {
    const { statePath, resultsPath } = seedFeature(cwd);
    writeFileSync(resultsPath, 'ok');
    runHook({ cwd, filePath: resultsPath });
    runHook({ cwd, filePath: resultsPath });
    const state = readState(statePath);
    const passCount = state.events.filter(e => e.skill === 'workflow-human-check' && e.result === 'pass').length;
    assert.equal(passCount, 1, 'pass event must not duplicate');
    const completedCount = state.completed_stages.filter(s => s === 'workflow-human-check').length;
    assert.equal(completedCount, 1, 'completed_stages must not duplicate');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('H3: implement mode also finalizes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-h3-'));
  try {
    const { statePath, resultsPath } = seedFeature(cwd, { mode: 'implement' });
    writeFileSync(resultsPath, 'ok');
    runHook({ cwd, filePath: resultsPath });
    const state = readState(statePath);
    assert.ok(state.completed_stages.includes('workflow-human-check'));
    assert.ok(state.events.some(e => e.skill === 'workflow-human-check' && e.result === 'pass'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Boundary ───────────────────────────────────────────────────────────────
test('B1: non-Write tool (Edit) is a no-op', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-b1-'));
  try {
    const { statePath, resultsPath } = seedFeature(cwd);
    writeFileSync(resultsPath, 'ok');
    runHook({ cwd, toolName: 'Edit', filePath: resultsPath });
    const state = readState(statePath);
    assert.equal(state.current_stage, 'workflow-human-check', 'Edit must not finalize');
    assert.equal(state.events.length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('B2: non-results filename is a no-op', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-b2-'));
  try {
    const { taskDir, statePath } = seedFeature(cwd);
    const otherPath = join(taskDir, 'investigation.md');
    writeFileSync(otherPath, 'ok');
    runHook({ cwd, filePath: otherPath });
    assert.equal(readState(statePath).current_stage, 'workflow-human-check');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('B3: results.md outside .smt/features/*/task/ is ignored', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-b3-'));
  try {
    seedFeature(cwd);
    const strayPath = join(cwd, 'docs', 'results.md');
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    writeFileSync(strayPath, 'ok');
    const r = runHook({ cwd, filePath: strayPath });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    // Seeded feature remains unfinalized.
    const { statePath } = seedFeature(cwd);
    assert.equal(readState(statePath).current_stage, 'workflow-human-check');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Error / guard paths ────────────────────────────────────────────────────
test('E1: results.md empty (zero-byte) is a no-op', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-e1-'));
  try {
    const { statePath, resultsPath } = seedFeature(cwd);
    writeFileSync(resultsPath, ''); // zero bytes
    runHook({ cwd, filePath: resultsPath });
    assert.equal(readState(statePath).current_stage, 'workflow-human-check', 'empty evidence must not finalize');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('E2: wrong mode (investigate) is a no-op', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-e2-'));
  try {
    const { statePath, resultsPath } = seedFeature(cwd, { mode: 'investigate' });
    writeFileSync(resultsPath, 'ok');
    runHook({ cwd, filePath: resultsPath });
    assert.equal(readState(statePath).current_stage, 'workflow-human-check');
    assert.equal(readState(statePath).events.length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('E3: wrong current_stage (workflow-coding) is a no-op', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-e3-'));
  try {
    const { statePath, resultsPath } = seedFeature(cwd, { currentStage: 'workflow-coding' });
    writeFileSync(resultsPath, 'ok');
    runHook({ cwd, filePath: resultsPath });
    assert.equal(readState(statePath).current_stage, 'workflow-coding');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('E4: missing state.json is a no-op (no crash)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-e4-'));
  try {
    const taskDir = join(cwd, '.smt', 'features', 'orphan', 'task');
    mkdirSync(taskDir, { recursive: true });
    const resultsPath = join(taskDir, 'results.md');
    writeFileSync(resultsPath, 'ok');
    const r = runHook({ cwd, filePath: resultsPath });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).continue, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('E5: results.md symlink is rejected (no finalize)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-e5-'));
  try {
    const { statePath, resultsPath } = seedFeature(cwd);
    const decoy = join(cwd, 'decoy.txt');
    writeFileSync(decoy, 'attacker-chosen content — non-empty');
    symlinkSync(decoy, resultsPath);
    runHook({ cwd, filePath: resultsPath });
    const state = readState(statePath);
    assert.equal(state.current_stage, 'workflow-human-check');
    assert.equal(state.events.length, 0);
    assert.ok(!state.completed_stages.includes('workflow-human-check'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('E6: state.json symlink is rejected (no write-through symlink)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-e6-'));
  try {
    const slug = 'my-feat';
    const taskDir = join(cwd, '.smt', 'features', slug, 'task');
    mkdirSync(taskDir, { recursive: true });
    // Real state file sits at an outside location; symlink from canonical path.
    const realState = join(cwd, 'real-state.json');
    writeFileSync(realState, JSON.stringify({ mode: 'fix', current_stage: 'workflow-human-check', events: [], completed_stages: [] }));
    const statePath = join(taskDir, `${slug}.state.json`);
    symlinkSync(realState, statePath);
    const resultsPath = join(taskDir, 'results.md');
    writeFileSync(resultsPath, 'ok');
    runHook({ cwd, filePath: resultsPath });
    // The real state (follows symlink) must not be finalized via the symlink
    // write path — hook should reject once it detects the symlink.
    const real = JSON.parse(readFileSync(realState, 'utf-8'));
    assert.equal(real.current_stage, 'workflow-human-check');
    assert.equal(real.events.length, 0, 'hook must not write through symlinked state.json');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Integration ────────────────────────────────────────────────────────────
test('I1: hook always emits {continue:true} and never blocks', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fhc-i1-'));
  try {
    // Deliberately broken state file.
    const { taskDir } = seedFeature(cwd);
    writeFileSync(join(taskDir, 'my-feat.state.json'), '{ broken json');
    writeFileSync(join(taskDir, 'results.md'), 'ok');
    const r = runHook({ cwd, filePath: join(taskDir, 'results.md') });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    assert.notEqual(out.decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
