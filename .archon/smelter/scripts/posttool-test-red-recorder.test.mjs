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
  const body = { cwd, ...payload };
  if (sessionId !== undefined) body.session_id = sessionId;
  return spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(body),
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function seedUnscopedFeature(cwd, slug, stateOverrides = {}) {
  mkdirSync(join(cwd, '.smt', 'state'), { recursive: true });
  mkdirSync(join(cwd, '.smt', 'features', slug, 'task'), { recursive: true });
  writeFileSync(join(cwd, '.smt', 'state', 'active-feature.json'), JSON.stringify({ slug, session_id: '' }));
  const path = join(cwd, '.smt', 'features', slug, 'task', `${slug}.state.json`);
  writeFileSync(path, JSON.stringify({
    schema_version: '2.4.1',
    task_id: slug,
    mode: 'brainstorm',
    user_mode: 'brainstorm',
    task_type: 'design',
    step: 'INTENT',
    step_flow: ['INTENT','DISCOVERY','PLAN','DONE'],
    allowed_actions: ['classify_intent'],
    allowed_skills: ['workflow-brainstorm'],
    current_stage: 'workflow-brainstorm',
    completed_stages: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    target_type: null,
    surface: [],
    exempt: { tdd: true, e2e: true },
    skip_brainstorm: false,
    team_runtime: {},
    events: [],
    scenarios: [],
    test_cycles: [],
    active_feedback: [],
    sub_tasks: [],
    ...stateOverrides,
  }, null, 2));
  return path;
}

