#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canEnterPhase,
  evaluatePhaseToolUse,
  hasTddEntryEvidence,
  nextRequiredPhase,
  phaseForArtifactPath,
  phaseForSkill,
  transitionPhase,
} from './phase-gate.mjs';

function state(overrides = {}) {
  return {
    task_type: 'write',
    user_mode: 'fix',
    step: 'DISCOVERY',
    step_flow: ['INTENT', 'DISCOVERY', 'PLAN', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE'],
    allowed_actions: [],
    events: [],
    test_cycles: [],
    exempt: { tdd: false, e2e: false },
    ...overrides,
  };
}

test('phaseForSkill maps workflow skills to canonical phases', () => {
  assert.equal(phaseForSkill('workflow-investigate'), 'DISCOVERY');
  assert.equal(phaseForSkill('workflow-write-test'), 'TEST_DESIGN');
  assert.equal(phaseForSkill('workflow-coding'), 'EXECUTE');
  assert.equal(phaseForSkill('workflow-human-check'), 'HUMAN_CHECK');
});

test('phaseForArtifactPath maps canonical artifacts to phases', () => {
  assert.equal(phaseForArtifactPath('/repo/.smt/features/x/task/investigation.md'), 'DISCOVERY');
  assert.equal(phaseForArtifactPath('/repo/.smt/features/x/task/implementation-plan.md'), 'PLAN');
  assert.equal(phaseForArtifactPath('/repo/.smt/features/x/task/results.md'), 'HUMAN_CHECK');
});

test('nextRequiredPhase follows state.step_flow, not allowed_skills order', () => {
  assert.equal(nextRequiredPhase(state({ step: 'DISCOVERY' })), 'PLAN');
  assert.equal(nextRequiredPhase(state({ step: 'TEST_DESIGN' })), 'EXECUTE');
});

test('transitionPhase blocks phase skips', () => {
  const s = state({ step: 'DISCOVERY' });
  assert.throws(() => transitionPhase(s, 'EXECUTE'), /phase skip blocked/i);
});

test('transitionPhase allows the next required phase when gate passes', () => {
  const s = state({ step: 'DISCOVERY' });
  transitionPhase(s, 'PLAN');
  assert.equal(s.step, 'PLAN');
});

test('EXECUTE gate accepts RED, adopted, exempt-event, or state exemption', () => {
  assert.equal(hasTddEntryEvidence(state()), false);
  assert.equal(hasTddEntryEvidence(state({ events: [{ type: 'test_red' }] })), true);
  assert.equal(hasTddEntryEvidence(state({ events: [{ type: 'tdd_adopted' }] })), true);
  assert.equal(hasTddEntryEvidence(state({ events: [{ type: 'tdd_exempt' }] })), true);
  assert.equal(hasTddEntryEvidence(state({ exempt: { tdd: true } })), true);
  assert.equal(hasTddEntryEvidence(state({ target_type: 'design' })), true);
  assert.equal(hasTddEntryEvidence(state({ surface: ['src/app.css'] })), true);
});

test('canEnterPhase blocks write EXECUTE without executable specification RED evidence', () => {
  const verdict = canEnterPhase(state({ step: 'TEST_DESIGN' }), 'EXECUTE');
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /executable specification RED evidence/i);
});

test('canEnterPhase allows write EXECUTE with tdd_exempt evidence', () => {
  const verdict = canEnterPhase(state({ step: 'TEST_DESIGN', events: [{ type: 'tdd_exempt' }] }), 'EXECUTE');
  assert.equal(verdict.decision, 'allow');
});

test('evaluatePhaseToolUse blocks skill calls outside their phase', () => {
  const verdict = evaluatePhaseToolUse(state({ step: 'DISCOVERY' }), { toolName: 'Skill', skill: 'workflow-coding' });
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /requires phase EXECUTE/i);
});

test('evaluatePhaseToolUse blocks source edits outside EXECUTE', () => {
  const verdict = evaluatePhaseToolUse(state({ step: 'TEST_DESIGN' }), { toolName: 'Edit', filePath: '/repo/src/app.ts' });
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /source edit requires EXECUTE/i);
});

test('evaluatePhaseToolUse allows source edits in EXECUTE with TDD exemption', () => {
  const verdict = evaluatePhaseToolUse(
    state({ step: 'EXECUTE', events: [{ type: 'tdd_exempt' }] }),
    { toolName: 'Edit', filePath: '/repo/src/app.ts' },
  );
  assert.equal(verdict.decision, 'allow');
  assert.match(verdict.reason, /executable specification RED evidence/i);
});
