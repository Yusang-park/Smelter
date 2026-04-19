#!/usr/bin/env node
/**
 * critic-watchdog.test.mjs — Unit tests for the 12 formal rules.
 *
 * Focuses on R12 (workflow-stage required before src/scripts writes), which
 * plugs the enforcement hole where an agent could bypass the /fix workflow by
 * writing code without ever entering workflow-investigate.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { runAll } from './critic-watchdog.mjs';
import { createInitialState } from './state-schema.mjs';

function seedFeatureDir(cwd, slug) {
  const taskDir = join(cwd, '.smt', 'features', slug, 'task');
  mkdirSync(taskDir, { recursive: true });
  return taskDir;
}

function stateWith({ current_stage = null, allowed_skills = null, completed_stages = [] } = {}) {
  const s = createInitialState({ taskId: 'test', mode: 'fix' });
  s.allowed_skills = allowed_skills ?? [
    'workflow-investigate', 'workflow-investigate-review',
    'workflow-tasker', 'workflow-tasker-review',
    'workflow-write-test', 'workflow-coding',
    'workflow-agent-review', 'workflow-e2e', 'workflow-e2e-review',
    'workflow-team-code-review', 'workflow-human-check',
  ];
  s.current_stage = current_stage;
  s.completed_stages = completed_stages;
  return s;
}

test('R12: block src edit when state exists but current_stage is null', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    seedFeatureDir(cwd, 'demo');
    const state = stateWith({ current_stage: null });
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: join(cwd, 'src/foo.ts'), old_string: 'a', new_string: 'b' },
    };
    const hits = runAll(input, state, cwd);
    const r12 = hits.find(h => h.rule === 'R12');
    assert.ok(r12, 'R12 must fire when current_stage is null');
    assert.equal(r12.severity, 'CRITICAL');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('R12: block scripts/ write when current_stage is null', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    seedFeatureDir(cwd, 'demo');
    const state = stateWith({ current_stage: null });
    const input = {
      tool_name: 'Write',
      tool_input: { file_path: join(cwd, 'scripts/keyword-detector.mjs'), content: 'x' },
    };
    const hits = runAll(input, state, cwd);
    assert.ok(hits.find(h => h.rule === 'R12'), 'R12 must fire for scripts/ writes');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('R12: allow test-file edits even when current_stage is null', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    seedFeatureDir(cwd, 'demo');
    const state = stateWith({ current_stage: null });
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: join(cwd, 'src/foo.test.ts'), old_string: 'a', new_string: 'b' },
    };
    const hits = runAll(input, state, cwd);
    assert.equal(hits.find(h => h.rule === 'R12'), undefined, 'R12 must not fire for *.test.* edits');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('R12: allow src edit when inside workflow-coding stage', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    seedFeatureDir(cwd, 'demo');
    const state = stateWith({ current_stage: 'workflow-coding' });
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: join(cwd, 'src/foo.ts'), old_string: 'a', new_string: 'b' },
    };
    const hits = runAll(input, state, cwd);
    assert.equal(hits.find(h => h.rule === 'R12'), undefined, 'R12 must not fire when current_stage is an allowed workflow skill');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('R12: block src edit when .state.json missing but active-feature pointer exists', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    const stateDir = join(cwd, '.smt', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'active-feature.json'), JSON.stringify({ slug: 'demo' }));
    seedFeatureDir(cwd, 'demo'); // feature dir exists but no *.state.json
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: join(cwd, 'src/foo.ts'), old_string: 'a', new_string: 'b' },
    };
    // state param is null — simulates the real situation where critic-watchdog
    // loaded no state but the user IS inside a workflow command.
    const hits = runAll(input, null, cwd);
    assert.ok(hits.find(h => h.rule === 'R12'), 'R12 must fire when active-feature exists without a corresponding .state.json');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('R12: do not fire outside a Smelter project (no .smt/ dir)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: join(cwd, 'src/foo.ts'), old_string: 'a', new_string: 'b' },
    };
    const hits = runAll(input, null, cwd);
    assert.equal(hits.find(h => h.rule === 'R12'), undefined, 'R12 must not fire when there is no active workflow command');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
