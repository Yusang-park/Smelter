// Tests for scripts/step-injector.mjs and scripts/step-tracker.mjs.
// Run: node scripts/step-engine.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parseYaml } from './lib/yaml-parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INJECTOR = join(__dirname, 'step-injector.mjs');
const TRACKER = join(__dirname, 'step-tracker.mjs');

function runScript(scriptPath, payload, { cwd } = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function makeFeatureDir(baseDir, slug, workflowState = null) {
  const featureDir = join(baseDir, '.smt', 'features', slug);
  const taskDir = join(featureDir, 'task');
  const stateDir = join(featureDir, 'state');
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(taskDir, '_overview.md'), `# ${slug}\n`);
  if (workflowState) {
    writeFileSync(join(stateDir, 'workflow.json'), JSON.stringify(workflowState, null, 2));
  }
}

function setActivePointer(baseDir, slug) {
  const stateDir = join(baseDir, '.smt', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'active-feature.json'), JSON.stringify({ slug, updated_at: Date.now() }));
}

function readState(baseDir, slug) {
  return JSON.parse(readFileSync(join(baseDir, '.smt/features', slug, 'state/workflow.json'), 'utf-8'));
}

// -----------------------------------------------------------------------------
// YAML parser tests
// -----------------------------------------------------------------------------

{
  const y = parseYaml(`name: feat
description: "Full 10-step: workflow"
steps:
  step-1:
    name: Problem Recognition
    next: step-2
  step-2:
    name: Learning
    on_fail:
      code_quality: step-5
      security: step-5
    options: [rework:step-3, complete, hold]
`);
  assert.equal(y.name, 'feat');
  assert.equal(y.description, 'Full 10-step: workflow', 'quoted string with colon preserved');
  assert.equal(y.steps['step-1'].next, 'step-2');
  assert.deepEqual(y.steps['step-2'].on_fail, { code_quality: 'step-5', security: 'step-5' });
  assert.deepEqual(y.steps['step-2'].options, ['rework:step-3', 'complete', 'hold']);
  console.log('  yaml parser (quoted, nested maps, flow list) OK');
}

{
  const y = parseYaml(`list:
  - alpha
  - beta
`);
  assert.deepEqual(y.list, ['alpha', 'beta'], 'block list form parsed');
  console.log('  yaml parser (block list) OK');
}

// -----------------------------------------------------------------------------
// step-injector tests
// -----------------------------------------------------------------------------

// Case 1: no active workflow → no-op
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput);
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 1 (no workflow) OK');
}

// Case 2: step-1 prompt injected
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-1', retry: 0, updated_at: Date.now() });
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Workflow: feat/);
  assert.match(ctx, /step-1/);
  assert.match(ctx, /Problem Recognition/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 2 (step-1 prompt) OK');
}

// Case 3: gate step → PAUSE
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-3-interview', retry: 0, updated_at: Date.now() });
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /GATE — PAUSE/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 3 (gate pause) OK');
}

// Case 4: retry shown
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-5', retry: 2, updated_at: Date.now() });
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Retry 2/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 4 (retry tag) OK');
}

// Case 5: explicit active-feature pointer wins over mtime
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-inj-'));
  const newer = Date.now();
  const older = newer - 60_000;
  makeFeatureDir(dir, 'older', { command: 'feat', step: 'step-1', retry: 0, updated_at: older });
  makeFeatureDir(dir, 'newer', { command: 'qa', step: 'step-4', retry: 0, updated_at: newer });
  setActivePointer(dir, 'older'); // user explicitly selects older
  const res = runScript(INJECTOR, { cwd: dir }, { cwd: dir });
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Workflow: feat/, 'explicit pointer overrides mtime fallback');
  assert.match(ctx, /older/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  injector case 5 (explicit active pointer) OK');
}

// -----------------------------------------------------------------------------
// step-tracker tests
// -----------------------------------------------------------------------------

// Case 6: no workflow
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.equal(JSON.parse(res.stdout).continue, true);
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 6 (no workflow) OK');
}

// Case 7: gate step — no auto-advance
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-3-interview', retry: 0, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.ok(!JSON.parse(res.stdout).hookSpecificOutput);
  assert.equal(readState(dir, 'demo').step, 'step-3-interview');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 7 (gate no auto-advance) OK');
}

// Case 8: gate pass → advance
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-4', retry: 0, signals: { tests_exist_and_red: true }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /step-4 complete → step-5/);
  const state = readState(dir, 'demo');
  assert.equal(state.step, 'step-5');
  assert.deepEqual(state.signals, {}, 'signals reset on advance');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 8 (gate pass → advance) OK');
}

// Case 9: FAIL-CLOSED — absent signal does NOT advance
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-4', retry: 0, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'no signal → no advance context');
  assert.equal(readState(dir, 'demo').step, 'step-4', 'fail-closed: stays on step-4');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 9 (fail-closed: absent signal waits) OK');
}

// Case 10: on_fail string route
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-7', retry: 0, signals: { tests_pass_and_build_clean: false }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /step-7 failed → step-5/);
  assert.equal(readState(dir, 'demo').step, 'step-5');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 10 (on_fail string route) OK');
}

// Case 11: on_fail map route by failure_category
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-6', retry: 0, signals: { review_clean: false, failure_category: 'plan_mismatch' }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /plan_mismatch.*step-3/);
  assert.equal(readState(dir, 'demo').step, 'step-3');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 11 (on_fail map route) OK');
}

// Case 12: on_fail map "continue" category (low) → advance to next
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-9', retry: 0, signals: { team_review_clean: false, failure_category: 'low' }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /low.*continue/);
  assert.equal(readState(dir, 'demo').step, 'step-10', 'low → continue → next step');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 12 (on_fail low → continue) OK');
}

// Case 13: retry increment
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-5', retry: 0, signals: { tests_green: false }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /retry 1\/3/);
  assert.equal(readState(dir, 'demo').retry, 1);
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 13 (retry increment) OK');
}

// Case 14: max_retry exceeded → on_max_retry
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-5', retry: 2, signals: { tests_green: false }, updated_at: Date.now() });
  const res = runScript(TRACKER, { cwd: dir }, { cwd: dir });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /exceeded retry budget/);
  assert.equal(readState(dir, 'demo').step, 'step-2');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 14 (max_retry → on_max_retry) OK');
}

// Case 15: tracker updates active-feature pointer
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'auth', { command: 'feat', step: 'step-4', retry: 0, signals: { tests_exist_and_red: true }, updated_at: Date.now() });
  runScript(TRACKER, { cwd: dir }, { cwd: dir });
  const pointer = JSON.parse(readFileSync(join(dir, '.smt/state/active-feature.json'), 'utf-8'));
  assert.equal(pointer.slug, 'auth');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 15 (active-feature pointer written) OK');
}

// Case 16: atomic write — no tmp files left behind
{
  const dir = mkdtempSync(join(tmpdir(), 'smt-trk-'));
  makeFeatureDir(dir, 'demo', { command: 'feat', step: 'step-4', retry: 0, signals: { tests_exist_and_red: true }, updated_at: Date.now() });
  runScript(TRACKER, { cwd: dir }, { cwd: dir });
  const files = readdirSync(join(dir, '.smt/features/demo/state'));
  const tmpFiles = files.filter(f => f.includes('.tmp.'));
  assert.equal(tmpFiles.length, 0, 'no tmp files after atomic write');
  rmSync(dir, { recursive: true, force: true });
  console.log('  tracker case 16 (atomic write, no tmp left) OK');
}

console.log('step-engine: OK');

// helper
import { readdirSync } from 'node:fs';
