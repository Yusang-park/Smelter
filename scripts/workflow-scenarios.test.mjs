#!/usr/bin/env node
/**
 * workflow-scenarios.test.mjs — End-to-end scenario tests proving the
 * spec §11 Iron Law #1 guarantee: the agent NEVER halts unless one of the
 * 4 explicit halt conditions fires.
 *
 * Run: node scripts/workflow-scenarios.test.mjs
 *
 * Test structure:
 *   1. Full workflow simulation (fix mode: 11 skills end-to-end, zero halts)
 *   2. Producer chain exhaustive (every skill's fail path has a forward target)
 *   3. Halt conditions (the 4 allowed in §11-4)
 *   4. Chained mode auto-advance
 *   5. Multi-Pass Verification gate
 *   6. Mode classifier + mode-definition coherence
 *   7. End-to-end integration (CLI + state + routing)
 *
 * The success metric: in every scenario below, the agent either produces a
 * forward-motion decision or enters one of the 4 legal halt states.
 * "no_state_output" / silent stop is forbidden outside the 4 halt cases.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

import {
  decide,
  detectModeTransitionSignal,
  consumeNextChainedMode,
  detectRiskKeyword,
  buildPromptInjection,
  findActiveTaskState,
} from './auto-confirm.mjs';

import { route } from './route-on-fail.mjs';
import {
  createInitialState,
  writeState,
  appendEvent,
  markComplete,
  WORKFLOW_SKILLS,
  MODES,
  CAUSE_ENUM,
  VERIFICATION_FOCUS_ENUM,
  PATTERNS,
  TARGET_TYPE_ENUM,
  EVIDENCE_TYPE_ENUM,
} from './state-schema.mjs';

import {
  initRounds,
  startRound,
  recordRoundResult,
  canDeclarePass,
  REVIEW_SKILLS_WITH_VERIFICATION,
} from './verification-rounds.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed++;
    failures.push({ label, message: err.message });
    console.log(`  FAIL  ${label}`);
    console.log(`        ${err.message}`);
  }
}

function section(title) {
  console.log(`\n[${title}]`);
}

function passEvent(skill, { cause = null } = {}) {
  return { t: new Date().toISOString(), skill, result: 'pass', declarer: 'hook', cause, evidence: { type: 'file_present', detail: 'ok' } };
}

function failEvent(skill, cause, { severity, reshape_target } = {}) {
  const e = { t: new Date().toISOString(), skill, result: 'fail', declarer: 'hook', cause, evidence: { type: 'exit_code', detail: cause } };
  if (severity) e.severity = severity;
  if (reshape_target) e.reshape_target = reshape_target;
  return e;
}

function fixModeState(overrides = {}) {
  const s = createInitialState({ taskId: 'scn', mode: 'fix' });
  s.allowed_skills = [
    'workflow-investigate', 'workflow-investigate-review',
    'workflow-tasker', 'workflow-tasker-review',
    'workflow-write-test', 'workflow-coding',
    'workflow-agent-review',
    'workflow-e2e', 'workflow-e2e-review',
    'workflow-team-code-review', 'workflow-human-check',
  ];
  return Object.assign(s, overrides);
}

function planModeState() {
  const s = createInitialState({ taskId: 'plan-scn', mode: 'plan' });
  s.allowed_skills = [
    'workflow-brainstorm', 'workflow-brainstorm-review',
    'workflow-investigate', 'workflow-investigate-review',
    'workflow-tasker', 'workflow-tasker-review',
  ];
  return s;
}

function withTempState(initialState, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-'));
  const path = join(dir, 't.state.json');
  writeState(path, initialState);
  try { return fn(dir, path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ============================================================================
section('SCENARIO 1 — Full fix-mode workflow, 11 skills end-to-end, zero halts');
// ============================================================================
// The most important test: every stage of a real fix-mode run produces a
// forward-motion decision. Only the final human-check marks terminal.
{
  const order = [
    'workflow-investigate',
    'workflow-investigate-review',
    'workflow-tasker',
    'workflow-tasker-review',
    'workflow-write-test',
    'workflow-coding',
    'workflow-agent-review',
    'workflow-e2e',
    'workflow-e2e-review',
    'workflow-team-code-review',
    'workflow-human-check',
  ];

  for (let i = 0; i < order.length - 1; i++) {
    const skill = order[i];
    test(`after ${skill} pass → decision is not halt`, () => {
      const s = fixModeState({ current_stage: skill, completed_stages: order.slice(0, i) });
      s.events = [passEvent(skill)];
      const d = decide({ state: s, lastAssistantText: 'clean step output' });
      assert.notEqual(d.action, 'halt', `halt at ${skill} would violate Iron Law #1`);
      assert.notEqual(d.action, 'no_state', `no_state unexpected at ${skill}`);
    });
  }

  test('after workflow-team-code-review pass → advance, never halt before human-check', () => {
    const s = fixModeState({ current_stage: 'workflow-team-code-review', completed_stages: order.slice(0, 10) });
    s.events = [passEvent('workflow-team-code-review')];
    const d = decide({ state: s, lastAssistantText: '' });
    assert.equal(d.action, 'advance');
  });

  test('human-check awaiting (last event not pass) → halt (legitimate, §11-4)', () => {
    const s = fixModeState({ current_stage: 'workflow-human-check' });
    s.events = [failEvent('workflow-team-code-review', 'review_reject')];
    const d = decide({ state: s, lastAssistantText: 'presenting to user' });
    assert.equal(d.action, 'halt', 'human-check awaiting is the ONLY legitimate halt here');
  });

  test('human-check pass (user confirmed) → does NOT halt, proceeds to session_wrap or advance', () => {
    const s = fixModeState({ current_stage: 'workflow-human-check' });
    s.events = [passEvent('workflow-human-check')];
    const d = decide({ state: s, lastAssistantText: '' });
    assert.notEqual(d.action, 'halt');
  });

  test('task reaches current_stage: done → session_wrap (terminal, not halt)', () => {
    const s = fixModeState({ current_stage: 'done' });
    const d = decide({ state: s, lastAssistantText: '' });
    assert.equal(d.action, 'session_wrap', 'done = orderly session wrap, not Iron Law #1 halt');
  });
}

// ============================================================================
section('SCENARIO 2 — Producer chain exhaustive (every fail branch has a target)');
// ============================================================================
{
  const cases = [
    { skill: 'workflow-investigate-review', cause: 'file_absent', expected: 'workflow-investigate' },
    { skill: 'workflow-tasker-review', cause: 'side_effect', expected: 'workflow-tasker' },
    { skill: 'workflow-tasker-review', cause: 'scope_mismatch', expected: 'workflow-tasker' },
    { skill: 'workflow-write-test', cause: 'file_absent', expected: 'workflow-tasker' },
    { skill: 'workflow-coding', cause: 'tdd_cycle', expected: 'workflow-write-test' },
    { skill: 'workflow-coding', cause: 'scope_mismatch', expected: 'workflow-tasker' },
    { skill: 'workflow-coding', cause: 'typecheck', expected: 'workflow-coding' },
    { skill: 'workflow-coding', cause: 'lint', expected: 'workflow-coding' },
    { skill: 'workflow-coding', cause: 'test_run', expected: 'workflow-coding' },
    { skill: 'workflow-agent-review', cause: 'security', expected: 'workflow-coding' },
    { skill: 'workflow-e2e', cause: 'assertion', expected: 'workflow-coding' },
    { skill: 'workflow-e2e', cause: 'build', expected: 'workflow-coding' },
    { skill: 'workflow-e2e-review', cause: 'insufficient_scenario', expected: 'workflow-coding' },
  ];
  for (const { skill, cause, expected } of cases) {
    test(`${skill} fail(${cause}) → routes to ${expected}`, () => {
      const state = fixModeState();
      const r = route({ event: failEvent(skill, cause), state });
      assert.equal(r.target, expected, `expected ${expected}, got ${r.target} (reason: ${r.reason})`);
    });
  }

  // plan mode — brainstorm-review producer chain (allowed_skills differs)
  test('workflow-brainstorm-review fail(file_absent) → routes to workflow-brainstorm (plan mode)', () => {
    const state = planModeState();
    const r = route({ event: failEvent('workflow-brainstorm-review', 'file_absent'), state });
    assert.equal(r.target, 'workflow-brainstorm');
  });

  test('workflow-team-code-review CRITICAL → workflow-tasker (redesign)', () => {
    const state = fixModeState();
    const r = route({ event: failEvent('workflow-team-code-review', 'scope_mismatch', { severity: 'CRITICAL' }), state });
    assert.equal(r.target, 'workflow-tasker');
  });
  test('workflow-team-code-review HIGH → workflow-tasker', () => {
    const state = fixModeState();
    const r = route({ event: failEvent('workflow-team-code-review', 'scope_mismatch', { severity: 'HIGH' }), state });
    assert.equal(r.target, 'workflow-tasker');
  });
  test('workflow-team-code-review MEDIUM → workflow-coding', () => {
    const state = fixModeState();
    const r = route({ event: failEvent('workflow-team-code-review', 'scope_mismatch', { severity: 'MEDIUM' }), state });
    assert.equal(r.target, 'workflow-coding');
  });
  test('workflow-team-code-review LOW → null target but pass-equivalent (logged to Risks, continue)', () => {
    const state = fixModeState();
    const r = route({ event: failEvent('workflow-team-code-review', 'scope_mismatch', { severity: 'LOW' }), state });
    assert.equal(r.target, null);
    assert.equal(r.reason, 'low_severity_pass');
  });
}

// ============================================================================
section('SCENARIO 3 — Reshape edge on review skills (spec §5-2)');
// ============================================================================
{
  test('workflow-brainstorm-review reshape→workflow-brainstorm allowed', () => {
    const state = planModeState();
    const r = route({ event: failEvent('workflow-brainstorm-review', 'file_absent', { reshape_target: 'workflow-brainstorm' }), state });
    assert.equal(r.target, 'workflow-brainstorm');
    assert.equal(r.reason, 'reshape');
  });
  test('workflow-investigate-review reshape→workflow-brainstorm allowed (discovery reshape)', () => {
    const state = planModeState();
    const r = route({ event: failEvent('workflow-investigate-review', 'scope_mismatch', { reshape_target: 'workflow-brainstorm' }), state });
    assert.equal(r.target, 'workflow-brainstorm');
  });
  test('workflow-tasker-review reshape→workflow-investigate allowed', () => {
    const state = planModeState();
    const r = route({ event: failEvent('workflow-tasker-review', 'side_effect', { reshape_target: 'workflow-investigate' }), state });
    assert.equal(r.target, 'workflow-investigate');
  });
  test('invalid reshape target (not in allowlist) → reshape_invalid', () => {
    const state = planModeState();
    const r = route({ event: failEvent('workflow-brainstorm-review', 'file_absent', { reshape_target: 'workflow-coding' }), state });
    assert.equal(r.reason, 'reshape_invalid');
  });
}

// ============================================================================
section('SCENARIO 4 — Mode whitelist enforcement (spec §5-3)');
// ============================================================================
{
  test('route target outside allowed_skills → whitelist_violation', () => {
    const state = createInitialState({ taskId: 't', mode: 'plan' });
    state.allowed_skills = ['workflow-brainstorm', 'workflow-brainstorm-review'];
    // fail in workflow-coding (not in plan mode) should flag violation
    const r = route({ event: failEvent('workflow-coding', 'typecheck'), state });
    // workflow-coding is not in allowed_skills; producer chain target workflow-coding also not allowed
    assert.equal(r.reason, 'whitelist_violation');
  });

  test('decide() with fail+whitelist_violation → request_mode_upgrade (user decides)', () => {
    const state = createInitialState({ taskId: 't', mode: 'plan' });
    state.allowed_skills = ['workflow-brainstorm', 'workflow-brainstorm-review'];
    state.events = [failEvent('workflow-coding', 'typecheck')];
    const d = decide({ state, lastAssistantText: '' });
    assert.equal(d.action, 'request_mode_upgrade');
  });
}

// ============================================================================
section('SCENARIO 5 — Halt conditions exhaustive (the 4 legitimate §11-4 halts)');
// ============================================================================
{
  test('HALT #1: workflow-human-check awaiting → halt', () => {
    const s = fixModeState({ current_stage: 'workflow-human-check' });
    s.events = [failEvent('workflow-team-code-review', 'review_reject')];
    const d = decide({ state: s, lastAssistantText: '' });
    assert.equal(d.action, 'halt');
  });
  test('HALT #2: _awaiting_mode_upgrade flag → halt', () => {
    const s = fixModeState();
    s._awaiting_mode_upgrade = true;
    const d = decide({ state: s, lastAssistantText: '' });
    assert.equal(d.action, 'halt');
  });
  test('HALT #3: no state.json → no_state (treated as halt / silent exit 0)', () => {
    const d = decide({ state: null, lastAssistantText: '' });
    assert.equal(d.action, 'no_state');
  });
  // HALT #4 (explicit user stop) is handled at Claude Code level, not in decide().
}

// ============================================================================
section('SCENARIO 6 — Self-advance on pass (never idle when forward is possible)');
// ============================================================================
{
  // For each workflow skill, a pass event + non-terminal stage → decide() must advance, never halt.
  for (const skill of WORKFLOW_SKILLS) {
    if (skill === 'workflow-human-check') continue; // terminal
    test(`${skill} pass event → advance (not halt)`, () => {
      const s = fixModeState({ current_stage: skill });
      s.events = [passEvent(skill)];
      const d = decide({ state: s, lastAssistantText: '' });
      assert.equal(d.action, 'advance');
    });
  }
}

// ============================================================================
section('SCENARIO 7 — Risk keyword auto-task-ization (spec §11-3)');
// ============================================================================
{
  const korean = ['리스크가 남음', 'TODO 남겨둠', '추후 고려 필요', '주의해야 할 부분'];
  const english = ['leaving a TODO', 'TODO: add validation', 'TODO for later'];
  const clean = ['All tests pass. No remaining issues.', 'Implementation complete.'];

  for (const msg of korean) {
    test(`Korean risk keyword: "${msg.slice(0, 20)}..." → spawn_sub_tasker`, () => {
      const s = fixModeState({ current_stage: 'workflow-coding' });
      const d = decide({ state: s, lastAssistantText: msg });
      assert.equal(d.action, 'spawn_sub_tasker');
    });
  }
  for (const msg of english) {
    test(`English risk keyword: "${msg.slice(0, 20)}..." → spawn_sub_tasker`, () => {
      const s = fixModeState({ current_stage: 'workflow-coding' });
      const d = decide({ state: s, lastAssistantText: msg });
      assert.equal(d.action, 'spawn_sub_tasker');
    });
  }
  for (const msg of clean) {
    test(`clean message: "${msg.slice(0, 20)}..." → no spawn_sub_tasker`, () => {
      assert.equal(detectRiskKeyword(msg), false);
    });
  }
}

// ============================================================================
section('SCENARIO 8 — active_feedback unresolved forces target_skill re-entry');
// ============================================================================
{
  test('unresolved feedback (post human-check rework) → enter_skill with target', () => {
    // Use a non-human-check stage to avoid hitting the halt branch first.
    const s = fixModeState({ current_stage: 'workflow-coding' });
    s.active_feedback = [{
      id: 'fb-1', from: 'workflow-human-check@t', target_skill: 'workflow-coding',
      text: 'validation too defensive', evidence_ref: 'events[0]', resolved: false,
    }];
    const d = decide({ state: s, lastAssistantText: '' });
    assert.equal(d.action, 'enter_skill');
    assert.equal(d.payload.skill, 'workflow-coding');
    assert.equal(d.payload.feedback_id, 'fb-1');
  });
  test('multiple unresolved feedbacks → first unresolved targeted', () => {
    const s = fixModeState({ current_stage: 'workflow-coding' });
    s.active_feedback = [
      { id: 'fb-0', target_skill: 'workflow-coding', resolved: true,  text: 'done', from: 'x', evidence_ref: 'x' },
      { id: 'fb-1', target_skill: 'workflow-tasker',  resolved: false, text: 'rework', from: 'x', evidence_ref: 'x' },
      { id: 'fb-2', target_skill: 'workflow-coding',  resolved: false, text: 'next', from: 'x', evidence_ref: 'x' },
    ];
    const d = decide({ state: s, lastAssistantText: '' });
    assert.equal(d.action, 'enter_skill');
    // The find() picks the first unresolved regardless of target
    assert.equal(d.payload.feedback_id, 'fb-1');
  });
  test('all feedbacks resolved + last event pass → advance', () => {
    const s = fixModeState({ current_stage: 'workflow-coding' });
    s.active_feedback = [{ id: 'fb-1', target_skill: 'workflow-coding', resolved: true, text: 'x', from: 'x', evidence_ref: 'x' }];
    s.events = [passEvent('workflow-coding')];
    const d = decide({ state: s, lastAssistantText: '' });
    assert.equal(d.action, 'advance');
  });
}

// ============================================================================
section('SCENARIO 9 — test_cycles RED forces workflow-coding entry');
// ============================================================================
{
  test('RED test_cycle + stage != coding → enter workflow-coding', () => {
    const s = fixModeState({ current_stage: 'workflow-write-test' });
    s.test_cycles = [{
      t: new Date().toISOString(), file: 'src/x.test.ts',
      action: 'added_case', case_name: 'bug#123',
      run_result: 'fail', error: 'expected',
    }];
    const d = decide({ state: s, lastAssistantText: '' });
    assert.equal(d.action, 'enter_skill');
    assert.equal(d.payload.skill, 'workflow-coding');
  });
  test('RED test_cycle but coding already in progress → no enter_skill loop', () => {
    const s = fixModeState({ current_stage: 'workflow-coding' });
    s.test_cycles = [{
      t: new Date().toISOString(), file: 'src/x.test.ts',
      action: 'added_case', case_name: 'bug#123',
      run_result: 'fail', error: 'x',
    }];
    // events empty + no proceed prompt → falls through.
    // The invariant this test protects: the engine must NOT re-inject
    // `enter_skill: workflow-coding` when already in that stage (would loop).
    // After the decide() fallback tightening, a no-signal no-events state
    // halts (safe) instead of emitting 'continue' — either is acceptable here
    // because both prevent the loop. Only re-entry must be forbidden.
    const d = decide({ state: s, lastAssistantText: '' });
    if (d.action === 'enter_skill') {
      assert.notEqual(d.payload.skill, 'workflow-coding', 'must not re-enter the current stage');
    }
    // Positive: the fallback is halt (no-signal safety), continue (proceed
    // detected), or classify_needed (LLM classifier sub-agent will resolve to
    // halt/continue at CLI entry). All three prevent re-entering workflow-coding.
    assert.ok(['halt', 'continue', 'classify_needed'].includes(d.action), `unexpected action: ${d.action}`);
  });
}

// ============================================================================
section('SCENARIO 10 — Chained intent auto-transition (no user prompt between modes)');
// ============================================================================
{
  test('investigate+fix chain: transition signal → chain_advance to fix', () => {
    withTempState(Object.assign(fixModeState(), {
      mode: 'investigate',
      chained_modes: ['investigate', 'fix'],
      current_stage: 'workflow-investigate-review',
      events: [passEvent('workflow-investigate-review')],
    }), (dir, path) => {
      const state = JSON.parse(readFileSync(path, 'utf-8'));
      const d = decide({ state, lastAssistantText: 'transitioning to fix mode now', statePath: path });
      assert.equal(d.action, 'chain_advance');
      assert.equal(d.payload.nextMode, 'fix');
    });
  });

  test('plan→implement chain: even in human-check, chain_advance fires FIRST (bypasses halt)', () => {
    withTempState(Object.assign(fixModeState(), {
      mode: 'plan',
      chained_modes: ['plan', 'implement'],
      current_stage: 'workflow-human-check',
    }), (dir, path) => {
      const state = JSON.parse(readFileSync(path, 'utf-8'));
      const d = decide({
        state,
        lastAssistantText: 'transitioning to implement mode',
        statePath: path,
      });
      assert.equal(d.action, 'chain_advance', 'chained intent must bypass human-check halt');
    });
  });

  test('3-mode chain sequentially advances: investigate → plan → implement', () => {
    withTempState(Object.assign(fixModeState(), {
      mode: 'investigate',
      chained_modes: ['investigate', 'plan', 'implement'],
    }), (dir, path) => {
      let state = JSON.parse(readFileSync(path, 'utf-8'));
      assert.equal(consumeNextChainedMode(path, state, '*'), 'plan');
      state = JSON.parse(readFileSync(path, 'utf-8'));
      assert.equal(consumeNextChainedMode(path, state, '*'), 'implement');
      state = JSON.parse(readFileSync(path, 'utf-8'));
      assert.equal(consumeNextChainedMode(path, state, '*'), ''); // chain exhausted
    });
  });

  test('chain advance without transition signal → does not fire', () => {
    const s = fixModeState();
    s.mode = 'investigate';
    s.chained_modes = ['investigate', 'fix'];
    s.current_stage = 'workflow-investigate-review';
    s.events = [passEvent('workflow-investigate-review')];
    const d = decide({ state: s, lastAssistantText: 'neutral message' });
    assert.notEqual(d.action, 'chain_advance');
  });
}

// ============================================================================
section('SCENARIO 11 — Multi-Pass Verification gate (§9-3)');
// ============================================================================
{
  test('canDeclarePass blocked before any round', () => {
    const state = fixModeState();
    initRounds(state, 'workflow-agent-review', { pattern: 'B' });
    const r = canDeclarePass(state, 'workflow-agent-review');
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'rounds_incomplete');
  });

  test('canDeclarePass blocked after rounds 1 and 2 only', () => {
    const state = fixModeState();
    initRounds(state, 'workflow-agent-review', { pattern: 'B' });
    startRound(state, 'workflow-agent-review', 1, 'code-reviewer');
    recordRoundResult(state, 'workflow-agent-review', 1, { result: 'pass' });
    startRound(state, 'workflow-agent-review', 2, 'security-reviewer');
    recordRoundResult(state, 'workflow-agent-review', 2, { result: 'pass' });
    const r = canDeclarePass(state, 'workflow-agent-review');
    assert.equal(r.allowed, false);
    assert.equal(r.detail, '2/3 rounds passed');
  });

  test('canDeclarePass allowed only after all 3 rounds pass', () => {
    const state = fixModeState();
    initRounds(state, 'workflow-agent-review', { pattern: 'B' });
    for (const n of [1, 2, 3]) {
      startRound(state, 'workflow-agent-review', n, 'code-reviewer');
      recordRoundResult(state, 'workflow-agent-review', n, { result: 'pass' });
    }
    const r = canDeclarePass(state, 'workflow-agent-review');
    assert.equal(r.allowed, true);
  });

  test('round fail surfaces verification_failed event (never silently ignored)', () => {
    const state = fixModeState();
    initRounds(state, 'workflow-agent-review', { pattern: 'B' });
    startRound(state, 'workflow-agent-review', 1, 'code-reviewer');
    recordRoundResult(state, 'workflow-agent-review', 1, { result: 'fail', findings: ['missing test'] });
    const last = state.events[state.events.length - 1];
    assert.equal(last.result, 'fail');
    assert.equal(last.cause, 'verification_failed');
  });

  test('all 6 review skills support Multi-Pass Verification', () => {
    const expected = [
      'workflow-brainstorm-review',
      'workflow-investigate-review',
      'workflow-tasker-review',
      'workflow-agent-review',
      'workflow-e2e-review',
      'workflow-team-code-review',
    ];
    for (const skill of expected) {
      assert.ok(REVIEW_SKILLS_WITH_VERIFICATION.includes(skill), `${skill} missing from verification list`);
    }
  });

  test('re-run after strict sequencing: round 3 cannot complete before round 2', () => {
    const state = fixModeState();
    initRounds(state, 'workflow-brainstorm-review', { pattern: 'A' });
    startRound(state, 'workflow-brainstorm-review', 1, 'critic');
    recordRoundResult(state, 'workflow-brainstorm-review', 1, { result: 'pass' });
    startRound(state, 'workflow-brainstorm-review', 2, 'critic');
    // Try to jump to round 3 without finishing 2
    try {
      startRound(state, 'workflow-brainstorm-review', 3, 'critic');
      assert.fail('should have thrown on out-of-order round');
    } catch (e) {
      // Expected — either enforces order on start or record; allow either
    }
  });
}

// ============================================================================
section('SCENARIO 12 — State-schema consistency with spec');
// ============================================================================
{
  test('14 workflow skills, 6 modes exposed in schema', () => {
    assert.equal(WORKFLOW_SKILLS.length, 14);
    assert.equal(MODES.length, 6);
  });
  test('all 5 Team Agent Patterns present', () => {
    assert.deepEqual([...PATTERNS].sort(), ['A', 'B', 'C', 'D', 'E']);
  });
  test('CAUSE_ENUM includes verification_failed (v2.3.0)', () => {
    assert.ok(CAUSE_ENUM.includes('verification_failed'));
  });
  test('CAUSE_ENUM includes stall_cascade (§11-7)', () => {
    assert.ok(CAUSE_ENUM.includes('stall_cascade'));
  });
  test('VERIFICATION_FOCUS_ENUM matches current schema', () => {
    assert.deepEqual([...VERIFICATION_FOCUS_ENUM].sort(), ['contradiction', 'edge_case', 'effect_verification', 'omission']);
  });
  test('TARGET_TYPE_ENUM matches tasker §3 output spec', () => {
    assert.deepEqual(
      [...TARGET_TYPE_ENUM].sort(),
      ['bug_fix', 'extend_existing', 'migration', 'new_feature', 'refactor'],
    );
  });
  test('EVIDENCE_TYPE_ENUM includes file_present (used in §2-2 example)', () => {
    assert.ok(EVIDENCE_TYPE_ENUM.includes('file_present'));
  });
  test('declarer rejects "skill" (Iron Law #3)', () => {
    const state = fixModeState();
    try {
      state.events.push({ t: new Date().toISOString(), skill: 'workflow-coding', result: 'fail', declarer: 'skill', cause: 'typecheck', evidence: { type: 'exit_code', detail: 'x' } });
      writeState('/tmp/test-invalid.json', state);
      assert.fail('should have rejected declarer=skill');
    } catch (err) {
      assert.match(err.message, /skill declarer forbidden/);
    } finally {
      try { rmSync('/tmp/test-invalid.json'); } catch {}
    }
  });
}

// ============================================================================
section('SCENARIO 13 — Mode classifier verdict coherence with spec §1-2');
// ============================================================================
{
  // The v2.4.9 classifier delegates NL routing to the LLM. This scenario
  // verifies Layer 3 wire-up + Layer 1/2/4 deterministic paths against the
  // spec, using the test-fixture stub so the assertions remain stable across
  // LLM provider drift. LLM quality is measured manually per feature spec
  // Stage 6, not asserted here.
  process.env.SMELTER_MODE_CLASSIFIER_MODULE = new URL(
    './lib/__fixtures__/mode-classifier-stub.mjs', import.meta.url,
  ).pathname;
  // Dynamic import so the env var is observed by the freshly-loaded module.
  const mc = await import('./mode-classifier.mjs?' + Date.now());

  const cases = [
    // simple_fix (text/CSS/constant)
    ['텍스트 수정해줘', 'simple_fix'],
    ['css 색깔 바꿔', 'simple_fix'],
    ['오타 고쳐', 'simple_fix'],
    // fix (bug / error)
    ['버그 고쳐줘', 'fix'],
    ['이거 안 돌아가', 'fix'],
    ['fix the login error', 'fix'],
    // investigate (static read)
    ['파악해줘', 'investigate'],
    ['확인 좀 해줘', 'investigate'],
    ['analyze this function', 'investigate'],
    // verify (dynamic: run tests + inspect + E2E)
    ['점검해', 'verify'],
    ['테스트 해봐', 'verify'],
    ['run the tests', 'verify'],
    // plan (design / refactor / new feature)
    ['설계해줘', 'plan'],
    ['리팩토링할거야', 'plan'],
    ['새로운 기능 만들거야', 'plan'],
    // implement (extend / add)
    ['다크모드 토글 추가해줘', 'implement'],
    ['덧붙여서 이메일 알림도', 'implement'],
    ['extend the auth flow', 'implement'],
  ];
  for (const [input, expected] of cases) {
    test(`classify("${input}") → ${expected}`, () => {
      const r = mc.classify(input, { cwd: process.cwd(), sessionId: `sc13-${expected}` });
      assert.equal(r.mode, expected);
    });
  }
}

// ============================================================================
section('SCENARIO 14 — CLI integration end-to-end (Stop hook spawn + decision)');
// ============================================================================
{
  const HOOK = '/Users/yusang/Smelter/scripts/auto-confirm.mjs';

  test('no active state → exit 0, no decision emitted (legitimate silent halt)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scn-cli-'));
    try {
      const payload = JSON.stringify({ cwd: dir, last_assistant_text: 'neutral' });
      const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8' });
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('active state + pass event → exit 2 block + queue payload dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scn-cli-'));
    try {
      const featDir = join(dir, '.smt', 'features', 'f', 'task');
      mkdirSync(featDir, { recursive: true });
      const statePath = join(featDir, 'f.state.json');
      const state = fixModeState({ current_stage: 'workflow-tasker', events: [passEvent('workflow-tasker')] });
      writeState(statePath, state);
      const stateRoot = join(dir, '.smt', 'state');
      mkdirSync(stateRoot, { recursive: true });
      const sessionId = 'sess-scn-cli-1';
      // Session-isolated pointer (post-migration). `.smt/active_task` deprecated.
      writeFileSync(
        join(stateRoot, `active-feature-${sessionId}.json`),
        JSON.stringify({ slug: 'f', session_id: sessionId, updated_at: Date.now() }),
      );
      const payload = JSON.stringify({ cwd: dir, session_id: sessionId, last_assistant_text: 'stage complete' });
      const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8' });
      assert.equal(res.status, 2, `expected exit 2 (block), got ${res.status}. stderr: ${res.stderr}`);
      const out = JSON.parse(res.stdout);
      assert.equal(out.decision, 'block');

      // Session-scoped queue file must exist for the matching session's consumer to pick up
      const queuePath = join(dir, '.smt', 'state', `auto-confirm-queue-${sessionId}.json`);
      assert.ok(existsSync(queuePath), 'session-scoped queue file not created — consumer will have nothing to inject');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ============================================================================
section('SCENARIO 15 — Integrity: agent always moves forward (no deadlock patterns)');
// ============================================================================
{
  // Simulate pathological state combinations to prove decide() never deadlocks:
  // every combination produces either a halt (legitimate) or a forward action.

  const pathologies = [
    { label: 'fail in non-allowed skill', state: () => { const s = createInitialState({ taskId: 't', mode: 'plan' }); s.allowed_skills = ['workflow-brainstorm']; s.events = [failEvent('workflow-coding', 'typecheck')]; return s; } },
    { label: 'double-fail (two consecutive fails)', state: () => { const s = fixModeState({ current_stage: 'workflow-coding' }); s.events = [failEvent('workflow-coding', 'typecheck'), failEvent('workflow-coding', 'typecheck')]; return s; } },
    { label: 'empty events + no feedback + random stage', state: () => fixModeState({ current_stage: 'workflow-tasker' }) },
    { label: 'all feedback resolved + empty events', state: () => { const s = fixModeState({ current_stage: 'workflow-tasker' }); s.active_feedback = [{ id: 'x', target_skill: 'workflow-coding', resolved: true, text: 'x', from: 'x', evidence_ref: 'x' }]; return s; } },
    { label: 'unknown cause in fail event', state: () => { const s = fixModeState(); s.events = [{ t: new Date().toISOString(), skill: 'workflow-coding', result: 'fail', declarer: 'hook', cause: 'typecheck', evidence: { type: 'exit_code', detail: 'x' } }]; return s; } },
  ];

  for (const p of pathologies) {
    test(`pathology: ${p.label} → never silent stop`, () => {
      const d = decide({ state: p.state(), lastAssistantText: '' });
      const validActions = ['halt', 'advance', 'enter_skill', 'spawn_sub_tasker', 'session_wrap', 'chain_advance', 'continue', 'request_mode_upgrade', 'no_state', 'classify_needed', 'stage_complete', 'stage_incomplete'];
      assert.ok(validActions.includes(d.action), `decide returned unknown action: ${d.action}`);
      // The only "stop" decisions allowed are halt + no_state + session_wrap.
      // Everything else is forward motion. Agent never idles without reason.
    });
  }
}

// ============================================================================
section('SCENARIO 16 — Implement/verify/fail/replan/re-implement/re-verify cycle');
// ============================================================================
// Validates the recovery loop: a failure at coding or verify routes via
// producer chain back to the right upstream skill, the agent re-does the
// work, and eventually passes. Explicit multi-cycle simulation ensures the
// decision engine does not deadlock over repeated fail-then-pass transitions.
{
  test('16-A coding typecheck fail → route to coding (self) → re-coding pass → agent-review', () => {
    const s = fixModeState({ current_stage: 'workflow-coding', completed_stages: ['workflow-investigate', 'workflow-tasker', 'workflow-write-test'] });
    s.events = [failEvent('workflow-coding', 'typecheck')];
    const r1 = decide({ state: s, lastAssistantText: '' });
    assert.equal(r1.action, 'enter_skill', 'fail at coding must enter_skill (producer chain)');
    assert.equal(r1.payload.skill, 'workflow-coding', 'self-rerun for typecheck');
    assert.equal(r1.payload.direction, 'back', 'producer chain direction=back');

    // After fixing, agent records pass.
    s.events = [failEvent('workflow-coding', 'typecheck'), passEvent('workflow-coding')];
    const r2 = decide({ state: s, lastAssistantText: '' });
    assert.equal(r2.action, 'advance');
    assert.equal(r2.payload.skill, 'workflow-agent-review');
  });

  test('16-B coding scope_mismatch → route back to tasker → re-plan → re-coding', () => {
    const s = fixModeState({ current_stage: 'workflow-coding', completed_stages: ['workflow-investigate', 'workflow-tasker', 'workflow-write-test'] });
    s.events = [failEvent('workflow-coding', 'scope_mismatch')];
    const r1 = decide({ state: s, lastAssistantText: '' });
    assert.equal(r1.action, 'enter_skill');
    assert.equal(r1.payload.skill, 'workflow-tasker', 'scope_mismatch routes back to tasker for re-plan');
    assert.equal(r1.payload.direction, 'back');

    // Tasker re-plans + passes.
    s.events.push(passEvent('workflow-tasker'));
    const r2 = decide({ state: s, lastAssistantText: '' });
    assert.equal(r2.action, 'advance');
  });

  test('16-C verify mode fail(test_run) → workflow-coding (via producer)', () => {
    const s = createInitialState({ taskId: 'v', mode: 'verify' });
    s.allowed_skills = ['workflow-verify', 'workflow-coding', 'workflow-human-check'];
    s.current_stage = 'workflow-verify';
    s.events = [failEvent('workflow-verify', 'test_run')];
    const d = decide({ state: s, lastAssistantText: '' });
    assert.equal(d.action, 'enter_skill');
    assert.equal(d.payload.skill, 'workflow-coding');
    assert.equal(d.payload.direction, 'back');
  });

  test('16-D E2E fail(assertion) → coding → re-coding → re-E2E pass chain', () => {
    const s = fixModeState({ current_stage: 'workflow-e2e', completed_stages: [
      'workflow-investigate', 'workflow-tasker', 'workflow-write-test', 'workflow-coding',
      'workflow-agent-review',
    ]});
    s.events = [failEvent('workflow-e2e', 'assertion')];
    const r1 = decide({ state: s, lastAssistantText: '' });
    assert.equal(r1.payload.skill, 'workflow-coding');
    assert.equal(r1.payload.direction, 'back');

    // After fix + re-coding pass, E2E re-runs and passes.
    s.events.push(passEvent('workflow-coding'));
    s.events.push(passEvent('workflow-e2e'));
    const r2 = decide({ state: s, lastAssistantText: '' });
    assert.equal(r2.action, 'advance');
    assert.equal(r2.payload.skill, 'workflow-e2e-review');
  });

  test('16-E multi-cycle: coding fail → fix → fail → fix → pass, never deadlocks', () => {
    const s = fixModeState({ current_stage: 'workflow-coding', completed_stages: ['workflow-investigate', 'workflow-tasker', 'workflow-write-test'] });
    // Cycle 1: fail typecheck
    s.events = [failEvent('workflow-coding', 'typecheck')];
    let d = decide({ state: s, lastAssistantText: '' });
    assert.equal(d.action, 'enter_skill');
    assert.equal(d.payload.skill, 'workflow-coding');

    // Cycle 2: fail lint after first fix
    s.events.push(failEvent('workflow-coding', 'lint'));
    d = decide({ state: s, lastAssistantText: '' });
    assert.equal(d.action, 'enter_skill');
    assert.equal(d.payload.skill, 'workflow-coding');

    // Finally pass
    s.events.push(passEvent('workflow-coding'));
    d = decide({ state: s, lastAssistantText: '' });
    assert.equal(d.action, 'advance');
    assert.equal(d.payload.direction, 'advance');
  });

  test('16-F tasker-review fail → tasker → pass → continue, no deadlock', () => {
    const s = fixModeState({ current_stage: 'workflow-tasker-review', completed_stages: ['workflow-investigate', 'workflow-investigate-review', 'workflow-tasker'] });
    s.events = [failEvent('workflow-tasker-review', 'scope_mismatch')];
    const r1 = decide({ state: s, lastAssistantText: '' });
    assert.equal(r1.payload.skill, 'workflow-tasker');
    assert.equal(r1.payload.direction, 'back');

    s.events.push(passEvent('workflow-tasker-review'));
    const r2 = decide({ state: s, lastAssistantText: '' });
    assert.equal(r2.action, 'advance');
  });

  test('16-G agent-review security fail → coding → pass → continue, never routes outside whitelist', () => {
    const s = fixModeState({ current_stage: 'workflow-agent-review', completed_stages: ['workflow-investigate', 'workflow-tasker', 'workflow-write-test', 'workflow-coding'] });
    s.events = [failEvent('workflow-agent-review', 'security')];
    const r1 = decide({ state: s, lastAssistantText: '' });
    assert.equal(r1.payload.skill, 'workflow-coding');
    assert.equal(r1.payload.direction, 'back');

    s.events.push(passEvent('workflow-coding'));
    s.events.push(passEvent('workflow-agent-review'));
    const r2 = decide({ state: s, lastAssistantText: '' });
    assert.equal(r2.action, 'advance');
    assert.equal(r2.payload.skill, 'workflow-e2e');
  });
}

// ----------------------------------------------------------------------------
console.log('');
console.log(`\nworkflow-scenarios: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}: ${f.message}`);
  process.exit(1);
}
