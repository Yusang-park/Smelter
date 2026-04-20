#!/usr/bin/env node
/**
 * pre-tool-enforcer.test.mjs — Direct-edit guard for .state.json files.
 * Feature: harness-integrity-4-fixes T2
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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

// ── Happy path ─────────────────────────────────────────────────────────────
test('T2-H1: Write on unrelated file is allowed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-h1-'));
  try {
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: `${cwd}/src/foo.ts`, content: 'x' } });
    const out = parseOut(r.stdout);
    assert.ok(out, 'parse output');
    assert.notEqual(out.decision, 'block', `unrelated Write blocked: ${JSON.stringify(out)}`);
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

test('T2-C2b: *.state.json OUTSIDE .smt/ is NOT blocked (third-party tools like terraform)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't2-c2b-'));
  try {
    const target = `${cwd}/terraform.state.json`;
    const r = runEnforcer({ cwd, toolName: 'Write', toolInput: { file_path: target, content: '{}' } });
    const out = parseOut(r.stdout);
    assert.notEqual(out?.decision, 'block', 'third-party .state.json must remain writable');
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
