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

test('R14: block E2E pass claim when scenarios are missing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    seedFeatureDir(cwd, 'demo');
    mkdirSync(join(cwd, '.smt', 'features', 'demo', 'artifacts'), { recursive: true });
    writeFileSync(join(cwd, '.smt', 'features', 'demo', 'artifacts', 'e2e.log'), 'ok');
    const state = stateWith({ current_stage: 'workflow-e2e' });
    const input = {
      tool_name: 'Write',
      tool_input: { file_path: join(cwd, 'verify_report.md'), content: 'result: pass' },
    };
    const hits = runAll(input, state, cwd);
    const r14 = hits.find(h => h.rule === 'R14');
    assert.ok(r14, 'R14 must fire when state.scenarios is empty');
    assert.equal(r14.severity, 'CRITICAL');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('R14: block E2E pass claim when effect_evidence is ack_only', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    seedFeatureDir(cwd, 'demo');
    mkdirSync(join(cwd, '.smt', 'features', 'demo', 'artifacts'), { recursive: true });
    writeFileSync(join(cwd, '.smt', 'features', 'demo', 'artifacts', 'e2e.log'), 'ok');
    const state = stateWith({ current_stage: 'workflow-e2e' });
    state.scenarios = [{
      name: 'admin-impersonates-user',
      surface: 'ui',
      ack_evidence: { type: 'dom_state_query', reference: 'artifacts/ui/banner.png' },
      effect_evidence: { type: 'ack_only', reference: 'artifacts/ui/banner.png' },
    }];
    const input = {
      tool_name: 'Write',
      tool_input: { file_path: join(cwd, 'verify_report.md'), content: 'result: pass' },
    };
    const hits = runAll(input, state, cwd);
    const r14 = hits.find(h => h.rule === 'R14');
    assert.ok(r14, 'R14 must fire for ack_only effect evidence');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('R13: bash -c "ls .smt/state/active-feature-*.json" is NOT blocked (pure read, unwrapped)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    const state = stateWith({ current_stage: 'workflow-coding' });
    const input = {
      tool_name: 'Bash',
      tool_input: { command: "bash -c 'ls -la .smt/state/active-feature-*.json'" },
    };
    const hits = runAll(input, state, cwd);
    assert.equal(hits.find(h => h.rule === 'R13'), undefined, 'R13 must not fire on bash-wrapped pure read');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('R13: bash -c with cat + grep chain on protected path allowed', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    const state = stateWith({ current_stage: 'workflow-coding' });
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'bash -c \'cat .smt/state/active-feature-abc.json | jq .slug\'' },
    };
    const hits = runAll(input, state, cwd);
    assert.equal(hits.find(h => h.rule === 'R13'), undefined, 'R13 must not fire on pipeline of reads');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('R13: bash -c with node -e writing to state still blocked', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    const state = stateWith({ current_stage: 'workflow-coding' });
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'bash -c \'node -e "require(\\\'fs\\\').writeFileSync(\\\'.smt/features/x/task/x.state.json\\\', \\\'\\\')"\'' },
    };
    const hits = runAll(input, state, cwd);
    assert.ok(hits.find(h => h.rule === 'R13'), 'R13 must still fire on real state write inside bash -c');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('R15: block src edit when current_stage != workflow-coding but mode allows it', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    seedFeatureDir(cwd, 'demo');
    const state = stateWith({ current_stage: 'workflow-investigate' });
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: join(cwd, 'src/foo.ts'), old_string: 'a', new_string: 'b' },
    };
    const hits = runAll(input, state, cwd);
    const r15 = hits.find(h => h.rule === 'R15');
    assert.ok(r15, 'R15 must fire when stage-skipping code edit detected');
    assert.match(r15.reason, /workflow-coding/, 'reason must point to workflow-coding');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('R15: allow src edit when already in workflow-coding stage', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    seedFeatureDir(cwd, 'demo');
    const state = stateWith({ current_stage: 'workflow-coding' });
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: join(cwd, 'src/foo.ts'), old_string: 'a', new_string: 'b' },
    };
    const hits = runAll(input, state, cwd);
    assert.equal(hits.find(h => h.rule === 'R15'), undefined, 'R15 must not fire in workflow-coding');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('R15: allow test-file edit regardless of stage', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    seedFeatureDir(cwd, 'demo');
    const state = stateWith({ current_stage: 'workflow-investigate' });
    const input = {
      tool_name: 'Write',
      tool_input: { file_path: join(cwd, 'scripts/foo.test.mjs'), content: 'x' },
    };
    const hits = runAll(input, state, cwd);
    assert.equal(hits.find(h => h.rule === 'R15'), undefined, 'R15 must not fire on test files');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('R15: skip when mode disallows workflow-coding (e.g., plan mode)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    seedFeatureDir(cwd, 'demo');
    const state = stateWith({
      current_stage: 'workflow-investigate',
      allowed_skills: ['workflow-brainstorm', 'workflow-investigate', 'workflow-tasker'],
    });
    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: join(cwd, 'src/foo.ts'), old_string: 'a', new_string: 'b' },
    };
    const hits = runAll(input, state, cwd);
    assert.equal(hits.find(h => h.rule === 'R15'), undefined, 'R15 must not fire when mode disallows workflow-coding');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('R14: allow E2E pass claim when effect_evidence is populated', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'watchdog-'));
  try {
    seedFeatureDir(cwd, 'demo');
    mkdirSync(join(cwd, '.smt', 'features', 'demo', 'artifacts'), { recursive: true });
    writeFileSync(join(cwd, '.smt', 'features', 'demo', 'artifacts', 'e2e.log'), 'ok');
    const state = stateWith({ current_stage: 'workflow-e2e' });
    state.scenarios = [{
      name: 'admin-impersonates-user',
      surface: 'ui',
      ack_evidence: { type: 'dom_state_query', reference: 'artifacts/ui/banner.png' },
      effect_evidence: { type: 'dom_diff', reference: 'artifacts/ui/dashboard.png' },
    }];
    const input = {
      tool_name: 'Write',
      tool_input: { file_path: join(cwd, 'verify_report.md'), content: 'result: pass' },
    };
    const hits = runAll(input, state, cwd);
    assert.equal(hits.find(h => h.rule === 'R14'), undefined, 'R14 must not fire when effect evidence is valid');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
