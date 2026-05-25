#!/usr/bin/env node

import {
  USER_MODES,
  TASK_TYPES,
  STEPS,
  resolveContract,
  allowedActionsFor,
} from './workflow-v4-contract.mjs';

export const V4_SCHEMA_VERSION = '0.4.0';

function initialVerification(taskType) {
  if (taskType === 'write') {
    return { unit: 'pending', e2e: 'pending', hidden: 'pending', runtime: 'pending' };
  }
  if (taskType === 'verify') {
    return { unit: 'pending', e2e: 'pending', hidden: 'not_required', runtime: 'pending' };
  }
  return { unit: 'not_required', e2e: 'not_required', hidden: 'not_required', runtime: 'not_required' };
}

export function createV4State({ taskId, userMode }) {
  if (!taskId || typeof taskId !== 'string') throw new Error('taskId is required');
  const contract = resolveContract(userMode);
  const now = new Date().toISOString();
  return {
    schema_version: V4_SCHEMA_VERSION,
    task_id: taskId,
    user_mode: contract.user_mode,
    task_type: contract.task_type,
    step: 'INTENT',
    step_flow: contract.steps,
    allowed_actions: allowedActionsFor({ task_type: contract.task_type, step: 'INTENT' }),
    verification: initialVerification(contract.task_type),
    last_event: null,
    events: [],
    created_at: now,
    updated_at: now,
  };
}

export function validateV4State(state) {
  const errors = [];
  const push = (field, message) => errors.push(`${field}: ${message}`);

  if (!state || typeof state !== 'object') return ['root: must be object'];
  if (state.schema_version !== V4_SCHEMA_VERSION) push('schema_version', `expected ${V4_SCHEMA_VERSION}`);
  if (typeof state.task_id !== 'string' || !state.task_id) push('task_id', 'required string');
  if (!USER_MODES.includes(state.user_mode)) push('user_mode', `invalid: ${state.user_mode}`);
  if (!TASK_TYPES.includes(state.task_type)) push('task_type', `invalid: ${state.task_type}`);
  if (!STEPS.includes(state.step)) push('step', `invalid: ${state.step}`);
  if (!Array.isArray(state.step_flow)) push('step_flow', 'must be array');
  if (!Array.isArray(state.allowed_actions)) push('allowed_actions', 'must be array');
  if (!state.verification || typeof state.verification !== 'object') push('verification', 'must be object');
  if (!Array.isArray(state.events)) push('events', 'must be array');

  if (Object.prototype.hasOwnProperty.call(state, 'mode')) {
    push('mode', 'legacy compatibility field is forbidden in v0.4 state');
  }
  if (Object.prototype.hasOwnProperty.call(state, 'current_stage')) {
    push('current_stage', 'legacy compatibility field is forbidden in v0.4 state');
  }
  if (Object.prototype.hasOwnProperty.call(state, 'allowed_skills')) {
    push('allowed_skills', 'legacy compatibility field is forbidden in v0.4 state');
  }

  return errors;
}

export function appendV4Event(state, event) {
  if (!state || typeof state !== 'object') throw new Error('state is required');
  if (!event || typeof event !== 'object') throw new Error('event is required');
  if (!event.type || typeof event.type !== 'string') throw new Error('event.type is required');
  if (!['hook', 'user', 'controller'].includes(event.declarer)) {
    throw new Error('event.declarer must be hook|user|controller');
  }
  const entry = { t: new Date().toISOString(), ...event };
  state.events.push(entry);
  state.last_event = entry;
  state.updated_at = new Date().toISOString();
  return state;
}

export function transitionV4State(state, step) {
  if (!STEPS.includes(step)) throw new Error(`invalid step: ${step}`);
  state.step = step;
  state.allowed_actions = allowedActionsFor({ task_type: state.task_type, step });
  state.updated_at = new Date().toISOString();
  return state;
}
