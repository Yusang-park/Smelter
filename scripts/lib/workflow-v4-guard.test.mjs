#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';

import { createV4State, transitionV4State } from './workflow-v4-state.mjs';
import { evaluateToolUse } from './workflow-v4-guard.mjs';

test('read contract blocks source writes even during DISCOVERY', () => {
  const state = createV4State({ taskId: 't1', userMode: 'explore' });
  transitionV4State(state, 'DISCOVERY');
  const result = evaluateToolUse(state, { toolName: 'Write', filePath: '/repo/src/app.ts' });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /task_type=read/);
});

test('design contract allows planning artifacts but blocks product source', () => {
  const state = createV4State({ taskId: 't2', userMode: 'brainstorm' });
  transitionV4State(state, 'PLAN');
  assert.equal(evaluateToolUse(state, { toolName: 'Write', filePath: '/repo/.smt/features/x/task/plan.md' }).decision, 'allow');
  assert.equal(evaluateToolUse(state, { toolName: 'Write', filePath: '/repo/src/app.ts' }).decision, 'block');
});

test('write contract blocks source edits before TEST_DESIGN has a red test event', () => {
  const state = createV4State({ taskId: 't3', userMode: 'implement' });
  transitionV4State(state, 'EXECUTE');
  const result = evaluateToolUse(state, { toolName: 'Edit', filePath: '/repo/src/app.ts' });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /red test/i);
});

test('write contract blocks non-JS source extensions before EXECUTE', () => {
  const state = createV4State({ taskId: 't3d', userMode: 'implement' });
  transitionV4State(state, 'TEST_DESIGN');
  assert.equal(evaluateToolUse(state, { toolName: 'Write', filePath: '/repo/src/task.rb' }).decision, 'block');
  assert.equal(evaluateToolUse(state, { toolName: 'Write', filePath: '/repo/db/schema.sql' }).decision, 'block');
});

test('write contract allows test file writes during TEST_DESIGN', () => {
  const state = createV4State({ taskId: 't3b', userMode: 'implement' });
  transitionV4State(state, 'TEST_DESIGN');
  const result = evaluateToolUse(state, { toolName: 'Write', filePath: '/repo/scripts/lib/hook-guards.test.mjs' });
  assert.equal(result.decision, 'allow');
});

test('write contract blocks test file edits during EXECUTE', () => {
  const state = createV4State({ taskId: 't3c', userMode: 'fix' });
  state.events.push({ t: new Date().toISOString(), type: 'test_red', declarer: 'hook' });
  transitionV4State(state, 'EXECUTE');
  const result = evaluateToolUse(state, { toolName: 'Edit', filePath: '/repo/src/app.test.ts' });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /test write blocked at phase=EXECUTE/);
});

test('write contract allows source edits in EXECUTE after red test evidence', () => {
  const state = createV4State({ taskId: 't4', userMode: 'fix' });
  state.events.push({ t: new Date().toISOString(), type: 'test_red', declarer: 'hook' });
  transitionV4State(state, 'EXECUTE');
  const result = evaluateToolUse(state, { toolName: 'Edit', filePath: '/repo/src/app.ts' });
  assert.equal(result.decision, 'allow');
});

test('write contract accepts legacy test_cycles red evidence in bridged runtime state', () => {
  const state = createV4State({ taskId: 't4b', userMode: 'fix' });
  state.test_cycles = [{ action: 'added_case', run_result: 'fail' }];
  transitionV4State(state, 'EXECUTE');
  const result = evaluateToolUse(state, { toolName: 'Edit', filePath: '/repo/src/app.ts' });
  assert.equal(result.decision, 'allow');
});

test('write contract accepts adopted dirty-worktree TDD evidence', () => {
  const state = createV4State({ taskId: 't4c', userMode: 'fix' });
  state.events.push({
    t: new Date().toISOString(),
    type: 'tdd_adopted',
    skill: 'workflow-write-test',
    result: 'pass',
    declarer: 'hook',
    evidence: { type: 'diff', summary: 'pre-existing user test/source changes adopted' },
  });
  transitionV4State(state, 'EXECUTE');
  const result = evaluateToolUse(state, { toolName: 'Edit', filePath: '/repo/src/app.ts' });
  assert.equal(result.decision, 'allow');
});

test('write contract accepts TDD exemption evidence in EXECUTE', () => {
  const state = createV4State({ taskId: 't4d', userMode: 'fix' });
  state.events.push({
    t: new Date().toISOString(),
    type: 'tdd_exempt',
    skill: 'workflow-write-test',
    result: 'pass',
    declarer: 'hook',
    evidence: { type: 'diff', summary: 'css_only' },
  });
  transitionV4State(state, 'EXECUTE');
  const result = evaluateToolUse(state, { toolName: 'Edit', filePath: '/repo/src/app.ts' });
  assert.equal(result.decision, 'allow');
});

test('infra contract allows infrastructure source edits during EXECUTE without red test evidence', () => {
  const state = createV4State({ taskId: 't-infra', userMode: 'infra' });
  transitionV4State(state, 'EXECUTE');
  const result = evaluateToolUse(state, { toolName: 'Write', filePath: '/repo/infra/main.tf' });
  assert.equal(result.decision, 'allow');
});

test('infra contract blocks infrastructure source edits before EXECUTE', () => {
  const state = createV4State({ taskId: 't-infra-plan', userMode: 'infra' });
  transitionV4State(state, 'PLAN');
  const result = evaluateToolUse(state, { toolName: 'Write', filePath: '/repo/infra/main.tf' });
  assert.equal(result.decision, 'block');
});

test('git commit is blocked until HUMAN_CHECK is done for mutating contracts', () => {
  for (const userMode of ['fix', 'infra', 'dobby']) {
    const state = createV4State({ taskId: `t-${userMode}`, userMode });
    transitionV4State(state, 'HUMAN_CHECK');
    assert.equal(evaluateToolUse(state, { toolName: 'Bash', command: 'git commit -m x' }).decision, 'block');
    transitionV4State(state, 'DONE');
    assert.equal(evaluateToolUse(state, { toolName: 'Bash', command: 'git commit -m x' }).decision, 'allow');
  }
});
