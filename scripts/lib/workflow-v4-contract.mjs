#!/usr/bin/env node

export const USER_MODES = Object.freeze([
  'brainstorm',
  'implement',
  'fix',
  'explore',
  'verify',
  'dobby',
]);

export const TASK_TYPES = Object.freeze([
  'read',
  'write',
  'design',
  'verify',
  'freeform',
]);

export const STEPS = Object.freeze([
  'INTENT',
  'DISCOVERY',
  'PLAN',
  'TEST_DESIGN',
  'EXECUTE',
  'VERIFY',
  'RECOVER',
  'HUMAN_CHECK',
  'DONE',
]);

export const COMMAND_TO_USER_MODE = Object.freeze({
  '/brainstorm': 'brainstorm',
  '/implement': 'implement',
  '/fix': 'fix',
  '/explore': 'explore',
  '/verify': 'verify',
  '/dobby': 'dobby',
});

const MODE_TO_TASK_TYPE = Object.freeze({
  brainstorm: 'design',
  explore: 'read',
  verify: 'verify',
  implement: 'write',
  fix: 'write',
  dobby: 'freeform',
});

const TASK_TYPE_TO_STEPS = Object.freeze({
  read: Object.freeze(['INTENT', 'DISCOVERY', 'DONE']),
  design: Object.freeze(['INTENT', 'PLAN', 'DONE']),
  verify: Object.freeze(['INTENT', 'DISCOVERY', 'VERIFY', 'HUMAN_CHECK', 'DONE']),
  write: Object.freeze(['INTENT', 'DISCOVERY', 'PLAN', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE']),
  freeform: Object.freeze(['INTENT', 'EXECUTE', 'HUMAN_CHECK', 'DONE']),
});

const STEP_ACTIONS = Object.freeze({
  INTENT: Object.freeze(['classify_intent']),
  DISCOVERY: Object.freeze(['read', 'write_artifact']),
  PLAN: Object.freeze(['read', 'write_artifact']),
  TEST_DESIGN: Object.freeze(['read', 'write_test', 'run_test']),
  EXECUTE: Object.freeze(['read', 'write_source', 'run_test']),
  VERIFY: Object.freeze(['read', 'run_test', 'run_e2e', 'write_artifact']),
  RECOVER: Object.freeze(['read', 'write_artifact']),
  HUMAN_CHECK: Object.freeze(['read', 'write_artifact', 'ask_user']),
  DONE: Object.freeze(['read', 'git_commit']),
});

export function resolveCommand(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  for (const [command, userMode] of Object.entries(COMMAND_TO_USER_MODE)) {
    if (!trimmed.startsWith(command)) continue;
    const rest = trimmed.slice(command.length);
    if (rest === '' || /^[:\s-]/.test(rest)) return userMode;
  }
  return null;
}

export function resolveTaskType(userMode) {
  if (!USER_MODES.includes(userMode)) throw new Error(`invalid user_mode: ${userMode}`);
  return MODE_TO_TASK_TYPE[userMode];
}

export function resolveStepFlow(taskType, { userMode = '' } = {}) {
  if (!TASK_TYPES.includes(taskType)) throw new Error(`invalid task_type: ${taskType}`);
  if (userMode === 'fix') {
    return ['INTENT', 'DISCOVERY', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE'];
  }
  return [...TASK_TYPE_TO_STEPS[taskType]];
}

export function resolveContract(userMode) {
  const taskType = resolveTaskType(userMode);
  return {
    user_mode: userMode,
    task_type: taskType,
    steps: resolveStepFlow(taskType, { userMode }),
  };
}

export function allowedActionsFor({ task_type, step }) {
  if (!TASK_TYPES.includes(task_type)) throw new Error(`invalid task_type: ${task_type}`);
  if (!STEPS.includes(step)) throw new Error(`invalid step: ${step}`);
  if (task_type === 'read' && step === 'DONE') return ['read'];
  if (task_type === 'design' && step === 'DONE') return ['read'];
  return [...(STEP_ACTIONS[step] ?? [])];
}
