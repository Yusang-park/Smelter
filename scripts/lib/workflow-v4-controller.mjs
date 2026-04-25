#!/usr/bin/env node

const TEST_WEAKNESS_SIGNALS = new Set([
  'no_test',
  'weak_test',
  'mutation_survived',
  'hidden_test_fail',
]);

const EXECUTION_FAILURE_SIGNALS = new Set([
  'behavior_mismatch',
  'runtime_error',
  'snapshot_diff',
  'contract_validation',
  'assertion',
]);

export function nextV4Transition(state, event) {
  if (!state) return { step: null, reason: 'no_state' };
  const type = event?.type || '';

  if (state.step === 'HUMAN_CHECK') {
    if (type === 'human_pass') return { step: 'DONE', reason: 'human_approved' };
    if (type === 'human_reject') return { step: 'RECOVER', reason: 'human_rejected' };
    return { step: 'HUMAN_CHECK', reason: 'awaiting_human_check' };
  }

  if (type === 'verify_fail') {
    return { step: 'RECOVER', reason: 'verification_failed' };
  }

  if (state.step === 'RECOVER' || type === 'recover') {
    const signal = event?.signal || '';
    if (TEST_WEAKNESS_SIGNALS.has(signal)) return { step: 'TEST_DESIGN', reason: 'test_design_required' };
    if (EXECUTION_FAILURE_SIGNALS.has(signal)) return { step: 'EXECUTE', reason: 'execution_fix_required' };
    return { step: 'VERIFY', reason: 'rerun_verification' };
  }

  const flow = Array.isArray(state.step_flow) ? state.step_flow : [];
  const idx = flow.indexOf(state.step);
  if (idx >= 0 && idx < flow.length - 1) {
    return { step: flow[idx + 1], reason: 'advance' };
  }
  return { step: state.step || null, reason: 'no_transition' };
}
