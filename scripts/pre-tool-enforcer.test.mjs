#!/usr/bin/env node
/**
 * pre-tool-enforcer.test.mjs — Direct-edit guard for .state.json files.
 * Feature: harness-integrity-4-fixes T2
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'pre-tool-enforcer.mjs');

function runEnforcer({ cwd, toolName, toolInput, sessionId = 't2', env = {} }) {
  const payload = JSON.stringify({ cwd, session_id: sessionId, tool_name: toolName, tool_input: toolInput });
  // Strip SMT_HOOK_WRITE from the inherited environment — this test suite
  // pins the enforcer's default (agent-invoked) behavior, where the escape
  // hatch is NOT set. Leaking the parent env's SMT_HOOK_WRITE=1 (present when
  // the test runs inside a Smelter hook-driven session) would bypass every
  // protected-path/code-file/git-commit gate and mask real failures. Callers
  // that want to exercise the bypass pass `env: { SMT_HOOK_WRITE: '1' }`
  // explicitly (see T2-C1) — the spread below lets them re-enable it.
  const { SMT_HOOK_WRITE, ...parentEnv } = process.env;
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: payload,
    encoding: 'utf8',
    env: { ...parentEnv, ...env },
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

function parseOut(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

// v3.3: seed an active /fix (or /implement) workflow so code-file Edit/Write
// passes the v3.3 gate in pre-tool-enforcer.mjs. The gate reads
//   .smt/state/active-feature-<sid>.json → {slug}
//   .smt/features/<slug>/task/<slug>.state.json → {mode}
// and allows Edit/Write only when mode ∈ {fix, implement}.
function seedActiveWorkflow(cwd, { sessionId = 't2', slug = 'seed', mode = 'fix', task_type = undefined, step = undefined, allowed_actions = undefined } = {}) {
  const stateDir = join(cwd, '.smt', 'state');
  const taskDir = join(cwd, '.smt', 'features', slug, 'task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(stateDir, `active-feature-${sessionId}.json`), JSON.stringify({ slug }));
  const state = { mode, completed_stages: [], events: [] };
  if (task_type !== undefined) state.task_type = task_type;
  if (step !== undefined) state.step = step;
  if (allowed_actions !== undefined) state.allowed_actions = allowed_actions;
  writeFileSync(join(taskDir, `${slug}.state.json`), JSON.stringify(state));
}

// ── Happy path ─────────────────────────────────────────────────────────────
test('T2-H1: Write on unrelated code file with active /fix workflow is allowed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-h1-'));
  try {
    seedActiveWorkflow(cwd);
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/src/foo.ts`, content: 'x' } });
    const out = parseOut(r.stdout);
    assert.ok(out, 'parse output');
    assert.notEqual(out.decision, 'block', `unrelated Write blocked under active fix mode: ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-H1b: v0.4 task_type overrides legacy mode for code-file write gate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-h1b-'));
  try {
    seedActiveWorkflow(cwd, { mode: 'fix', task_type: 'read' });
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/src/foo.ts`, content: 'x' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block', `v0.4 read task_type must block source write even when legacy mode=fix: ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-H1c: v0.4 write task blocks source edit before EXECUTE step', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-h1c-'));
  try {
    seedActiveWorkflow(cwd, { mode: 'fix', task_type: 'write' });
    const taskDir = join(cwd, '.smt', 'features', 'seed', 'task');
    const statePath = join(taskDir, 'seed.state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    Object.assign(state, { user_mode: 'fix', step: 'TEST_DESIGN', allowed_actions: ['read', 'write_test', 'run_test'] });
    writeFileSync(statePath, JSON.stringify(state));

    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/src/foo.ts`, content: 'x' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block', `v0.4 guard must block before EXECUTE: ${JSON.stringify(out)}`);
    assert.match(out.reason, /step=TEST_DESIGN|v0\.4 guard/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-H1c2: v0.4 write task allows test file Write during TEST_DESIGN', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-h1c2-'));
  try {
    seedActiveWorkflow(cwd, { mode: 'implement', task_type: 'write' });
    const taskDir = join(cwd, '.smt', 'features', 'seed', 'task');
    const statePath = join(taskDir, 'seed.state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    Object.assign(state, { user_mode: 'implement', step: 'TEST_DESIGN', allowed_actions: ['read', 'write_test', 'run_test'] });
    writeFileSync(statePath, JSON.stringify(state));

    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/scripts/lib/hook-guards.test.mjs`, content: 'x' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `test Write should be allowed during TEST_DESIGN: ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-H1c3: v0.4 guard blocks workflow artifact writes when write_artifact is not allowed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v04-artifact-'));
  try {
    seedActiveWorkflow(cwd, { sessionId: 't2-artifact', slug: 'demo', mode: 'fix', task_type: 'write', step: 'TEST_DESIGN', allowed_actions: ['write_test'] });
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: join(cwd, '.smt/features/demo/task/plan.md') }, sessionId: 't2-artifact' });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block', `artifact write must be blocked outside write_artifact action: ${JSON.stringify(out)}`);
    assert.match(out.reason, /artifact write not allowed/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-H1d: v0.4 write task blocks EXECUTE source edit without red test evidence', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-h1d-'));
  try {
    seedActiveWorkflow(cwd, { mode: 'fix', task_type: 'write' });
    const taskDir = join(cwd, '.smt', 'features', 'seed', 'task');
    const statePath = join(taskDir, 'seed.state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    Object.assign(state, { user_mode: 'fix', step: 'EXECUTE', allowed_actions: ['read', 'write_source', 'run_test'] });
    writeFileSync(statePath, JSON.stringify(state));

    const r = runEnforcer({ cwd, toolName: 'Edit', toolInput: { file_path: `${cwd}/src/foo.ts`, old_string: 'a', new_string: 'b' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block', `v0.4 guard must require red test evidence: ${JSON.stringify(out)}`);
    assert.match(out.reason, /red test/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-H1e: v0.4 write task allows EXECUTE source edit with legacy red test evidence', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-h1e-'));
  try {
    seedActiveWorkflow(cwd, { mode: 'fix', task_type: 'write' });
    const taskDir = join(cwd, '.smt', 'features', 'seed', 'task');
    const statePath = join(taskDir, 'seed.state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    Object.assign(state, {
      user_mode: 'fix',
      step: 'EXECUTE',
      allowed_actions: ['read', 'write_source', 'run_test'],
      test_cycles: [{ action: 'added_case', run_result: 'fail' }],
    });
    writeFileSync(statePath, JSON.stringify(state));

    const r = runEnforcer({ cwd, toolName: 'Edit', toolInput: { file_path: `${cwd}/src/foo.ts`, old_string: 'a', new_string: 'b' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `v0.4 guard should allow EXECUTE after red test: ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-H2: Read on state.json is allowed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-h2-'));
  try {
    const r = runEnforcer({ cwd, toolName: 'Read', toolInput: { file_path: `${cwd}/.smt/features/x/task/x.state.json` } });
    const out = parseOut(r.stdout);
    assert.ok(out);
    assert.notEqual(out.decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Boundary: path-shape variants ──────────────────────────────────────────
test('T2-B1: Write on .smt/features/<slug>/task/<slug>.state.json is BLOCKED', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-b1-'));
  try {
    const target = `${cwd}/.smt/features/my-feat/task/my-feat.state.json`;
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: target, content: '{}' } });
    const out = parseOut(r.stdout);
    assert.ok(out, 'parse output');
    assert.equal(out.decision, 'block', `expected block, got ${JSON.stringify(out)}`);
    assert.match(out.reason, /state\.json/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-B2: Edit on .state.json is BLOCKED', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-b2-'));
  try {
    const target = `${cwd}/.smt/features/feat/task/feat.state.json`;
    const r = runEnforcer({ cwd, toolName: 'Edit', toolInput: { file_path: target, old_string: 'a', new_string: 'b' } });
    const out = parseOut(r.stdout);
    assert.ok(out);
    assert.equal(out.decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Error path: common agent bypass attempts ───────────────────────────────
test('T2-E1: slug with dashes and unicode also blocked', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-e1-'));
  try {
    const target = `${cwd}/.smt/features/my-한글-슬러그/task/my-한글-슬러그.state.json`;
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: target, content: '{}' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-E2: other .smt/ json (workflow.json) NOT blocked (out of scope)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-e2-'));
  try {
    const target = `${cwd}/.smt/features/feat/state/workflow.json`;
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: target, content: '{}' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Edge case ──────────────────────────────────────────────────────────────
test('T2-C1: SMT_HOOK_WRITE=1 env bypasses block', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-c1-'));
  try {
    const target = `${cwd}/.smt/features/feat/task/feat.state.json`;
    const r = runEnforcer({
      cwd,
      toolName: 'Write',
      toolInput: { file_path: target, content: '{}' },
      env: { SMT_HOOK_WRITE: '1' },
    });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `env var bypass failed: ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-C2: *.state.json under .smt/ is blocked (forged-redirect defense scoped to .smt/)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-c2-'));
  try {
    const target = `${cwd}/.smt/sneaky/forged.state.json`;
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: target, content: '{}' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-C2b: *.state.json OUTSIDE .smt/ is NOT blocked when active /fix workflow seeded (third-party tools like terraform)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-c2b-'));
  try {
    seedActiveWorkflow(cwd);
    const target = `${cwd}/terraform.state.json`;
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: target, content: '{}' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', 'third-party .state.json must remain writable under active fix');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── v3.3: code-file gate ───────────────────────────────────────────────────
test('T2-V1: Write on code file with NO active workflow is blocked (v3.3 gate)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v1-'));
  try {
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/src/foo.ts`, content: 'x' } });
    const out = parseOut(r.stdout);
    assert.ok(out);
    assert.equal(out.decision, 'block', 'code file without workflow must block');
    assert.match(out.reason, /Raw Write of code file/i);
    assert.match(out.reason, /Skill\(fix\|implement\|dobby\)/);
    assert.doesNotMatch(out.reason, /`\/(?:fix|implement|dobby)\s+<description>`/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-V2: Write on doc file with NO active workflow is NOT blocked (docs exempt)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v2-'));
  try {
    for (const ext of ['md', 'txt', 'rst']) {
      const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/docs/note.${ext}`, content: 'x' } });
      const out = parseOut(r.stdout);
      assert.notEqual(out?.decision, 'block', `.${ext} must be exempt from v3.3 code-file gate`);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-V3: Write on code file with mode=explore is blocked (only fix/implement pass gate)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v3-'));
  try {
    seedActiveWorkflow(cwd, { mode: 'explore' });
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/src/foo.ts`, content: 'x' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block', 'explore mode must NOT allow code edit');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-V4: code file with active /implement workflow is allowed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v04-'));
  try {
    seedActiveWorkflow(cwd, { mode: 'implement' });
    const r = runEnforcer({ cwd, toolName: 'Edit', toolInput: { file_path: `${cwd}/src/bar.js`, old_string: 'a', new_string: 'b' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', 'implement mode must allow code edit');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-V5: .smt/ internal non-state.json writes still pass (hook bookkeeping surface)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v5-'));
  try {
    // No active workflow. .smt/features/x/artifacts/screenshot.png is a hook artifact surface.
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/.smt/features/x/artifacts/note.log`, content: 'x' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', '.smt/ internals must bypass v3.3 gate');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── v3.3: yaml/yml ungate (user directive — YAML modifications require no workflow) ─
test('T2-V6: Write on .yaml with NO active workflow is NOT blocked (yaml ungated)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v6-'));
  try {
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/config/app.yaml`, content: 'x: 1' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', '.yaml must be exempt from v3.3 code-file gate');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-V7: Edit on .yml with NO active workflow is NOT blocked (yml ungated)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v7-'));
  try {
    const r = runEnforcer({ cwd, toolName: 'Edit', toolInput: { file_path: `${cwd}/ci/workflow.yml`, old_string: 'a', new_string: 'b' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', '.yml must be exempt from v3.3 code-file gate');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-V8: Write on uppercase .YAML with NO active workflow is NOT blocked (case-insensitive)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v8-'));
  try {
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/config/app.YAML`, content: 'x: 1' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', '.YAML (case-insensitive) must be exempt');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-V9: regression — Write on .ts with NO active workflow is still blocked', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v9-'));
  try {
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/src/keep-gated.ts`, content: 'x' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block', '.ts must remain gated after yaml ungate');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── v3.3.6: json/jsonc ungate — declarative configs (package.json, tsconfig.json, etc.) ─
test('T2-V10: Edit on .json with NO active workflow is NOT blocked (json ungated)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v10-'));
  try {
    const r = runEnforcer({ cwd, toolName: 'Edit', toolInput: { file_path: `${cwd}/package.json`, old_string: '"version": "0.1.0"', new_string: '"version": "0.1.1"' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', '.json must be exempt from v3.3 code-file gate');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-V11: Write on .jsonc with NO active workflow is NOT blocked (jsonc ungated)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v11-'));
  try {
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/tsconfig.jsonc`, content: '{}' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', '.jsonc must be exempt from v3.3 code-file gate');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-V12: regression — .state.json inside .smt is STILL blocked (state-path rule independent of code-file gate)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v12-'));
  try {
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/.smt/features/x/task/x.state.json`, content: '{}' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block', '.state.json inside .smt must remain blocked by protected-path rule');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-C4: .smt/active_task pointer write is blocked', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-c4-'));
  try {
    const target = `${cwd}/.smt/active_task`;
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: target, content: '/tmp/forged.state.json' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-C5: .smt/state/active-feature.json pointer write is blocked', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-c5-'));
  try {
    const target = `${cwd}/.smt/state/active-feature.json`;
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: target, content: '{}' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-C3: Windows-style backslash path also blocked', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-c3-'));
  try {
    const target = `C:\\smt\\.smt\\features\\feat\\task\\feat.state.json`;
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: target, content: '{}' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// R — Read-first reminder injection on Write/Edit when target exists on disk
//
// The Claude Code harness rejects Write/Edit of files not Read in the current
// session with "File has not been read yet". pre-tool-enforcer injects a
// preventive reminder into additionalContext whenever Write/Edit targets an
// EXISTING file, so the agent Reads first instead of hitting the harness
// error. New-file writes (path does not exist) must not carry the reminder —
// there is nothing to Read.
// ═══════════════════════════════════════════════════════════════════════════

test('R-H1: Write on EXISTING code file with active /fix emits Read-first reminder', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'r-h1-'));
  try {
    seedActiveWorkflow(cwd);
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'foo.ts'), 'existing');
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/src/foo.ts`, content: 'x' } });
    const out = parseOut(r.stdout);
    assert.ok(out);
    assert.notEqual(out.decision, 'block');
    const ctx = out.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /Read-first|Read the file first|must be Read/i, 'existing-file Write must carry Read-first reminder');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('R-H2: Edit on EXISTING file with active /fix emits Read-first reminder', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'r-h2-'));
  try {
    seedActiveWorkflow(cwd);
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'bar.ts'), 'existing');
    const r = runEnforcer({ cwd, toolName: 'Edit', toolInput: { file_path: `${cwd}/src/bar.ts`, old_string: 'a', new_string: 'b' } });
    const out = parseOut(r.stdout);
    assert.ok(out);
    const ctx = out.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /Read-first|Read the file first|must be Read/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('R-B1: Write on NON-existing file emits NO Read-first reminder (new-file case)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'r-b1-'));
  try {
    seedActiveWorkflow(cwd);
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/src/new.ts`, content: 'x' } });
    const out = parseOut(r.stdout);
    const ctx = out?.hookSpecificOutput?.additionalContext || '';
    assert.doesNotMatch(ctx, /Read-first|Read the file first/i, 'new-file Write must not carry Read-first reminder');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('R-B2: Read tool on existing file emits NO Read-first reminder', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'r-b2-'));
  try {
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'foo.ts'), 'existing');
    const r = runEnforcer({ cwd, toolName: 'Read', toolInput: { file_path: `${cwd}/src/foo.ts` } });
    const out = parseOut(r.stdout);
    const ctx = out?.hookSpecificOutput?.additionalContext || '';
    assert.doesNotMatch(ctx, /Read-first|Read the file first/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('R-E1: Write with missing file_path does not crash', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'r-e1-'));
  try {
    seedActiveWorkflow(cwd);
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { content: 'x' } });
    const out = parseOut(r.stdout);
    assert.ok(out, 'hook must still emit valid JSON');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('R-C1: Write on existing .md file (ungated) still emits Read-first reminder', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'r-c1-'));
  try {
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'note.md'), 'existing');
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/docs/note.md`, content: 'x' } });
    const out = parseOut(r.stdout);
    const ctx = out?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /Read-first|Read the file first/i, 'doc files also carry reminder — harness error is extension-agnostic');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('R-I1: Read-first reminder coexists with tool description in additionalContext', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'r-i1-'));
  try {
    seedActiveWorkflow(cwd);
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'foo.ts'), 'existing');
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/src/foo.ts`, content: 'x' } });
    const out = parseOut(r.stdout);
    const ctx = out?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /Writing:/, 'tool description must remain');
    assert.match(ctx, /Read-first|Read the file first/i, 'reminder must also appear');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Integration ────────────────────────────────────────────────────────────
test('T2-I1: block reason directs agent to invoke skill instead of editing state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-i1-'));
  try {
    const target = `${cwd}/.smt/features/feat/task/feat.state.json`;
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: target, content: '{}' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block');
    assert.match(out.reason, /skill|invoke|hook/i, 'reason should point to correct path');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// G — git commit / human-check gate (pre-tool-enforcer.mjs §v3.1 commit gate)
//
// These tests pin the contract between the `workflow-human-check` skill's
// `complete` exit and the pretool commit gate. The skill is the only halting
// point in the pipeline; `complete` must leave state in one of two
// gate-passing shapes:
//   (a) events[] contains { skill: 'workflow-human-check', result: 'pass' }
//   (b) completed_stages includes 'workflow-human-check'
// Either unblocks `git commit`. Absent both, commit is blocked.
//
// Policy note: `current_stage === 'done'` is deliberately NOT a pass shape.
// The state schema's WORKFLOW_SKILLS enum rejects the literal `'done'`, and
// the finalize-human-check PostToolUse hook deliberately leaves current_stage
// at `'workflow-human-check'` after finalization. A state whose current_stage
// is `'done'` can only arrive from a validator-bypassing writer — the gate
// treats it as suspicious and still blocks.
// ═══════════════════════════════════════════════════════════════════════════

function seedHumanCheckState(cwd, { mode = 'fix', sessionId = 't-gate', slug = 'feat', completed_stages = [], events = [], current_stage = 'workflow-coding', corrupt = false } = {}) {
  const stateDir = `${cwd}/.smt/state`;
  const taskDir = `${cwd}/.smt/features/${slug}/task`;
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(`${stateDir}/active-feature-${sessionId}.json`, JSON.stringify({ slug, session_id: sessionId, updated_at: Date.now() }));
  const state = {
    schema_version: '2.4.1', task_id: slug, mode,
    allowed_skills: ['workflow-investigate', 'workflow-human-check'],
    current_stage, completed_stages, events,
    test_cycles: [], active_feedback: [], sub_tasks: [],
  };
  writeFileSync(`${taskDir}/${slug}.state.json`, corrupt ? '{ not valid json' : JSON.stringify(state));
  return { sessionId, slug };
}

// ── Happy path ─────────────────────────────────────────────────────────────
test('G-H1: git commit allowed when completed_stages includes workflow-human-check', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-h1-'));
  try {
    const { sessionId } = seedHumanCheckState(cwd, { completed_stages: ['workflow-human-check'] });
    const r = runEnforcer({ cwd, sessionId, toolName: 'Bash', toolInput: { command: 'git commit -m "done"' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `expected allow, got ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('G-H2: git commit allowed when events has human-check pass', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-h2-'));
  try {
    const { sessionId } = seedHumanCheckState(cwd, {
      events: [{ t: new Date().toISOString(), skill: 'workflow-human-check', result: 'pass', evidence: { path: 'results.md' } }],
    });
    const r = runEnforcer({ cwd, sessionId, toolName: 'Bash', toolInput: { command: 'git commit -m "done"' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `expected allow, got ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Boundary ───────────────────────────────────────────────────────────────
test('G-B1: git commit allowed when no active pointer exists (no workflow active)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-b1-'));
  try {
    const r = runEnforcer({ cwd, sessionId: 'no-pointer', toolName: 'Bash', toolInput: { command: 'git commit -m "x"' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `expected allow, got ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('G-B2: git commit allowed when mode=plan (gate scoped to fix/implement)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-b2-'));
  try {
    const { sessionId } = seedHumanCheckState(cwd, { mode: 'plan' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'Bash', toolInput: { command: 'git commit -m "x"' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Error path ─────────────────────────────────────────────────────────────
test('G-E1: git commit blocked when mode=fix with empty events/completed and non-done stage', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-e1-'));
  try {
    const { sessionId } = seedHumanCheckState(cwd, { mode: 'fix', current_stage: 'workflow-coding' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'Bash', toolInput: { command: 'git commit -m "x"' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block', `expected block, got ${JSON.stringify(out)}`);
    assert.match(out.reason, /human-check/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('G-E2: git commit blocked when mode=implement with empty events/completed and non-done stage', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-e2-'));
  try {
    const { sessionId } = seedHumanCheckState(cwd, { mode: 'implement', current_stage: 'workflow-coding' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'Bash', toolInput: { command: 'git commit -m "x"' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Edge case ──────────────────────────────────────────────────────────────
test('G-C1: git commit BLOCKED when current_stage===done with empty events/completed (done is NOT a pass shape)', async () => {
  // Policy pin: the schema rejects `'done'` in `current_stage`, and the
  // finalize-human-check hook deliberately leaves current_stage at
  // `'workflow-human-check'`. A state arriving with current_stage='done'
  // bypasses the canonical writer chain; the gate treats it as suspicious
  // and still blocks unless the events/completed_stages proof is present.
  const cwd = mkdtempSync(join(tmpdir(), 'g-c1-'));
  try {
    const { sessionId } = seedHumanCheckState(cwd, { mode: 'fix', current_stage: 'done' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'Bash', toolInput: { command: 'git commit -m "done"' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block', `expected block for current_stage=done without pass/completed, got ${JSON.stringify(out)}`);
    assert.match(out.reason, /human-check/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('G-C2: git commit STILL BLOCKED when current_stage=workflow-human-check without pass event', async () => {
  // Negative: a skill that stops at workflow-human-check without producing
  // a pass event (e.g. user closed the prompt) must not be unblocked.
  const cwd = mkdtempSync(join(tmpdir(), 'g-c2-'));
  try {
    const { sessionId } = seedHumanCheckState(cwd, { mode: 'fix', current_stage: 'workflow-human-check' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'Bash', toolInput: { command: 'git commit -m "x"' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('G-C3: git commit blocked when pointer exists but state.json is corrupted (fail-closed)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-c3-'));
  try {
    const { sessionId } = seedHumanCheckState(cwd, { corrupt: true });
    const r = runEnforcer({ cwd, sessionId, toolName: 'Bash', toolInput: { command: 'git commit -m "x"' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block');
    assert.match(out.reason, /unreadable|corrupt/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Integration ────────────────────────────────────────────────────────────
test('G-I1: block reason names workflow-human-check so agent knows the recovery path', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-i1-'));
  try {
    const { sessionId } = seedHumanCheckState(cwd, { mode: 'fix', current_stage: 'workflow-coding' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'Bash', toolInput: { command: 'git commit -m "x"' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block');
    assert.match(out.reason, /workflow-human-check/);
    assert.match(out.reason, /pass|NOT_PASSED/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ════════════════════════════════════════════════════════════════════════════
// Native plan-mode block — command-aware gate
// Feature: unconditional-plan-mode-block
// Rule: block EnterPlanMode/ExitPlanMode ONLY when workflow.json.command === 'brainstorm'.
//       All other Smelter commands (fix, implement, explore, verify) must
//       allow native plan mode. Malformed / missing workflow.json must fail-open.
// ════════════════════════════════════════════════════════════════════════════

function seedPlanModeScenario(cwd, { sessionId = 'pm', slug = 'seed', command, workflowJson = undefined } = {}) {
  const stateDir = join(cwd, '.smt', 'state');
  const wfDir = join(cwd, '.smt', 'features', slug, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(stateDir, `active-feature-${sessionId}.json`), JSON.stringify({ slug }));
  if (workflowJson !== undefined) {
    // Raw content override (for malformed-json case).
    writeFileSync(join(wfDir, 'workflow.json'), workflowJson);
  } else if (command !== null) {
    writeFileSync(join(wfDir, 'workflow.json'), JSON.stringify({ command, step: 'step-1' }));
  }
  // command === null → skip writing workflow.json
  return { sessionId, slug };
}

// ── Happy path ─────────────────────────────────────────────────────────────
test('PLAN-H1: EnterPlanMode during /fix is ALLOWED', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-h1-'));
  try {
    const { sessionId } = seedPlanModeScenario(cwd, { command: 'fix' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'EnterPlanMode', toolInput: {} });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `expected allow, got ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('PLAN-H2: EnterPlanMode during /implement is ALLOWED', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-h2-'));
  try {
    const { sessionId } = seedPlanModeScenario(cwd, { command: 'implement' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'EnterPlanMode', toolInput: {} });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `expected allow, got ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Boundary: the only commands that MUST be blocked ──────────────────────
test('PLAN-B1: EnterPlanMode during /brainstorm is BLOCKED', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-b1-'));
  try {
    const { sessionId } = seedPlanModeScenario(cwd, { command: 'brainstorm' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'EnterPlanMode', toolInput: {} });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block', `expected block, got ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('PLAN-B2: ExitPlanMode during /brainstorm is BLOCKED', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-b2-'));
  try {
    const { sessionId } = seedPlanModeScenario(cwd, { command: 'brainstorm' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'ExitPlanMode', toolInput: {} });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block', `expected block, got ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Error path: safe-default / fail-open ──────────────────────────────────
test('PLAN-E1: no workflow.json present → ALLOWED (no active workflow)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-e1-'));
  try {
    const { sessionId } = seedPlanModeScenario(cwd, { command: null });
    const r = runEnforcer({ cwd, sessionId, toolName: 'EnterPlanMode', toolInput: {} });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `expected allow, got ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('PLAN-E2: malformed workflow.json → ALLOWED (fail-open, do not lock agent out)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-e2-'));
  try {
    const { sessionId } = seedPlanModeScenario(cwd, { workflowJson: '{not-json' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'EnterPlanMode', toolInput: {} });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `malformed workflow.json must not block; got ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Edge case: remaining supported commands + shape variants ──────────────
test('PLAN-C1: workflow.json missing `command` field → ALLOWED (safe default)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-c1-'));
  try {
    const { sessionId } = seedPlanModeScenario(cwd, { workflowJson: JSON.stringify({ step: 'step-1' }) });
    const r = runEnforcer({ cwd, sessionId, toolName: 'EnterPlanMode', toolInput: {} });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `expected allow when command field missing; got ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('PLAN-C2: EnterPlanMode during /explore is ALLOWED', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-c2-'));
  try {
    const { sessionId } = seedPlanModeScenario(cwd, { command: 'explore' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'EnterPlanMode', toolInput: {} });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `expected allow for /explore; got ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('PLAN-C3: EnterPlanMode during /verify is ALLOWED', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-c3-'));
  try {
    const { sessionId } = seedPlanModeScenario(cwd, { command: 'verify' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'EnterPlanMode', toolInput: {} });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `expected allow for /verify; got ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('PLAN-C4: stale GLOBAL active-feature.json pointing at /brainstorm does NOT block when session pointer is absent', async () => {
  // Regression guard for the session-scoped invariant at pre-tool-enforcer.mjs:122-124.
  // The gate must consult ONLY the session-scoped pointer when sessionId is present;
  // a stale global pointer from another session must never leak across sessions.
  const cwd = mkdtempSync(join(tmpdir(), 'plan-c4-'));
  try {
    const stateDir = join(cwd, '.smt', 'state');
    const wfDir = join(cwd, '.smt', 'features', 'other-sess-feat', 'state');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(wfDir, { recursive: true });
    // Global pointer only — no active-feature-<sid>.json.
    writeFileSync(join(stateDir, 'active-feature.json'), JSON.stringify({ slug: 'other-sess-feat' }));
    writeFileSync(join(wfDir, 'workflow.json'), JSON.stringify({ command: 'brainstorm', step: 'step-1' }));
    const r = runEnforcer({ cwd, sessionId: 'fresh-sid', toolName: 'EnterPlanMode', toolInput: {} });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `session isolation violated — stale global pointer blocked: ${JSON.stringify(out)}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Integration ────────────────────────────────────────────────────────────
test('PLAN-I1: /brainstorm block reason guides agent to Smelter planning engine', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-i1-'));
  try {
    const { sessionId } = seedPlanModeScenario(cwd, { command: 'brainstorm' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'EnterPlanMode', toolInput: {} });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block');
    assert.match(out.reason, /\/brainstorm|workflow-brainstorm|planning/i,
      `expected planning-engine hint in reason; got: ${out?.reason}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Pointer fallback: seeder ↔ enforcer asymmetry regression ───────────────
// Background: workflow-state-seeder falls back to unscoped `active-feature.json`
// when sessionId is empty. pre-tool-enforcer used to read ONLY the scoped
// `active-feature-<sid>.json` when sessionId was present — no fallback. Result:
// every code-file Edit/Write got blocked for the rest of a valid /fix session
// when the initial seed had arrived without a sid.
//
// Fix: when scoped pointer is missing, enforcer falls back to unscoped pointer
// and re-applies the same mode/slug/state-file validation. Fallback widens
// lookup; it does NOT weaken any existing block condition.

function seedUnscopedWorkflow(cwd, { slug = 'seed-unscoped', mode = 'fix' } = {}) {
  const stateDir = join(cwd, '.smt', 'state');
  const taskDir = join(cwd, '.smt', 'features', slug, 'task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  // Unscoped pointer only — matches the wild forensic case.
  writeFileSync(join(stateDir, 'active-feature.json'), JSON.stringify({ slug, session_id: '' }));
  writeFileSync(join(taskDir, `${slug}.state.json`), JSON.stringify({ mode, completed_stages: [], events: [] }));
}

test('T2-F1: sid present + scoped pointer absent + unscoped(mode=fix) → code-file Write is ALLOWED', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-f1-'));
  try {
    seedUnscopedWorkflow(cwd, { mode: 'fix' });
    const r = runEnforcer({
      cwd,
      sessionId: 'abc123',
      toolName: 'Write',
      toolInput: { file_path: `${cwd}/src/foo.ts`, content: 'x' },
    });
    const out = parseOut(r.stdout);
    assert.ok(out, `parse output; stdout=${r.stdout}`);
    assert.notEqual(
      out.decision,
      'block',
      `fallback must allow Write when scoped missing + unscoped has mode=fix; got ${JSON.stringify(out)}`,
    );
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-F2: sid present + scoped absent + unscoped absent → code-file Write is BLOCKED (regression guard)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-f2-'));
  try {
    // No pointer seeded at all. Fallback must not invent a workflow.
    const r = runEnforcer({
      cwd,
      sessionId: 'abc123',
      toolName: 'Write',
      toolInput: { file_path: `${cwd}/src/foo.ts`, content: 'x' },
    });
    const out = parseOut(r.stdout);
    assert.ok(out);
    assert.equal(
      out.decision,
      'block',
      `no pointer anywhere must still block; got ${JSON.stringify(out)}`,
    );
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-F3: raw code-write block reason does not ask user to type slash commands', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-f3-'));
  try {
    const r = runEnforcer({
      cwd,
      sessionId: 'abc123',
      toolName: 'Write',
      toolInput: { file_path: `${cwd}/scripts/lib/hook-guards.test.mjs`, content: 'x' },
    });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block');
    assert.doesNotMatch(out.reason, /Required action: invoke/i);
    assert.doesNotMatch(out.reason, /`\/(?:fix|implement|dobby)\s+<description>`/);
    assert.match(out.reason, /agent recovery|Skill\(fix\|implement\|dobby\)/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
