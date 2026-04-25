/**
 * posttool-test-red-recorder.test.mjs — RED tests for v0.4 test_red auto-recorder.
 *
 * Target: scripts/posttool-test-red-recorder.mjs (does not exist).
 * Hook reads PostToolUse:Bash stdin, detects `node --test` style commands,
 * inspects exit_code; on exit≠0 appends {type: 'test_red'} event to active
 * state.json via SMT_HOOK_WRITE=1 escape hatch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(process.cwd(), 'scripts', 'posttool-test-red-recorder.mjs');

function seedActiveFeature(cwd, sessionId, slug, stateOverrides = {}) {
  mkdirSync(join(cwd, '.smt', 'state'), { recursive: true });
  mkdirSync(join(cwd, '.smt', 'features', slug, 'task'), { recursive: true });

  writeFileSync(
    join(cwd, '.smt', 'state', `active-feature-${sessionId}.json`),
    JSON.stringify({ slug, session_id: sessionId, updated_at: Date.now() }),
  );

  const baseState = {
    schema_version: '2.4.1',
    task_id: slug,
    mode: 'implement',
    user_mode: 'implement',
    task_type: 'write',
    step: 'EXECUTE',
    step_flow: ['INTENT','DISCOVERY','PLAN','TEST_DESIGN','EXECUTE','VERIFY','HUMAN_CHECK','DONE'],
    allowed_actions: ['read','write_source','run_test'],
    chained_modes: [],
    allowed_skills: ['workflow-coding'],
    current_stage: 'workflow-coding',
    completed_stages: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    target_type: 'refactor',
    surface: [],
    exempt: { tdd: false, e2e: false },
    skip_brainstorm: false,
    team_runtime: {},
    events: [],
    scenarios: [],
    test_cycles: [],
    active_feedback: [],
    sub_tasks: [],
    ...stateOverrides,
  };
  const path = join(cwd, '.smt', 'features', slug, 'task', `${slug}.state.json`);
  writeFileSync(path, JSON.stringify(baseState, null, 2));
  return path;
}

function runRecorder({ cwd, sessionId, payload }) {
  return spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ cwd, session_id: sessionId, ...payload }),
    encoding: 'utf8',
    env: { ...process.env },
  });
}

test('TR1 node --test exit≠0 appends test_red event (happy)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const slug = 'feature-tr1-test';
    const statePath = seedActiveFeature(cwd, 'sess-tr1', slug);
    runRecorder({
      cwd, sessionId: 'sess-tr1',
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'node --test scripts/foo.test.mjs' },
        tool_response: { exit_code: 1, stderr: '' },
      },
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const reds = (state.events || []).filter((e) => e.type === 'test_red');
    assert.equal(reds.length, 1, 'one test_red event expected');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('TR2 node --test exit=0 does NOT append (boundary)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const slug = 'feature-tr2-test';
    const statePath = seedActiveFeature(cwd, 'sess-tr2', slug);
    runRecorder({
      cwd, sessionId: 'sess-tr2',
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'node --test scripts/foo.test.mjs' },
        tool_response: { exit_code: 0 },
      },
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const reds = (state.events || []).filter((e) => e.type === 'test_red');
    assert.equal(reds.length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('TR3 non-test bash command exit≠0 ignored (boundary)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const slug = 'feature-tr3-test';
    const statePath = seedActiveFeature(cwd, 'sess-tr3', slug);
    runRecorder({
      cwd, sessionId: 'sess-tr3',
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'rm /tmp/foo' },
        tool_response: { exit_code: 1 },
      },
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const reds = (state.events || []).filter((e) => e.type === 'test_red');
    assert.equal(reds.length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('TR4 idempotent — repeated invocations do not duplicate (edge)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const slug = 'feature-tr4-test';
    const statePath = seedActiveFeature(cwd, 'sess-tr4', slug);
    const args = {
      cwd, sessionId: 'sess-tr4',
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'node --test' },
        tool_response: { exit_code: 1 },
      },
    };
    runRecorder(args);
    runRecorder(args);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const reds = (state.events || []).filter((e) => e.type === 'test_red');
    assert.equal(reds.length, 1, 'duplicate guard expected');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
