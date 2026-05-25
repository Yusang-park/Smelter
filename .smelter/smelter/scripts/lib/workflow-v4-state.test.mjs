#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createV4State,
  validateV4State,
  appendV4Event,
  transitionV4State,
} from './workflow-v4-state.mjs';

test('createV4State persists user_mode, task_type, step, allowed_actions, and verification status', () => {
  const state = createV4State({ taskId: 't1', userMode: 'brainstorm' });
  assert.equal(state.schema_version, '0.4.0');
  assert.equal(state.task_id, 't1');
  assert.equal(state.user_mode, 'brainstorm');
  assert.equal(state.task_type, 'design');
  assert.equal(state.step, 'INTENT');
  assert.deepEqual(state.step_flow, ['INTENT', 'DISCOVERY', 'PLAN', 'DONE']);
  assert.deepEqual(state.allowed_actions, ['classify_intent']);
  assert.equal(state.verification.unit, 'not_required');
  assert.deepEqual(validateV4State(state), []);
});

test('write state starts with pending verification layers', () => {
  const state = createV4State({ taskId: 't2', userMode: 'implement' });
  assert.equal(state.task_type, 'write');
  assert.equal(state.verification.unit, 'pending');
  assert.equal(state.verification.e2e, 'pending');
  assert.equal(state.verification.hidden, 'pending');
  assert.equal(state.verification.runtime, 'pending');
});

test('live command mode explore creates valid v0.4 state', () => {
  const explore = createV4State({ taskId: 't-explore', userMode: 'explore' });
  assert.equal(explore.task_type, 'read');
  assert.deepEqual(explore.step_flow, ['INTENT', 'DISCOVERY', 'DONE']);
  assert.deepEqual(validateV4State(explore), []);
});

test('validateV4State rejects v3 compatibility fields as source of truth', () => {
  const state = createV4State({ taskId: 't3', userMode: 'fix' });
  state.mode = 'fix';
  state.current_stage = 'workflow-coding';
  const errors = validateV4State(state);
  assert.ok(errors.some((e) => e.includes('mode')));
  assert.ok(errors.some((e) => e.includes('current_stage')));
});

test('appendV4Event records hook-owned events and transitionV4State updates allowed actions', () => {
  const state = createV4State({ taskId: 't4', userMode: 'fix' });
  appendV4Event(state, { type: 'intent_resolved', declarer: 'hook' });
  transitionV4State(state, 'DISCOVERY');
  assert.equal(state.step, 'DISCOVERY');
  assert.deepEqual(state.allowed_actions, ['read', 'write_artifact']);
  assert.equal(state.events.at(-1).type, 'intent_resolved');
  assert.deepEqual(validateV4State(state), []);
});
