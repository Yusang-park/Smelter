#!/usr/bin/env node
/**
 * pre-tool-enforcer.test.mjs — Direct-edit guard for .state.json files.
 * Feature: harness-integrity-4-fixes T2
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'pre-tool-enforcer.mjs');

function runEnforcer({ cwd, toolName, toolInput, sessionId = 't2', env = {} }) {
  const payload = JSON.stringify({ cwd, session_id: sessionId, tool_name: toolName, tool_input: toolInput });
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, ...env },
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
function seedActiveWorkflow(cwd, { sessionId = 't2', slug = 'seed', mode = 'fix' } = {}) {
  const stateDir = join(cwd, '.smt', 'state');
  const taskDir = join(cwd, '.smt', 'features', slug, 'task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(stateDir, `active-feature-${sessionId}.json`), JSON.stringify({ slug }));
  writeFileSync(join(taskDir, `${slug}.state.json`), JSON.stringify({ mode, completed_stages: [], events: [] }));
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
    assert.match(out.reason, /\/fix|\/implement/);
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

test('T2-V3: Write on code file with mode=investigate is blocked (only fix/implement pass gate)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v3-'));
  try {
    seedActiveWorkflow(cwd, { mode: 'investigate' });
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/src/foo.ts`, content: 'x' } });
    const out = parseOut(r.stdout);
    assert.equal(out?.decision, 'block', 'investigate mode must NOT allow code edit');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T2-V4: code file with active /implement workflow is allowed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-v4-'));
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
// point in the pipeline; `complete` must leave state in one of three
// gate-passing shapes:
//   (a) events[] contains { skill: 'workflow-human-check', result: 'pass' }
//   (b) completed_stages includes 'workflow-human-check' (legacy form)
//   (c) current_stage === 'done' (terminal-state fallback)
// Any of the three unblocks `git commit`. Absent all three, commit is blocked.
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
test('G-C1: git commit ALLOWED when current_stage===done even with empty events/completed (NEW fallback)', async () => {
  // This is the primary regression that the fix closes. If the skill only
  // wrote current_stage=done (matching SKILL.md On Complete wording) without
  // appending a pass event, the commit gate formerly blocked forever.
  const cwd = mkdtempSync(join(tmpdir(), 'g-c1-'));
  try {
    const { sessionId } = seedHumanCheckState(cwd, { mode: 'fix', current_stage: 'done' });
    const r = runEnforcer({ cwd, sessionId, toolName: 'Bash', toolInput: { command: 'git commit -m "done"' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', `expected allow for current_stage=done, got ${JSON.stringify(out)}`);
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
