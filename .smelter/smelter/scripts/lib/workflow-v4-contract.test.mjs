#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  USER_MODES,
  TASK_TYPES,
  STEPS,
  resolveCommand,
  resolveTaskType,
  resolveStepFlow,
  resolveContract,
  allowedActionsFor,
} from './workflow-v4-contract.mjs';

test('v0.4 canonical enum sets are explicit and contain no retired think/investigate modes', () => {
  assert.deepEqual([...USER_MODES].sort(), ['brainstorm', 'explore', 'fix', 'implement', 'infra', 'verify']);
  assert.deepEqual([...TASK_TYPES].sort(), ['design', 'freeform', 'infra', 'read', 'verify', 'write']);
  assert.ok(STEPS.includes('INTENT'));
  assert.ok(STEPS.includes('RECOVER'));
  assert.equal(USER_MODES.includes('think'), false);
  assert.equal(USER_MODES.includes('investigate'), false);
});

test('resolveCommand accepts /brainstorm and /explore and rejects retired aliases', () => {
  assert.equal(resolveCommand('/brainstorm new auth flow'), 'brainstorm');
  assert.equal(resolveCommand('/brainstorm:new auth flow'), 'brainstorm');
  assert.equal(resolveCommand('/explore auth flow'), 'explore');
  assert.equal(resolveCommand('/infra destroy unused aws stack'), 'infra');
  assert.equal(resolveCommand('/investigate auth flow'), null);
  assert.equal(resolveCommand('/think new auth flow'), null);
  assert.equal(resolveCommand('/plan new auth flow'), null);
  assert.equal(resolveCommand('/simple-fix copy'), null);
});

test('UserMode maps to TaskType by side-effect contract', () => {
  assert.equal(resolveTaskType('brainstorm'), 'design');
  assert.equal(resolveTaskType('explore'), 'read');
  assert.equal(resolveTaskType('verify'), 'verify');
  assert.equal(resolveTaskType('implement'), 'write');
  assert.equal(resolveTaskType('fix'), 'write');
  assert.equal(resolveTaskType('infra'), 'infra');
});

test('TaskType resolves to deterministic step flow', () => {
  assert.deepEqual(resolveStepFlow('read'), ['INTENT', 'DISCOVERY', 'DONE']);
  assert.deepEqual(resolveStepFlow('design'), ['INTENT', 'DISCOVERY', 'PLAN', 'DONE']);
  assert.deepEqual(resolveStepFlow('verify'), ['INTENT', 'DISCOVERY', 'VERIFY', 'HUMAN_CHECK', 'DONE']);
  assert.deepEqual(resolveStepFlow('write'), ['INTENT', 'DISCOVERY', 'PLAN', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE']);
  assert.deepEqual(resolveStepFlow('infra'), ['INTENT', 'DISCOVERY', 'PLAN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE']);
  assert.deepEqual(resolveStepFlow('freeform'), ['INTENT', 'EXECUTE', 'HUMAN_CHECK', 'DONE']);
});

test('infra contract separates infrastructure work from code TDD flow', () => {
  const contract = resolveContract('infra');
  assert.equal(contract.user_mode, 'infra');
  assert.equal(contract.task_type, 'infra');
  assert.deepEqual(contract.steps, ['INTENT', 'DISCOVERY', 'PLAN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE']);
  assert.equal(contract.steps.includes('TEST_DESIGN'), false);
});

test('fix is a write contract with compact tasker PLAN plus test/verify/human gates', () => {
  const contract = resolveContract('fix');
  assert.equal(contract.user_mode, 'fix');
  assert.equal(contract.task_type, 'write');
  assert.deepEqual(contract.steps, ['INTENT', 'DISCOVERY', 'PLAN', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE']);
});

test('allowedActionsFor derives actions from TaskType and Step, not mode names', () => {
  assert.deepEqual(allowedActionsFor({ task_type: 'read', step: 'DISCOVERY' }), ['read', 'write_artifact']);
  assert.deepEqual(allowedActionsFor({ task_type: 'design', step: 'PLAN' }), ['read', 'write_artifact']);
  assert.deepEqual(allowedActionsFor({ task_type: 'write', step: 'TEST_DESIGN' }), ['read', 'write_test', 'run_test']);
  assert.deepEqual(allowedActionsFor({ task_type: 'write', step: 'EXECUTE' }), ['read', 'write_source', 'run_test']);
  assert.deepEqual(allowedActionsFor({ task_type: 'infra', step: 'EXECUTE' }), ['read', 'write_source', 'run_infra', 'write_artifact']);
  assert.deepEqual(allowedActionsFor({ task_type: 'verify', step: 'VERIFY' }), ['read', 'run_test', 'run_e2e', 'write_artifact']);
});
