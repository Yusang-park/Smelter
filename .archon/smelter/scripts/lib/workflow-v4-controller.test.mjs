#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';

import { createV4State } from './workflow-v4-state.mjs';
import { nextV4Transition } from './workflow-v4-controller.mjs';

test('pass events advance along the state step_flow', () => {
  const state = createV4State({ taskId: 't1', userMode: 'implement' });
  assert.deepEqual(nextV4Transition(state, { type: 'intent_resolved' }), { step: 'DISCOVERY', reason: 'advance' });
});

test('write VERIFY failure routes to RECOVER, never DONE or HUMAN_CHECK', () => {
  const state = createV4State({ taskId: 't2', userMode: 'implement' });
  state.step = 'VERIFY';
  const result = nextV4Transition(state, { type: 'verify_fail', signal: 'behavior_mismatch' });
  assert.equal(result.step, 'RECOVER');
  assert.equal(result.reason, 'verification_failed');
});

test('RECOVER routes weak-test signals to TEST_DESIGN', () => {
  const state = createV4State({ taskId: 't3', userMode: 'fix' });
  state.step = 'RECOVER';
  const result = nextV4Transition(state, { type: 'recover', signal: 'weak_test' });
  assert.equal(result.step, 'TEST_DESIGN');
});

test('RECOVER routes behavior/runtime signals to EXECUTE', () => {
  const state = createV4State({ taskId: 't4', userMode: 'fix' });
  state.step = 'RECOVER';
  assert.equal(nextV4Transition(state, { type: 'recover', signal: 'runtime_error' }).step, 'EXECUTE');
  assert.equal(nextV4Transition(state, { type: 'recover', signal: 'snapshot_diff' }).step, 'EXECUTE');
});

test('human pass is the only transition from HUMAN_CHECK to DONE', () => {
  const state = createV4State({ taskId: 't5', userMode: 'fix' });
  state.step = 'HUMAN_CHECK';
  assert.equal(nextV4Transition(state, { type: 'verify_pass' }).step, 'HUMAN_CHECK');
  assert.equal(nextV4Transition(state, { type: 'human_pass' }).step, 'DONE');
});