function seedUnscopedPointer(cwd, sessionId, slug) {
  mkdirSync(join(cwd, '.smt', 'state'), { recursive: true });
  writeFileSync(join(cwd, '.smt', 'state', 'active-feature.json'), JSON.stringify({ slug, session_id: sessionId, updated_at: Date.now() }));
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

test('TR2b masked RED via echo exit does NOT append and emits diagnostic', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const slug = 'feature-tr2b-test';
    const statePath = seedActiveFeature(cwd, 'sess-tr2b', slug);
    const r = runRecorder({
      cwd, sessionId: 'sess-tr2b',
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'node --test scripts/foo.test.mjs; echo "exit=$?"' },
        tool_response: { exit_code: 0, stdout: '# fail 4\nexit=1\n' },
      },
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const reds = (state.events || []).filter((e) => e.type === 'test_red');
    assert.equal(reds.length, 0, 'masked RED must not be recorded as evidence');
    const out = JSON.parse(r.stdout || '{}');
    assert.match(out.systemMessage || out.hookSpecificOutput?.additionalContext || '', /RED not recorded|remove.*echo|actual Bash exit code/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('TR2c missing exit evidence diagnostic forbids coding handoff and gives rerun command shape', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const slug = 'feature-tr2c-test';
    const statePath = seedActiveFeature(cwd, 'sess-tr2c', slug, {
      current_stage: 'workflow-write-test',
      allowed_skills: ['workflow-write-test', 'workflow-coding'],
      step: 'TEST_DESIGN',
    });
    const r = runRecorder({
      cwd, sessionId: 'sess-tr2c',
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'npm run test:rt -- src/features/foo.test.tsx' },
        tool_response: 'Jest failed but payload has no structured exit field',
      },
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal((state.events || []).filter((e) => e.type === 'test_red').length, 0);
    const out = JSON.parse(r.stdout || '{}');
    const message = out.systemMessage || out.hookSpecificOutput?.additionalContext || '';
    assert.match(message, /Do NOT claim RED recorded/i);
    assert.match(message, /Do NOT invoke Skill\(skill: 'workflow-coding'\)/);
    assert.match(message, /rerun the failing test command directly/i);
    assert.match(message, /no pipes, redirects, tail, or echo/i);
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

test('TR5 missing input session_id uses SMELTER_SESSION_ID before stale unscoped pointer', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  const prevSid = process.env.SMELTER_SESSION_ID;
  try {
    const scopedSlug = 'feature-tr5-scoped';
    const scopedPath = seedActiveFeature(cwd, 'sess-tr5', scopedSlug);
    seedUnscopedFeature(cwd, 'feature-tr5-stale-design');
    process.env.SMELTER_SESSION_ID = 'sess-tr5';
    runRecorder({
      cwd, sessionId: undefined,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'node --test scripts/foo.test.mjs' },
        tool_response: { exit_code: 1 },
      },
    });
    const state = JSON.parse(readFileSync(scopedPath, 'utf8'));
    const reds = (state.events || []).filter((e) => e.type === 'test_red');
    assert.equal(reds.length, 1, 'env-scoped state must receive RED event');
  } finally {
    if (prevSid === undefined) delete process.env.SMELTER_SESSION_ID;
    else process.env.SMELTER_SESSION_ID = prevSid;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('TR6 pnpm vitest run exit≠0 appends test_red event', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const slug = 'feature-tr6-test';
    const statePath = seedActiveFeature(cwd, 'sess-tr6', slug, {
      current_stage: 'workflow-write-test',
      allowed_skills: ['workflow-write-test', 'workflow-coding'],
      step: 'TEST_DESIGN',
    });
    runRecorder({
      cwd, sessionId: 'sess-tr6',
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'pnpm vitest run src/hooks/account/use-account-query.test.ts -t "user-switch identity guard"' },
        tool_response: { exit_code: 1, stderr: '7 failed' },
      },
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const reds = (state.events || []).filter((e) => e.type === 'test_red');
    assert.equal(reds.length, 1, 'vitest RED must be recorded');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('TR7 top-level exit_code exit≠0 appends test_red event', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const slug = 'feature-tr7-test';
    const statePath = seedActiveFeature(cwd, 'sess-tr7', slug, {
      current_stage: 'workflow-write-test',
      allowed_skills: ['workflow-write-test', 'workflow-coding'],
      step: 'TEST_DESIGN',
    });
    runRecorder({
      cwd, sessionId: 'sess-tr7',
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test:run src/hooks/account/use-account-query.test.ts' },
        exit_code: 1,
        tool_response: 'Error: Exit code 1',
      },
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const reds = (state.events || []).filter((e) => e.type === 'test_red');
    assert.equal(reds.length, 1, 'top-level Bash exit_code must be recorded');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('TR8 object error text with tool failure exit text appends test_red event', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const slug = 'feature-tr8-test';
    const statePath = seedActiveFeature(cwd, 'sess-tr8', slug, {
      current_stage: 'workflow-write-test',
      allowed_skills: ['workflow-write-test', 'workflow-coding'],
      step: 'TEST_DESIGN',
    });
    const r = runRecorder({
      cwd, sessionId: 'sess-tr8',
      payload: {
        tool_name: 'Bash',
        toolInput: { command: 'pnpm test:run src/hooks/account/use-account-query.test.ts -t "user-switch identity guard"' },
        tool_response: { error: 'Error: Exit code 1', stderr: '7 failed' },
      },
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const reds = (state.events || []).filter((e) => e.type === 'test_red');
    assert.equal(reds.length, 1, 'Claude Bash failure text must be accepted when the command is a test runner');
    assert.equal(reds[0].evidence?.type, 'exit_code');
    assert.equal(reds[0].evidence?.source, 'tool_failure_text');
    const out = JSON.parse(r.stdout || '{}');
    assert.equal(out.systemMessage, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('TR9 UI-decorated Bash tool_name still appends test_red event', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const slug = 'feature-tr9-test';
    const statePath = seedActiveFeature(cwd, 'sess-tr9', slug, {
      current_stage: 'workflow-write-test',
      allowed_skills: ['workflow-write-test', 'workflow-coding'],
      step: 'TEST_DESIGN',
    });
    runRecorder({
      cwd, sessionId: 'sess-tr9',
      payload: {
        tool_name: 'Bash(pnpm test:run src/hooks/account/use-account-query.test.ts)',
        tool_input: { command: 'pnpm test:run src/hooks/account/use-account-query.test.ts -t "user-switch identity guard"' },
        tool_response: { exit_code: 1 },
      },
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const reds = (state.events || []).filter((e) => e.type === 'test_red');
    assert.equal(reds.length, 1, 'UI-decorated Bash tool names must be recorded');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('TR10 nested cwd resolves ancestor .smt before recording RED', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const nested = join(cwd, 'src', 'hooks', 'account');
    mkdirSync(nested, { recursive: true });
    const slug = 'feature-tr10-test';
    const statePath = seedActiveFeature(cwd, 'sess-tr10', slug, {
      current_stage: 'workflow-write-test',
      allowed_skills: ['workflow-write-test', 'workflow-coding'],
      step: 'TEST_DESIGN',
    });
    runRecorder({
      cwd: nested, sessionId: 'sess-tr10',
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test:run src/hooks/account/use-account-query.test.ts -t "user-switch identity guard"' },
        tool_response: { exit_code: 1 },
      },
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const reds = (state.events || []).filter((e) => e.type === 'test_red');
    assert.equal(reds.length, 1, 'nested cwd must resolve parent workflow state');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('TR11 pointer conflict chooses same-session recordable write-test state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const sessionId = 'sess-tr11';
    const writeSlug = 'feature-tr11-write';
    const readSlug = 'feature-tr11-read';
    const writePath = seedActiveFeature(cwd, sessionId, writeSlug, {
      current_stage: 'workflow-write-test',
      allowed_skills: ['workflow-write-test', 'workflow-coding'],
      step: 'TEST_DESIGN',
    });
    seedActiveFeature(cwd, sessionId, readSlug, {
      mode: 'explore',
      user_mode: 'explore',
      task_type: 'read',
      step: 'INTENT',
      step_flow: ['INTENT','DISCOVERY','DONE'],
      allowed_actions: ['classify_intent'],
      allowed_skills: ['workflow-investigate'],
      current_stage: 'workflow-investigate',
    });
    seedUnscopedPointer(cwd, sessionId, writeSlug);

    runRecorder({
      cwd, sessionId,
      payload: {
        tool_name: 'Bash(pnpm test:run src/hooks/account/use-account-query.test.ts)',
        tool_input: { command: 'pnpm test:run src/hooks/account/use-account-query.test.ts -t "user-switch identity guard"' },
        tool_response: { exit_code: 1 },
      },
    });

    const writeState = JSON.parse(readFileSync(writePath, 'utf8'));
    const reds = (writeState.events || []).filter((e) => e.type === 'test_red');
    assert.equal(reds.length, 1, 'same-session write-test state must receive RED event');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('TR12 missing session_id scans session pointers for newest recordable write-test state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    seedUnscopedFeature(cwd, 'feature-tr12-stale-design');

    const oldPath = seedActiveFeature(cwd, 'sess-tr12-old', 'feature-tr12-old', {
      current_stage: 'workflow-write-test',
      allowed_skills: ['workflow-write-test', 'workflow-coding'],
      step: 'TEST_DESIGN',
    });
    const newPath = seedActiveFeature(cwd, 'sess-tr12-new', 'feature-tr12-new', {
      current_stage: 'workflow-write-test',
      allowed_skills: ['workflow-write-test', 'workflow-coding'],
      step: 'TEST_DESIGN',
    });
    writeFileSync(join(cwd, '.smt', 'state', 'active-feature-sess-tr12-old.json'), JSON.stringify({ slug: 'feature-tr12-old', session_id: 'sess-tr12-old', updated_at: 1 }));
    writeFileSync(join(cwd, '.smt', 'state', 'active-feature-sess-tr12-new.json'), JSON.stringify({ slug: 'feature-tr12-new', session_id: 'sess-tr12-new', updated_at: 2 }));

    runRecorder({
      cwd, sessionId: undefined,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'npx vitest run client/src/components/image-upload-with-crop-utils.test.ts' },
        tool_response: { exit_code: 1 },
      },
    });

    const oldState = JSON.parse(readFileSync(oldPath, 'utf8'));
    const newState = JSON.parse(readFileSync(newPath, 'utf8'));
    assert.equal((oldState.events || []).filter((e) => e.type === 'test_red').length, 0, 'older session must not receive RED event');
    assert.equal((newState.events || []).filter((e) => e.type === 'test_red').length, 1, 'newest recordable session must receive RED event');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
