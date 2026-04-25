#!/usr/bin/env node
/**
 * auto-confirm.test.mjs — Unit tests for the §11 decision tree, chained
 * mode handling, risk detection, and prompt injection shaping.
 *
 * Run: node scripts/auto-confirm.test.mjs
 *
 * Tests are pure function tests (no stdin, no hooks). CLI entry is exercised
 * via a separate fixture at the bottom (spawn + stdin piping).
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

import {
  isEnabled,
  isSubTaskerOnRisk,
  findActiveTaskState,
  detectModeTransitionSignal,
  consumeNextChainedMode,
  buildChainedTransitionPrompt,
  decide,
  detectRiskKeyword,
  pickSubAgentModel,
  buildPromptInjection,
  buildClassifierPrompt,
  classifyProceedPromptViaSubAgent,
  autoConfirmSignature,
  bumpAutoConfirmLoop,
  clearAutoConfirmLoop,
  autoConfirmLoopCounterPath,
  AUTO_CONFIRM_STUCK_THRESHOLD,
  buildStageCompletionPrompt,
  canonicalArtifactPath,
  shouldRunStageCompletionClassifier,
  detectReviewVerdict,
  detectReviewFailCause,
  ACTIVE_STATE_MAX_AGE_MS,
  applyProseCompletionPass,
} from './auto-confirm.mjs';

import { createInitialState, writeState } from './state-schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, 'auto-confirm.mjs');

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

// Build a valid state.json object for a given mode.
function baseState({ mode = 'fix', events = [], active_feedback = [], test_cycles = [], current_stage = null, completed_stages = [], chained_modes = [] } = {}) {
  const s = createInitialState({ taskId: 'test-task', mode, chainedModes: chained_modes });
  s.allowed_skills = [
    'workflow-investigate', 'workflow-investigate-review',
    'workflow-tasker', 'workflow-tasker-review',
    'workflow-write-test', 'workflow-coding',
    'workflow-agent-review', 'workflow-e2e', 'workflow-e2e-review',
    'workflow-team-code-review', 'workflow-human-check',
  ];
  s.current_stage = current_stage;
  s.completed_stages = completed_stages;
  s.events = events;
  s.active_feedback = active_feedback;
  s.test_cycles = test_cycles;
  return s;
}

function passEvent(skill) {
  return { t: new Date().toISOString(), skill, result: 'pass', declarer: 'hook', cause: null, evidence: { type: 'file_present', detail: 'ok' } };
}

function failEvent(skill, cause = 'typecheck') {
  return { t: new Date().toISOString(), skill, result: 'fail', declarer: 'hook', cause, evidence: { type: 'exit_code', detail: 'tsc 2' } };
}

// ----------------------------------------------------------------------------
section('isEnabled / isSubTaskerOnRisk (config gates)');
// ----------------------------------------------------------------------------
// The current user's ~/.smt/config.json may or may not exist. Both gates
// default ON when no config is present.
test('isEnabled defaults true', () => {
  assert.equal(typeof isEnabled(), 'boolean');
});
test('isSubTaskerOnRisk defaults true', () => {
  assert.equal(typeof isSubTaskerOnRisk(), 'boolean');
});

// ----------------------------------------------------------------------------
section('detectModeTransitionSignal (§11 transition gate pattern matcher)');
// ----------------------------------------------------------------------------
test('mode_transition_to_<mode> marker matches', () => {
  assert.equal(detectModeTransitionSignal('ready. mode_transition_to_implement now'), 'implement');
});
test('English "transitioning to X mode" matches', () => {
  assert.equal(detectModeTransitionSignal('transitioning to brainstorm mode'), 'brainstorm');
  assert.equal(detectModeTransitionSignal('transitioning to think mode'), '');
});
test('English "switching to X mode" matches', () => {
  assert.equal(detectModeTransitionSignal('switching to fix mode'), 'fix');
});
test('Korean "X 모드로 전환" matches', () => {
  assert.equal(detectModeTransitionSignal('implement 모드로 전환하겠습니다'), 'implement');
});
test('Generic gate signal returns *', () => {
  assert.equal(detectModeTransitionSignal('mode transition gate reached'), '*');
});
test('Generic Korean 전환 가능 returns *', () => {
  assert.equal(detectModeTransitionSignal('다음 단계로 전환 가능'), '*');
});
test('Unknown mode name returns empty', () => {
  assert.equal(detectModeTransitionSignal('mode_transition_to_nonsense'), '');
});
test('Empty input returns empty', () => {
  assert.equal(detectModeTransitionSignal(''), '');
});
test('Null input returns empty', () => {
  assert.equal(detectModeTransitionSignal(null), '');
});

// ----------------------------------------------------------------------------
section('detectRiskKeyword (Korean + English triggers)');
// ----------------------------------------------------------------------------
test('Korean 리스크 detected', () => {
  assert.equal(detectRiskKeyword('이 부분은 리스크가 남아있다'), true);
});
test('English TODO detected', () => {
  assert.equal(detectRiskKeyword('left a TODO here'), true);
});
test('Korean 고려 필요 detected', () => {
  assert.equal(detectRiskKeyword('나중에 고려 필요'), true);
});
test('Clean message returns false', () => {
  assert.equal(detectRiskKeyword('Implementation complete with all tests passing.'), false);
});
test('Empty string returns false', () => {
  assert.equal(detectRiskKeyword(''), false);
});

// ----------------------------------------------------------------------------
section('buildClassifierPrompt (LLM sub-agent prompt shape)');
// ----------------------------------------------------------------------------
test('prompt embeds the assistant message verbatim', () => {
  const p = buildClassifierPrompt('Shall I proceed?');
  assert.match(p, /Shall I proceed\?/);
});
test('prompt instructs JSON continue/halt output', () => {
  const p = buildClassifierPrompt('hello');
  assert.match(p, /"action":"continue"\|"halt"/);
  assert.match(p, /"reason"/);
});
test('prompt describes explicit proceed-vs-halt contract', () => {
  const p = buildClassifierPrompt('hello');
  assert.match(p, /explicitly asks permission/i);
  assert.match(p, /final answer|completed report|pure summary/i);
});
test('prompt biases toward continue on conditional / question / remaining-work phrasing', () => {
  const p = buildClassifierPrompt('hello');
  assert.match(p, /원하면/);
  assert.match(p, /if you want/i);
  assert.match(p, /만들까요/);
  assert.match(p, /남은 건/);
  assert.match(p, /지금 실행/);
  assert.match(p, /진행할까요/);
  assert.match(p, /proceed now/i);
  assert.match(p, /when in doubt.*continue/i);
});
test('prompt HARD RULE treats single-path next step as continue', () => {
  const p = buildClassifierPrompt('hello');
  assert.match(p, /HARD RULE/);
  assert.match(p, /concrete next step/i);
});
test('prompt BRANCHING-CHOICE RULE forces continue with autopick on A/B options', () => {
  const p = buildClassifierPrompt('hello');
  assert.match(p, /BRANCHING-CHOICE RULE/);
  assert.match(p, /STILL return continue/i);
  assert.match(p, /pick the highest-confidence option/i);
});

// ----------------------------------------------------------------------------
section('classifyProceedPromptViaSubAgent (stub-injected sub-agent)');
// ----------------------------------------------------------------------------
function makeStub(stdout, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'classifier-stub-'));
  const stub = join(dir, 'stub.sh');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s' '${stdout}'\nexit ${exitCode}\n`, { mode: 0o755 });
  return { dir, stub };
}
test('stub returning JSON continue → continue with reason', () => {
  const { dir, stub } = makeStub('{"action":"continue","reason":"asked_permission"}');
  try {
    const v = classifyProceedPromptViaSubAgent('next?', { cmd: stub });
    assert.deepEqual(v, { action: 'continue', reason: 'asked_permission' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('stub returning JSON halt → halt with reason', () => {
  const { dir, stub } = makeStub('{"action":"halt","reason":"final_answer"}');
  try {
    const v = classifyProceedPromptViaSubAgent('done.', { cmd: stub });
    assert.deepEqual(v, { action: 'halt', reason: 'final_answer' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('stub returning garbage → halt with invalid_output', () => {
  const { dir, stub } = makeStub('maybe?');
  try {
    const v = classifyProceedPromptViaSubAgent('?', { cmd: stub });
    assert.deepEqual(v, { action: 'halt', reason: 'invalid_output' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('stub exit non-zero → halt with nonzero_exit', () => {
  const { dir, stub } = makeStub('{"action":"continue","reason":"x"}', 1);
  try {
    const v = classifyProceedPromptViaSubAgent('?', { cmd: stub });
    assert.deepEqual(v, { action: 'halt', reason: 'nonzero_exit' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('empty input → halt without spawning', () => {
  assert.deepEqual(classifyProceedPromptViaSubAgent('', { cmd: '/bin/false' }), { action: 'halt', reason: 'empty_message' });
  assert.deepEqual(classifyProceedPromptViaSubAgent(null, { cmd: '/bin/false' }), { action: 'halt', reason: 'empty_message' });
});
test('missing binary → halt (no fallback)', () => {
  const v = classifyProceedPromptViaSubAgent('proceed?', { cmd: '/nonexistent/path/xyz' });
  assert.equal(v.action, 'halt');
  assert.match(v.reason, /missing_binary|nonzero_exit/);
});
test('stub trimmed whitespace + trailing newline accepted', () => {
  const { dir, stub } = makeStub('{"action":"continue","reason":"trimmed"}');
  try {
    const v = classifyProceedPromptViaSubAgent('?', { cmd: stub });
    assert.deepEqual(v, { action: 'continue', reason: 'trimmed' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------------------
section('pickSubAgentModel (haiku default, codex mini under codex)');
// ----------------------------------------------------------------------------
test('pickSubAgentModel honors codex env signal and falls back to haiku without it', () => {
  const priorCodex = process.env.CODEX_MODE;
  const priorMode = process.env.SMELTER_MODEL_MODE;
  try {
    process.env.CODEX_MODE = '1';
    delete process.env.SMELTER_MODEL_MODE;
    assert.equal(pickSubAgentModel(), 'gpt-5.4-mini');
    delete process.env.CODEX_MODE;
    assert.equal(pickSubAgentModel(), 'haiku');
  } finally {
    if (priorCodex === undefined) delete process.env.CODEX_MODE; else process.env.CODEX_MODE = priorCodex;
    if (priorMode === undefined) delete process.env.SMELTER_MODEL_MODE; else process.env.SMELTER_MODEL_MODE = priorMode;
  }
});
test('CODEX_MODE=1 env returns gpt-5.4-mini', () => {
  process.env.CODEX_MODE = '1';
  try {
    assert.equal(pickSubAgentModel(), 'gpt-5.4-mini');
  } finally {
    delete process.env.CODEX_MODE;
  }
});

test('SMELTER_MODEL_MODE=codex env returns gpt-5.4-mini', () => {
  process.env.SMELTER_MODEL_MODE = 'codex';
  try {
    assert.equal(pickSubAgentModel(), 'gpt-5.4-mini');
  } finally {
    delete process.env.SMELTER_MODEL_MODE;
  }
});

// ----------------------------------------------------------------------------
section('consumeNextChainedMode (state persistence + chain advance)');
// ----------------------------------------------------------------------------
function withTempState(initial, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  const path = join(dir, 'task.state.json');
  writeState(path, initial);
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8'));
    return fn(path, state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('empty chained_modes returns empty string', () => {
  const s = baseState();
  s.chained_modes = [];
  assert.equal(consumeNextChainedMode('/tmp/nope', s), '');
});
test('single-element chain returns empty string', () => {
  const s = baseState();
  s.chained_modes = ['fix'];
  assert.equal(consumeNextChainedMode('/tmp/nope', s), '');
});
test('two-element chain advances to next mode', () => {
  withTempState(baseState({ mode: 'explore', chained_modes: ['explore', 'fix'] }), (path, state) => {
    const next = consumeNextChainedMode(path, state);
    assert.equal(next, 'fix');
    assert.equal(state.mode, 'fix');
    assert.deepEqual(state.chained_modes, ['fix']);
    // Persisted: reload and check
    const reloaded = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(reloaded.mode, 'fix');
  });
});
test('requestedMode "*" takes the immediate next in chain', () => {
  withTempState(baseState({ mode: 'brainstorm', chained_modes: ['brainstorm', 'implement'] }), (path, state) => {
    const next = consumeNextChainedMode(path, state, '*');
    assert.equal(next, 'implement');
  });
});
test('requestedMode matching later entry skips head', () => {
  withTempState(baseState({ mode: 'explore', chained_modes: ['explore', 'brainstorm', 'implement'] }), (path, state) => {
    const next = consumeNextChainedMode(path, state, 'implement');
    assert.equal(next, 'implement');
    assert.deepEqual(state.chained_modes, ['implement']);
  });
});
test('requestedMode not in remaining chain returns empty', () => {
  withTempState(baseState({ mode: 'fix', chained_modes: ['fix', 'implement'] }), (path, state) => {
    const next = consumeNextChainedMode(path, state, 'brainstorm');
    assert.equal(next, '');
  });
});

// ----------------------------------------------------------------------------
section('decide() — decision tree coverage (§11-2, §11-4)');
// ----------------------------------------------------------------------------
test('no state → no_state action', () => {
  const d = decide({ state: null, lastAssistantText: '' });
  assert.equal(d.action, 'no_state');
});
test('workflow-human-check awaiting → halt', () => {
  const s = baseState({ current_stage: 'workflow-human-check', events: [failEvent('workflow-team-code-review', 'review_reject')] });
  const d = decide({ state: s, lastAssistantText: 'awaiting your decision' });
  assert.equal(d.action, 'halt');
});
test('workflow-human-check with pass event → session_wrap (terminal approval)', () => {
  // When a workflow-human-check pass event is recorded, the user has approved.
  // Fix B short-circuits this to session_wrap rather than falling through to
  // the generic `last.result === 'pass'` advance branch, which would otherwise
  // pick the next uncompleted skill and re-enter the chain after a terminal
  // approval.
  const s = baseState({ current_stage: 'workflow-human-check', events: [passEvent('workflow-human-check')] });
  const d = decide({ state: s, lastAssistantText: '' });
  assert.equal(d.action, 'session_wrap');
});
test('v0.4 controller: human-check pass advances step to DONE', () => {
  const s = baseState({ current_stage: 'workflow-human-check', events: [passEvent('workflow-human-check')] });
  s.task_type = 'write';
  s.step = 'HUMAN_CHECK';
  s.step_flow = ['INTENT', 'DISCOVERY', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE'];
  const d = decide({ state: s, lastAssistantText: '' });
  assert.equal(d.action, 'session_wrap');
  assert.equal(s.step, 'DONE');
  assert.deepEqual(s.allowed_actions, ['read', 'git_commit']);
});
test('workflow-human-check with prior-skill pass event → halt (Fix B)', () => {
  // Regression guard for the loop described in investigation.md:
  // current_stage='workflow-human-check' with a last event that PASSED but is
  // for a *prior* skill must NOT be treated as human-check approval.
  const s = baseState({
    current_stage: 'workflow-human-check',
    completed_stages: ['workflow-investigate', 'workflow-investigate-review', 'workflow-tasker', 'workflow-tasker-review'],
    events: [
      passEvent('workflow-investigate'),
      passEvent('workflow-investigate-review'),
      passEvent('workflow-tasker'),
      passEvent('workflow-tasker-review'),
    ],
  });
  const d = decide({ state: s, lastAssistantText: '' });
  assert.equal(d.action, 'halt');
  assert.equal(/awaiting user decision in workflow-human-check/.test(d.reason), true);
});
test('workflow-human-check with legacy completed_stages → session_wrap (Fix B fallback)', () => {
  // Legacy state where workflow-human-check is in completed_stages without a
  // matching pass event (pre-Fix B migration). Must route to session_wrap via
  // the same terminal-approval short-circuit as a fresh pass event.
  const s = baseState({
    current_stage: 'workflow-human-check',
    completed_stages: ['workflow-human-check'],
    events: [],
  });
  const d = decide({ state: s, lastAssistantText: '' });
  assert.equal(d.action, 'session_wrap');
});
test('workflow-human-check with empty events → halt (Fix B defensive)', () => {
  // Empty events + no legacy completed marker → halt.
  const s = baseState({ current_stage: 'workflow-human-check', events: [], completed_stages: [] });
  const d = decide({ state: s, lastAssistantText: '' });
  assert.equal(d.action, 'halt');
});
test('_awaiting_mode_upgrade flag → halt', () => {
  const s = baseState();
  s._awaiting_mode_upgrade = true;
  const d = decide({ state: s, lastAssistantText: '' });
  assert.equal(d.action, 'halt');
});
test('workflow-human-check completed → session_wrap (canonical terminal shape)', () => {
  // The canonical terminal shape after finalize-human-check.mjs runs is:
  // current_stage stays at 'workflow-human-check' AND completed_stages
  // includes 'workflow-human-check' AND events[] has a workflow-human-check
  // pass event. decide() already short-circuits this above via the explicit
  // workflow-human-check branch (see auto-confirm.mjs §workflow-human-check
  // terminal approval).
  const s = baseState({
    current_stage: 'workflow-human-check',
    completed_stages: ['workflow-human-check'],
    events: [{ t: new Date().toISOString(), skill: 'workflow-human-check', result: 'pass', declarer: 'hook' }],
  });
  const d = decide({ state: s, lastAssistantText: '' });
  assert.equal(d.action, 'session_wrap');
});
test('risk keyword in message → spawn_sub_tasker', () => {
  const s = baseState({ current_stage: 'workflow-coding' });
  const d = decide({ state: s, lastAssistantText: '완료했지만 리스크가 남아있음' });
  assert.equal(d.action, 'spawn_sub_tasker');
  assert.equal(d.payload.text.includes('리스크'), true);
});
test('English TODO risk → spawn_sub_tasker', () => {
  const s = baseState({ current_stage: 'workflow-coding' });
  const d = decide({ state: s, lastAssistantText: 'left TODO to finish later' });
  assert.equal(d.action, 'spawn_sub_tasker');
});

// ------------------------------------------------------------------------
// Shape-gate tests (interactive-question suppression of spawn_sub_tasker)
// ------------------------------------------------------------------------
test('shape-gate: risk keyword + multi_choice shape → NOT spawn_sub_tasker', () => {
  const s = baseState({ current_stage: 'workflow-brainstorm' });
  const d = decide({
    state: s,
    lastAssistantText: [
      '어느 쪽을 택하시겠습니까?',
      '- (A) 위험이 남는 단순안',
      '- (B) 투명 감사 (권장)',
    ].join('\n'),
    questionShape: 'multi_choice',
  });
  assert.notEqual(d.action, 'spawn_sub_tasker',
    'interactive multi-choice must not trigger spawn_sub_tasker even with 위험');
});

test('shape-gate: risk keyword + yes_no shape → NOT spawn_sub_tasker', () => {
  const s = baseState({ current_stage: 'workflow-investigate' });
  const d = decide({
    state: s,
    lastAssistantText: 'Include risky path? (y/n)',
    questionShape: 'yes_no',
  });
  assert.notEqual(d.action, 'spawn_sub_tasker');
});

test('shape-gate: risk keyword + open_question shape → NOT spawn_sub_tasker', () => {
  const s = baseState({ current_stage: 'workflow-brainstorm' });
  const d = decide({
    state: s,
    lastAssistantText: [
      'Which approach do you prefer?',
      '- first (has TODO)',
      '- second',
    ].join('\n'),
    questionShape: 'open_question',
  });
  assert.notEqual(d.action, 'spawn_sub_tasker');
});

test('shape-gate: risk keyword with shape=none (rhetorical prose) → STILL spawn_sub_tasker', () => {
  // Regression guard: don't over-correct. When the message is not actually
  // a user-directed question, risk-keyword detection must still fire.
  const s = baseState({ current_stage: 'workflow-coding' });
  const d = decide({
    state: s,
    lastAssistantText: 'left TODO in this module',
    questionShape: 'none',
  });
  assert.equal(d.action, 'spawn_sub_tasker');
});

test('shape-gate: questionShape omitted (legacy caller) → behavior unchanged', () => {
  const s = baseState({ current_stage: 'workflow-coding' });
  const d = decide({
    state: s,
    lastAssistantText: 'left TODO in this module',
    // No questionShape — emulates legacy callers before the shape gate.
  });
  assert.equal(d.action, 'spawn_sub_tasker');
});

test('shape-gate: no risk keyword + multi_choice shape → unchanged flow', () => {
  const s = baseState({ current_stage: 'workflow-brainstorm' });
  const d = decide({
    state: s,
    lastAssistantText: [
      'Pick one:',
      '- (A) first',
      '- (B) second',
    ].join('\n'),
    questionShape: 'multi_choice',
  });
  // No risk keyword, no pass/fail event, no stage classifier — should fall
  // through to classify_needed, matching legacy behavior.
  assert.equal(d.action, 'classify_needed');
});

test('shape-gate: workflow-human-check halt must NOT be short-circuited by shape-gate', () => {
  // Safety test: shape-gate must be inserted AFTER the workflow-human-check
  // halt condition. A human-check pause with a bulleted question must
  // still return action: 'halt', not be rerouted.
  const s = baseState({ current_stage: 'workflow-human-check' });
  s.events = []; // no pass event yet → halt condition matches
  const d = decide({
    state: s,
    lastAssistantText: [
      'Approve?',
      '- (A) yes',
      '- (B) no',
    ].join('\n'),
    questionShape: 'multi_choice',
  });
  assert.equal(d.action, 'halt',
    'human-check halt must remain halt even when lastMessage looks like a multi_choice');
});
test('unresolved active_feedback → enter_skill', () => {
  const s = baseState({
    current_stage: 'workflow-coding',
    active_feedback: [{
      id: 'fb-1',
      from: 'workflow-human-check@now',
      target_skill: 'workflow-coding',
      text: 'refactor required',
      evidence_ref: 'events[0]',
      resolved: false,
    }],
  });
  const d = decide({ state: s, lastAssistantText: 'clean summary' });
  assert.equal(d.action, 'enter_skill');
  assert.equal(d.payload.skill, 'workflow-coding');
  assert.equal(d.payload.feedback_id, 'fb-1');
});
test('resolved active_feedback is ignored', () => {
  const s = baseState({
    current_stage: 'workflow-coding',
    events: [passEvent('workflow-coding')],
    active_feedback: [{ id: 'fb-1', target_skill: 'workflow-coding', resolved: true, text: 'x', from: 'x', evidence_ref: 'x' }],
  });
  const d = decide({ state: s, lastAssistantText: '' });
  // With last event pass, expect advance
  assert.equal(d.action, 'advance');
});
test('last event fail routes via producer chain → enter_skill', () => {
  const s = baseState({
    current_stage: 'workflow-coding',
    events: [failEvent('workflow-coding', 'typecheck')],
  });
  const d = decide({ state: s, lastAssistantText: 'clean' });
  assert.equal(d.action, 'enter_skill');
  // Producer chain for workflow-coding typecheck goes back to workflow-coding itself
  assert.equal(d.payload.skill, 'workflow-coding');
});
test('v0.4 controller: verification fail advances step to RECOVER before producer routing', () => {
  const s = baseState({
    current_stage: 'workflow-e2e',
    events: [failEvent('workflow-e2e', 'assertion')],
  });
  s.task_type = 'write';
  s.step = 'VERIFY';
  s.step_flow = ['INTENT', 'DISCOVERY', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE'];
  const d = decide({ state: s, lastAssistantText: 'clean' });
  assert.equal(d.action, 'enter_skill');
  assert.equal(d.payload.skill, 'workflow-coding');
  assert.equal(s.step, 'RECOVER');
  assert.deepEqual(s.allowed_actions, ['read', 'write_artifact']);
});
test('last event pass → advance', () => {
  const s = baseState({
    current_stage: 'workflow-write-test',
    events: [passEvent('workflow-write-test')],
  });
  const d = decide({ state: s, lastAssistantText: 'clean' });
  assert.equal(d.action, 'advance');
});
test('v0.4 controller: stage pass advances bridged step along flow', () => {
  const s = baseState({
    current_stage: 'workflow-write-test',
    events: [passEvent('workflow-write-test')],
  });
  s.task_type = 'write';
  s.step = 'TEST_DESIGN';
  s.step_flow = ['INTENT', 'DISCOVERY', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE'];
  const d = decide({ state: s, lastAssistantText: 'clean' });
  assert.equal(d.action, 'advance');
  assert.equal(s.step, 'EXECUTE');
  assert.deepEqual(s.allowed_actions, ['read', 'write_source', 'run_test']);
});
test('H2: advance payload names the next skill via pickNextStage', () => {
  const s = baseState({
    current_stage: 'workflow-write-test',
    events: [passEvent('workflow-write-test')],
  });
  const d = decide({ state: s, lastAssistantText: 'clean' });
  assert.equal(d.action, 'advance');
  // workflow-write-test → workflow-coding is the canonical next stage in fix mode.
  assert.equal(d.payload.skill, 'workflow-coding');
});
test('H2: advance from workflow-investigate → workflow-investigate-review', () => {
  const s = baseState({
    current_stage: 'workflow-investigate',
    events: [passEvent('workflow-investigate')],
  });
  const d = decide({ state: s, lastAssistantText: 'clean' });
  assert.equal(d.action, 'advance');
  assert.equal(d.payload.skill, 'workflow-investigate-review');
});

test('investigate-review pass halts for user mode decision in explore mode', () => {
  const s = baseState({
    mode: 'explore',
    allowed_skills: ['workflow-investigate', 'workflow-investigate-review'],
    current_stage: 'workflow-investigate-review',
    completed_stages: ['workflow-investigate'],
    events: [passEvent('workflow-investigate-review')],
  });
  const d = decide({ state: s, lastAssistantText: 'mode_transition gate' });
  assert.equal(d.action, 'halt');
  assert.match(d.reason, /explore mode user decision/);
});
test('H2: advance at terminal stage falls back to workflow-human-check', () => {
  // No explicit next after workflow-team-code-review except human-check.
  const s = baseState({
    current_stage: 'workflow-team-code-review',
    events: [passEvent('workflow-team-code-review')],
    completed_stages: [
      'workflow-investigate', 'workflow-investigate-review',
      'workflow-tasker', 'workflow-tasker-review',
      'workflow-write-test', 'workflow-coding',
      'workflow-agent-review', 'workflow-e2e', 'workflow-e2e-review',
    ],
  });
  const d = decide({ state: s, lastAssistantText: 'clean' });
  assert.equal(d.action, 'advance');
  assert.equal(d.payload.skill, 'workflow-human-check');
});
test('test_cycles RED without coding entry → enter_skill workflow-coding', () => {
  const s = baseState({
    current_stage: 'workflow-write-test',
    events: [],
    test_cycles: [{
      t: new Date().toISOString(),
      file: 'src/x.test.ts',
      action: 'added_case',
      case_name: 'new',
      run_result: 'fail',
      error: 'expected',
    }],
  });
  const d = decide({ state: s, lastAssistantText: '' });
  assert.equal(d.action, 'enter_skill');
  assert.equal(d.payload.skill, 'workflow-coding');
});
test('no signal → classify_needed (delegates to LLM sub-agent)', () => {
  const s = baseState({ current_stage: 'workflow-tasker', events: [] });
  const d = decide({ state: s, lastAssistantText: 'Implementation complete.' });
  assert.equal(d.action, 'classify_needed');
  assert.equal(d.payload.lastMessage, 'Implementation complete.');
});
test('no signal + empty message → classify_needed with empty payload', () => {
  const s = baseState({ current_stage: 'workflow-tasker', events: [] });
  const d = decide({ state: s, lastAssistantText: '' });
  assert.equal(d.action, 'classify_needed');
  assert.equal(d.payload.lastMessage, '');
});

// ----------------------------------------------------------------------------
section('decide() — chained intent auto-transition (§4-3 gate + §11 integration)');
// ----------------------------------------------------------------------------
test('chained_modes + transition signal → chain_advance', () => {
  withTempState(baseState({ mode: 'explore', chained_modes: ['explore', 'fix'], current_stage: 'workflow-investigate-review', events: [passEvent('workflow-investigate-review')] }), (path, state) => {
    const d = decide({
      state,
      lastAssistantText: 'transitioning to fix mode',
      statePath: path,
    });
    assert.equal(d.action, 'chain_advance');
    assert.equal(d.payload.nextMode, 'fix');
  });
});
test('chain_advance fires BEFORE halt — compound intents bypass human-check wait', () => {
  withTempState(baseState({ mode: 'brainstorm', chained_modes: ['brainstorm', 'implement'], current_stage: 'workflow-human-check' }), (path, state) => {
    const d = decide({
      state,
      lastAssistantText: 'transitioning to implement mode',
      statePath: path,
    });
    assert.equal(d.action, 'chain_advance');
  });
});
test('transition signal without chain → no chain_advance', () => {
  const s = baseState({ mode: 'fix', chained_modes: [], current_stage: 'workflow-coding', events: [passEvent('workflow-coding')] });
  const d = decide({ state: s, lastAssistantText: 'transitioning to fix mode' });
  assert.notEqual(d.action, 'chain_advance');
});
test('missing statePath disables chain_advance (safe default)', () => {
  const s = baseState({ mode: 'brainstorm', chained_modes: ['brainstorm', 'implement'], events: [] });
  const d = decide({ state: s, lastAssistantText: 'transitioning to implement mode' });
  assert.notEqual(d.action, 'chain_advance');
});

// ----------------------------------------------------------------------------
section('buildPromptInjection — prompt shape per action');
// ----------------------------------------------------------------------------
test('enter_skill injection names the skill', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
  const text = buildPromptInjection({ action: 'enter_skill', reason: 'r', payload: { skill: 'workflow-coding' } }, s);
  assert.match(text, /workflow-coding/);
});
test('advance injection includes state summary', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-agent-review' });
  const text = buildPromptInjection({ action: 'advance', reason: 'r', payload: {} }, s);
  assert.match(text, /mode=fix/);
});
test('H2: advance injection names the skill when payload.skill is set', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-write-test' });
  const text = buildPromptInjection({ action: 'advance', reason: 'r', payload: { skill: 'workflow-coding' } }, s);
  assert.match(text, /workflow-coding/);
});
test('chain_advance includes target + remaining chain tail', () => {
  const s = baseState({ mode: 'brainstorm' });
  const text = buildPromptInjection({ action: 'chain_advance', reason: 'r', payload: { nextMode: 'implement', remaining: ['brainstorm', 'implement', 'fix'] } }, s);
  assert.match(text, /implement/);
  assert.match(text, /remaining chain/);
});
test('halt returns null (no injection emitted)', () => {
  const s = baseState();
  const text = buildPromptInjection({ action: 'halt', reason: 'r' }, s);
  assert.equal(text, null);
});
test('no_state returns null', () => {
  const text = buildPromptInjection({ action: 'no_state', reason: 'r' }, null);
  assert.equal(text, null);
});
test('spawn_sub_tasker prompt mentions sub-tasker', () => {
  const s = baseState();
  const text = buildPromptInjection({ action: 'spawn_sub_tasker', reason: 'r', payload: { text: '리스크' } }, s);
  assert.match(text, /sub-tasker/i);
});
test('continue action embeds sub-agent model hint (default sonnet)', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
  const text = buildPromptInjection({ action: 'continue', reason: 'asked permission' }, s);
  assert.match(text, /sub-agent/i);
  assert.match(text, /sonnet/);
});
test('continue action with codex sub-agent model emits haiku hint', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
  const text = buildPromptInjection({ action: 'continue', reason: 'asked permission' }, s, { subAgentModel: 'haiku' });
  assert.match(text, /haiku/);
});
test('continue with multi_choice questionShape appends NO-CHOICE autopick directive', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
  const text = buildPromptInjection(
    { action: 'continue', reason: 'asked permission' },
    s,
    { subAgentModel: 'sonnet', questionShape: 'multi_choice' },
  );
  assert.match(text, /\[NO-CHOICE POLICY\]/);
  assert.match(text, /Pick the single highest-confidence option/i);
  assert.match(text, /execute it via tools immediately/i);
});
test('continue with yes_no questionShape appends NO-CHOICE directive', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
  const text = buildPromptInjection(
    { action: 'continue', reason: 'asked permission' },
    s,
    { subAgentModel: 'sonnet', questionShape: 'yes_no' },
  );
  assert.match(text, /\[NO-CHOICE POLICY\]/);
});
test('continue with shape=none does NOT append NO-CHOICE directive (no false positive)', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
  const text = buildPromptInjection(
    { action: 'continue', reason: 'asked permission' },
    s,
    { subAgentModel: 'sonnet', questionShape: 'none' },
  );
  assert.doesNotMatch(text, /\[NO-CHOICE POLICY\]/);
});
test('enter_skill / advance / chain_advance do NOT append NO-CHOICE directive (continue-only)', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
  const enter = buildPromptInjection(
    { action: 'enter_skill', reason: 'r', payload: { skill: 'workflow-coding' } },
    s,
    { questionShape: 'multi_choice' },
  );
  assert.doesNotMatch(enter, /\[NO-CHOICE POLICY\]/);
});
test('enter_skill action embeds sub-agent model hint', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
  const text = buildPromptInjection({ action: 'enter_skill', reason: 'r', payload: { skill: 'workflow-coding' } }, s, { subAgentModel: 'sonnet' });
  assert.match(text, /sonnet/);
});
test('MANDATORY: advance with payload.skill emits MANDATORY WORKFLOW STEP + Skill invocation', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-write-test' });
  const text = buildPromptInjection(
    { action: 'advance', reason: 'r', payload: { skill: 'workflow-coding', direction: 'advance' } },
    s,
    { subAgentModel: 'sonnet', lastAssistantText: 'I finished writing tests for the new feature.' },
  );
  assert.match(text, /\[MANDATORY WORKFLOW STEP\]/);
  assert.match(text, /Skill\(skill: 'workflow-coding'\)/);
  assert.match(text, /direction=advance/);
  assert.match(text, /Your last message \(truncated\)/);
  assert.match(text, /I finished writing tests/);
});

test('MANDATORY: enter_skill with producer-chain direction=back emits "go BACK to"', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
  const text = buildPromptInjection(
    { action: 'enter_skill', reason: 'r', payload: { skill: 'workflow-tasker', direction: 'back' } },
    s,
    { subAgentModel: 'haiku' },
  );
  assert.match(text, /\[MANDATORY WORKFLOW STEP\]/);
  assert.match(text, /go BACK to workflow-tasker/);
  assert.match(text, /direction=back/);
  assert.match(text, /haiku/);
});

test('MANDATORY: injection truncates lastAssistantText to 400 chars', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
  const long = 'a'.repeat(1000);
  const text = buildPromptInjection(
    { action: 'advance', reason: 'r', payload: { skill: 'workflow-agent-review', direction: 'advance' } },
    s,
    { subAgentModel: 'sonnet', lastAssistantText: long },
  );
  const quoted = text.match(/"""\n([\s\S]*?)\n"""/);
  assert.ok(quoted, 'must include triple-quoted section');
  assert.ok(quoted[1].length <= 400, `truncation must be <=400, got ${quoted[1].length}`);
});

test('MANDATORY: injection does not replay stale coding-stage alignment prose', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-tasker' });
  const stale = 'The stage tracker wasn’t advanced even though the coding skill is active, so I’m updating the Smelter state to the coding stage and then continuing the scoped fix. The coding stage is now aligned, and I’m resuming the planned source edits.';
  const text = buildPromptInjection(
    { action: 'advance', reason: 'r', payload: { skill: 'workflow-coding', direction: 'advance' } },
    s,
    { subAgentModel: 'sonnet', lastAssistantText: stale },
  );
  assert.doesNotMatch(text, /Your last message \(truncated\)/);
  assert.doesNotMatch(text, /resuming the planned source edits/i);
  assert.match(text, /Skill\(skill: 'workflow-coding'\)/);
});

// ----------------------------------------------------------------------------
section('Phase 4 — transcript_path fallback for lastAssistantText');

test('CLI reads transcript_path when last_assistant_text is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-tp-'));
  try {
    // Seed active state with classifier stub that says "continue".
    const slug = 'feat';
    const stateDir = join(dir, '.smt', 'features', slug, 'task');
    mkdirSync(stateDir, { recursive: true });
    const state = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
    writeFileSync(join(stateDir, `${slug}.state.json`), JSON.stringify(state));
    mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
    const sessionId = '11111111-1111-1111-1111-111111111111';
    writeFileSync(join(dir, '.smt', 'state', `active-feature-${sessionId}.json`), JSON.stringify({ slug }));

    // Write a JSONL transcript with an assistant message.
    const tp = join(dir, 'transcript.jsonl');
    writeFileSync(tp, [
      JSON.stringify({ role: 'user', content: 'go' }),
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: '진행할까요?' }] }),
    ].join('\n') + '\n');

    // Stub classifier that returns JSON continue.
    const stub = join(dir, 'claude-stub.sh');
    writeFileSync(stub, `#!/bin/sh\nprintf '%s' '{"action":"continue","reason":"asked_permission"}'\n`, { mode: 0o755 });

    const payload = JSON.stringify({
      cwd: dir,
      session_id: sessionId,
      transcript_path: tp,
      // last_assistant_text intentionally omitted
    });
    const r = spawnSync(process.execPath, [HOOK], {
      input: payload,
      encoding: 'utf-8',
      env: {
        ...process.env,
        SMT_CLASSIFIER_CMD: stub,
        HOME: dir,
      },
    });
    // Without transcript fallback the classifier input would be empty and
    // auto-confirm would halt. With fallback, the transcript's "진행할까요?"
    // reaches the classifier, which returns continue → exit 2 (block + queue).
    assert.equal(r.status, 2, `expected exit 2 (block+queue), got ${r.status}. stderr=${r.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------------------
section('Phase 2 — stage completion classifier');

test('buildStageCompletionPrompt includes mode, stage, message', () => {
  const p = buildStageCompletionPrompt({
    lastMessage: 'I have found three root causes and documented evidence.',
    currentStage: 'workflow-investigate',
    mode: 'explore',
  });
  assert.match(p, /workflow-investigate/);
  assert.match(p, /mode:\s*explore/i);
  assert.match(p, /I have found three root causes/);
  assert.match(p, /verdict/);
});

test('canonicalArtifactPath maps workflow-investigate → investigation.md', () => {
  const r = canonicalArtifactPath('/some/dir/task/feat.state.json', 'workflow-investigate');
  assert.ok(r);
  assert.equal(r.basename, 'investigation.md');
  assert.ok(r.absPath.endsWith('/investigation.md'));
});

test('canonicalArtifactPath returns null for stages without canonical artifact', () => {
  assert.equal(canonicalArtifactPath('/x/task/f.state.json', 'workflow-coding'), null);
  assert.equal(canonicalArtifactPath('/x/task/f.state.json', 'workflow-human-check'), null);
});

test('shouldRunStageCompletionClassifier gates correctly', () => {
  assert.equal(shouldRunStageCompletionClassifier(null, 'hi'), false, 'null state');
  const s = baseState({ mode: 'fix', current_stage: 'workflow-investigate' });
  assert.equal(shouldRunStageCompletionClassifier(s, ''), false, 'empty text');
  assert.equal(shouldRunStageCompletionClassifier(s, 'x'), false, 'too-short text');
  assert.equal(shouldRunStageCompletionClassifier(s, 'a'.repeat(50)), true, 'runs when long text + stage');
  s.events = [passEvent('workflow-investigate')];
  assert.equal(shouldRunStageCompletionClassifier(s, 'a'.repeat(50)), false, 'skips when current stage already passed');
});

test('decide(): stage_complete when classifier returns complete', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-investigate' });
  const stub = () => ({ verdict: 'complete', summary: 'three root causes' });
  const d = decide({
    state: s,
    lastAssistantText: 'I investigated and found three root causes with file evidence.',
    statePath: '/tmp/fake/task/f.state.json',
    stageClassifier: stub,
  });
  assert.equal(d.action, 'stage_complete');
  assert.equal(d.payload.stage, 'workflow-investigate');
  assert.equal(d.payload.nextSkill, 'workflow-investigate-review');
  assert.ok(d.payload.artifact, 'artifact path must be included for investigate');
  assert.equal(d.payload.artifact.basename, 'investigation.md');
});

test('decide(): stage_incomplete when classifier returns incomplete', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-investigate' });
  const stub = () => ({ verdict: 'incomplete', summary: 'no evidence collected yet' });
  const d = decide({
    state: s,
    lastAssistantText: 'I will start investigating shortly, stand by for results.',
    statePath: '/tmp/fake/task/f.state.json',
    stageClassifier: stub,
  });
  assert.equal(d.action, 'stage_incomplete');
  assert.equal(d.payload.stage, 'workflow-investigate');
  assert.match(d.payload.summary, /no evidence/);
});

test('decide(): unknown verdict falls back to classify_needed', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-investigate' });
  const stub = () => ({ verdict: 'unknown', summary: '' });
  const d = decide({
    state: s,
    lastAssistantText: 'I investigated something long enough to trigger the gate.',
    statePath: '/tmp/fake/task/f.state.json',
    stageClassifier: stub,
  });
  assert.equal(d.action, 'classify_needed');
});

test('buildPromptInjection stage_complete includes MANDATORY + next skill', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-investigate' });
  const text = buildPromptInjection(
    {
      action: 'stage_complete',
      reason: 'r',
      payload: {
        stage: 'workflow-investigate',
        nextSkill: 'workflow-investigate-review',
        summary: 'three root causes',
        artifact: { basename: 'investigation.md', absPath: '/x/investigation.md' },
        lastMessage: 'details',
      },
    },
    s,
  );
  assert.match(text, /\[MANDATORY WORKFLOW STEP\]/);
  assert.match(text, /verdict: complete/);
  assert.match(text, /Skill\(skill: 'workflow-investigate-review'\)/);
  assert.match(text, /investigation\.md/);
});

test('buildPromptInjection stage_incomplete re-invokes current stage', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-investigate' });
  const text = buildPromptInjection(
    {
      action: 'stage_incomplete',
      reason: 'r',
      payload: { stage: 'workflow-investigate', summary: 'no evidence yet' },
    },
    s,
  );
  assert.match(text, /INCOMPLETE/);
  assert.match(text, /Skill\(skill: 'workflow-investigate'\)/);
  assert.match(text, /no evidence yet/);
});

// ----------------------------------------------------------------------------
test('buildChainedTransitionPrompt handles single remaining mode', () => {
  const text = buildChainedTransitionPrompt('fix', ['fix']);
  assert.match(text, /Chained intent/);
  assert.match(text, /fix/);
  assert.doesNotMatch(text, /remaining chain/);
});

// ----------------------------------------------------------------------------
section('findActiveTaskState (active-task resolution)');
// ----------------------------------------------------------------------------
test('returns null when .smt absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    assert.equal(findActiveTaskState(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('non-scoped active-feature.json pointer used when sessionId absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const featDir = join(dir, '.smt', 'features', 'a', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'a.state.json');
    writeFileSync(statePath, '{}');
    const stateRoot = join(dir, '.smt', 'state');
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(
      join(stateRoot, 'active-feature.json'),
      JSON.stringify({ slug: 'a', updated_at: Date.now() }),
    );
    assert.equal(findActiveTaskState(dir), statePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('per-session pointer resolves independently of non-scoped pointer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    // Non-scoped pointer → feature A
    const featADir = join(dir, '.smt', 'features', 'feat-a', 'task');
    mkdirSync(featADir, { recursive: true });
    const statePathA = join(featADir, 'feat-a.state.json');
    writeFileSync(statePathA, '{}');
    const stateRoot = join(dir, '.smt', 'state');
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(
      join(stateRoot, 'active-feature.json'),
      JSON.stringify({ slug: 'feat-a', updated_at: Date.now() }),
    );

    // Per-session pointer → feature B (this session's actual work)
    const featBDir = join(dir, '.smt', 'features', 'feat-b', 'task');
    mkdirSync(featBDir, { recursive: true });
    const statePathB = join(featBDir, 'feat-b.state.json');
    writeFileSync(statePathB, '{}');
    const sessionId = 'sess-iso';
    writeFileSync(
      join(stateRoot, `active-feature-${sessionId}.json`),
      JSON.stringify({ slug: 'feat-b', session_id: sessionId, updated_at: Date.now() }),
    );

    assert.equal(
      findActiveTaskState(dir, sessionId),
      statePathB,
      'per-session pointer drives the current session — concurrent session safety',
    );
    // Without sessionId, falls back to the non-scoped pointer
    assert.equal(findActiveTaskState(dir), statePathA);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('fallback picks most-recently-modified state.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const aPath = join(dir, '.smt', 'features', 'a', 'task');
    const bPath = join(dir, '.smt', 'features', 'b', 'task');
    mkdirSync(aPath, { recursive: true });
    mkdirSync(bPath, { recursive: true });
    const aStat = join(aPath, 'x.state.json');
    const bStat = join(bPath, 'y.state.json');
    writeFileSync(aStat, '{}');
    writeFileSync(bStat, '{}');
    // Force b to be newer.
    const past = new Date(Date.now() - 60_000);
    utimesSync(aStat, past, past);
    assert.equal(findActiveTaskState(dir), bStat);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('sessionId present + no per-session pointer MUST NOT use mtime fallback (cross-session bleed guard)', () => {
  // Regression: when a new session has no per-session pointer, the
  // mtime-based fallback would bleed another session's state into this one,
  // causing the Stop hook's classifier to issue "advance to X" forever based
  // on unrelated work. With strict session isolation, absent pointer → null.
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    // Stale state from a prior session
    const staleDir = join(dir, '.smt', 'features', 'feat-stale', 'task');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'feat-stale.state.json'), '{}');
    // Non-scoped pointer (legacy) also present — must NOT be consulted.
    const stateRoot = join(dir, '.smt', 'state');
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(
      join(stateRoot, 'active-feature.json'),
      JSON.stringify({ slug: 'feat-stale', session_id: 'prior-sess' }),
    );

    const sessionId = 'sess-new-no-pointer';
    assert.equal(
      findActiveTaskState(dir, sessionId),
      null,
      'sessionId provided but no session pointer → must return null (no fallback)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
section('H3: stuck-loop guard (signature counter + threshold escape)');
// ----------------------------------------------------------------------------
test('H3: threshold constant is 2', () => {
  assert.equal(AUTO_CONFIRM_STUCK_THRESHOLD, 2);
});
test('H3: autoConfirmSignature composes slug/mode/stage/completedCount', () => {
  // Post-fold (Fix #3): signature is now completedCount-based, not action-based.
  // Matches the folded stop-stage-enforcer semantics and resets precisely
  // when state advances forward.
  const s = baseState({ mode: 'fix', current_stage: 'workflow-investigate' });
  s.task_id = 'feat-x';
  const sig = autoConfirmSignature(s, 'enter_skill');
  assert.equal(sig, 'feat-x:fix:workflow-investigate:0');
});
test('H3: autoConfirmSignature with null state returns no-state:0', () => {
  // Post-fold: null state → 'no-state:0' (completedCount defaults to 0).
  assert.equal(autoConfirmSignature(null, null), 'no-state:0');
});
test('H3: bumpAutoConfirmLoop returns 1 on first call, increments after', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h3-'));
  try {
    const c1 = bumpAutoConfirmLoop(dir, 'sess-1', 'sig-a');
    const c2 = bumpAutoConfirmLoop(dir, 'sess-1', 'sig-a');
    const c3 = bumpAutoConfirmLoop(dir, 'sess-1', 'sig-a');
    assert.equal(c1, 1);
    assert.equal(c2, 2);
    assert.equal(c3, 3);
  } finally {
    try { rmSync(autoConfirmLoopCounterPath(dir, 'sess-1'), { force: true }); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
test('H3: bumpAutoConfirmLoop resets counter when signature changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h3-'));
  try {
    bumpAutoConfirmLoop(dir, 'sess-2', 'sig-a');
    bumpAutoConfirmLoop(dir, 'sess-2', 'sig-a');
    const fresh = bumpAutoConfirmLoop(dir, 'sess-2', 'sig-b');
    assert.equal(fresh, 1);
  } finally {
    try { rmSync(autoConfirmLoopCounterPath(dir, 'sess-2'), { force: true }); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
test('H3: per-session counter does not collide across sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h3-'));
  try {
    bumpAutoConfirmLoop(dir, 'sess-A', 'shared-sig');
    bumpAutoConfirmLoop(dir, 'sess-A', 'shared-sig');
    const other = bumpAutoConfirmLoop(dir, 'sess-B', 'shared-sig');
    assert.equal(other, 1, 'each session has its own counter');
  } finally {
    try {
      rmSync(autoConfirmLoopCounterPath(dir, 'sess-A'), { force: true });
      rmSync(autoConfirmLoopCounterPath(dir, 'sess-B'), { force: true });
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
test('H3: clearAutoConfirmLoop removes the counter file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h3-'));
  try {
    bumpAutoConfirmLoop(dir, 'sess-3', 'sig-x');
    clearAutoConfirmLoop(dir, 'sess-3');
    const path = autoConfirmLoopCounterPath(dir, 'sess-3');
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
section('CLI entry smoke test (spawn + stdin + exit code)');
// ----------------------------------------------------------------------------
test('no active state → exit 0 (no_state), no decision emitted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const payload = JSON.stringify({ cwd: dir, last_assistant_text: 'neutral' });
    const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
    assert.equal(res.stdout.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('active state + classifier stub → halt → exit 0, no queue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  const stubDir = mkdtempSync(join(tmpdir(), 'cls-stub-'));
  const stub = join(stubDir, 'cls.sh');
  writeFileSync(stub, `#!/bin/sh\nprintf 'halt'\n`, { mode: 0o755 });
  try {
    const featDir = join(dir, '.smt', 'features', 'h', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'h.state.json');
    const state = baseState({ mode: 'fix', current_stage: 'workflow-tasker', events: [] });
    writeState(statePath, state);
    mkdirSync(join(dir, '.smt'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);
    const sessionId = 'sess-halt-1';
    const payload = JSON.stringify({ cwd: dir, session_id: sessionId, last_assistant_text: 'Implementation complete.' });
    const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8', env: { ...process.env, SMT_CLASSIFIER_CMD: stub } });
    assert.equal(res.status, 0, `expected halt exit 0, got ${res.status}\nstderr: ${res.stderr}`);
    assert.equal(res.stdout.trim(), '');
    const sessQueue = join(dir, '.smt', 'state', `auto-confirm-queue-${sessionId}.json`);
    const legacyQueue = join(dir, '.smt', 'state', 'auto-confirm-queue.json');
    assert.equal(existsSync(sessQueue), false, 'no session-scoped queue should be dropped on halt');
    assert.equal(existsSync(legacyQueue), false, 'no legacy queue should be dropped on halt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});
test('active state + classifier stub → continue → exit 2 + queue with sub_agent_model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  const stubDir = mkdtempSync(join(tmpdir(), 'cls-stub-'));
  const stub = join(stubDir, 'cls.sh');
  writeFileSync(stub, `#!/bin/sh\nprintf '{"action":"continue","reason":"asked_permission"}'\n`, { mode: 0o755 });
  try {
    const featDir = join(dir, '.smt', 'features', 'p', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'p.state.json');
    const state = baseState({ mode: 'fix', current_stage: 'workflow-tasker', events: [] });
    writeState(statePath, state);
    mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);
    const sessionId = 'sess-continue-1';
    writeFileSync(
      join(dir, '.smt', 'state', `active-feature-${sessionId}.json`),
      JSON.stringify({ slug: 'p', session_id: sessionId }),
    );
    const payload = JSON.stringify({ cwd: dir, session_id: sessionId, last_assistant_text: '진행할까요?' });
    const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8', env: { ...process.env, SMT_CLASSIFIER_CMD: stub, CODEX_MODE: '1' } });
    assert.equal(res.status, 2, `expected block exit 2, got ${res.status}\nstderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.meta.sub_agent_model, 'gpt-5.4-mini');
    const queuePath = join(dir, '.smt', 'state', `auto-confirm-queue-${sessionId}.json`);
    const queue = JSON.parse(readFileSync(queuePath, 'utf-8'));
    assert.equal(queue.session_id, sessionId, 'queue payload must embed session_id');
    assert.equal(queue.sub_agent_model, 'gpt-5.4-mini');
    assert.match(queue.additionalContext, /sub-agent/i);
    assert.match(queue.additionalContext, /classifier sub-agent/);
    const legacyQueue = join(dir, '.smt', 'state', 'auto-confirm-queue.json');
    assert.equal(existsSync(legacyQueue), false, 'legacy shared queue must not be written when session_id present');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});
test('queue-signal present → exit 2, queue with queued_intent (skips classifier)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const featDir = join(dir, '.smt', 'features', 'q', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'q.state.json');
    writeState(statePath, baseState({ mode: 'fix', current_stage: 'workflow-tasker', events: [] }));
    mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);
    const sessionId = 'sess-test-1';
    writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
      type: 'queue',
      timestamp: Date.now(),
      reason: 'test',
      source: 'propagator',
      queued_intent: 'fix the next bug X',
      session_id: sessionId,
    }));
    const payload = JSON.stringify({ cwd: dir, session_id: sessionId, last_assistant_text: 'done' });
    const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8' });
    assert.equal(res.status, 2, `expected block exit 2, got ${res.status}\nstderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.meta.source, 'cancel-signal');
    // Queue-signal file should be consumed (deleted)
    assert.equal(existsSync(join(dir, '.smt', 'state', 'cancel-signal.json')), false);
    // Session-scoped auto-confirm-queue should hold the queued intent
    const sessQueuePath = join(dir, '.smt', 'state', `auto-confirm-queue-${sessionId}.json`);
    const queue = JSON.parse(readFileSync(sessQueuePath, 'utf-8'));
    assert.equal(queue.session_id, sessionId);
    assert.equal(queue.queued_intent, 'fix the next bug X');
    assert.match(queue.additionalContext, /fix the next bug X/);
    assert.equal(existsSync(join(dir, '.smt', 'state', 'auto-confirm-queue.json')), false,
      'legacy shared queue must not be written when session_id present');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('workflow-human-check completed (session_wrap) → exit 0, no queue (terminal halt)', () => {
  // Canonical terminal shape written by finalize-human-check.mjs: current_stage
  // stays at 'workflow-human-check', completed_stages includes it, and events[]
  // carries the matching pass event. decide() short-circuits this to
  // session_wrap via its workflow-human-check terminal-approval branch.
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const featDir = join(dir, '.smt', 'features', 'd', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'd.state.json');
    // results.md must exist on disk for validateEvidenceIntegrity to accept
    // the completed_stages['workflow-human-check'] entry.
    writeFileSync(join(featDir, 'results.md'), '# results\n');
    const s = baseState({
      mode: 'fix',
      current_stage: 'workflow-human-check',
      completed_stages: ['workflow-human-check'],
      events: [{
        t: new Date().toISOString(), skill: 'workflow-human-check', result: 'pass',
        declarer: 'hook', evidence: { type: 'file_present', path: 'results.md' },
      }],
    });
    writeState(statePath, s);
    mkdirSync(join(dir, '.smt'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);
    const payload = JSON.stringify({ cwd: dir, last_assistant_text: 'all done' });
    const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8' });
    assert.equal(res.status, 0, `expected halt exit 0, got ${res.status}\nstderr: ${res.stderr}`);
    assert.equal(res.stdout.trim(), '');
    const queuePath = join(dir, '.smt', 'state', 'auto-confirm-queue.json');
    assert.equal(existsSync(queuePath), false, 'session_wrap must not drop a queue (avoid loop)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('SMT_CLASSIFIER=1 recursion guard → exit 0, no work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const payload = JSON.stringify({ cwd: dir, last_assistant_text: 'whatever' });
    const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8', env: { ...process.env, SMT_CLASSIFIER: '1' } });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('active state + pass event + session_id → exit 2, session-scoped queue-drop produced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const featDir = join(dir, '.smt', 'features', 'f', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'f.state.json');
    const state = baseState({ mode: 'fix', current_stage: 'workflow-tasker', events: [passEvent('workflow-tasker')] });
    writeState(statePath, state);
    // Point active_task at it.
    mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);
    const sessionId = 'sess-pass-1';
    writeFileSync(
      join(dir, '.smt', 'state', `active-feature-${sessionId}.json`),
      JSON.stringify({ slug: 'f', session_id: sessionId }),
    );
    const payload = JSON.stringify({ cwd: dir, session_id: sessionId, last_assistant_text: 'completed step' });
    const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8' });
    assert.equal(res.status, 2, `expected block exit 2, got ${res.status}\nstderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.meta.queued, true, 'meta.queued should be true');
    const queuePath = join(dir, '.smt', 'state', `auto-confirm-queue-${sessionId}.json`);
    const queueRaw = readFileSync(queuePath, 'utf-8');
    const queue = JSON.parse(queueRaw);
    assert.equal(queue.session_id, sessionId);
    assert.ok(queue.additionalContext, 'queue payload should include additionalContext');
    assert.equal(queue.state_path, statePath);
    assert.equal(existsSync(join(dir, '.smt', 'state', 'auto-confirm-queue.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parallel sessions do not cross-pollinate: A writes, B reads nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const featDir = join(dir, '.smt', 'features', 'px', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'px.state.json');
    writeState(statePath, baseState({ mode: 'fix', current_stage: 'workflow-tasker', events: [passEvent('workflow-tasker')] }));
    mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);

    // Session A writes.
    const aId = 'sess-A';
    writeFileSync(
      join(dir, '.smt', 'state', `active-feature-${aId}.json`),
      JSON.stringify({ slug: 'px', session_id: aId }),
    );
    const aPayload = JSON.stringify({ cwd: dir, session_id: aId, last_assistant_text: 'A done' });
    const aRes = spawnSync('node', [HOOK], { input: aPayload, encoding: 'utf-8' });
    assert.equal(aRes.status, 2);
    const aPath = join(dir, '.smt', 'state', `auto-confirm-queue-${aId}.json`);
    assert.ok(existsSync(aPath));

    // Session B must not see A's queue when it runs the consumer.
    const consumerPath = join(__dirname, 'auto-confirm-consumer.mjs');
    const bId = 'sess-B';
    const bPayload = JSON.stringify({ cwd: dir, session_id: bId });
    const bRes = spawnSync('node', [consumerPath], { input: bPayload, encoding: 'utf-8' });
    assert.equal(bRes.status, 0);
    assert.equal(bRes.stdout.trim(), '', 'session B must not consume session A queue');
    assert.ok(existsSync(aPath), 'session A queue must remain for A to consume');

    // Session A consumes its own file.
    const aConsumePayload = JSON.stringify({ cwd: dir, session_id: aId });
    const aConsumeRes = spawnSync('node', [consumerPath], { input: aConsumePayload, encoding: 'utf-8' });
    assert.equal(aConsumeRes.status, 0);
    const injected = JSON.parse(aConsumeRes.stdout);
    assert.ok(injected.hookSpecificOutput?.additionalContext, 'session A must receive its own queued payload');
    assert.equal(existsSync(aPath), false, 'A queue consumed once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// Fix #1–#3 RED tests (Tasks 1-2a, 2-1, 2-2, 3-1)
// Each test is RED against current source. Annotated with the Fix task that
// makes it GREEN.
// ----------------------------------------------------------------------------
section('Fix #2 RED — stage_complete CLI does NOT write artifact after fix');

// @transitional — after Fix #2 Task 2-3 lands, this test's assertion flips:
// the spawned process must NOT create the artifact file on disk.
// Current behavior (lines 811-832): it DOES write the file → test is RED.
test('Fix #2 post-condition: stage_complete CLI path does NOT write canonical artifact', () => {
  // Post-Fix-#2 invariant: the Stop hook never synthesizes workflow artifacts.
  // Source must not contain the auto-generated-artifact header nor the
  // writeFileSync(absPath, ...) pattern unique to the removed block.
  const src = readFileSync(HOOK, 'utf-8');
  const hasGeneratedHeader = src.includes('auto-generated artifact');
  const hasAbsPathWrite = /writeFileSync\s*\(\s*absPath\s*,/.test(src);
  assert.equal(hasGeneratedHeader, false,
    'auto-confirm.mjs must not contain the "auto-generated artifact" header (Iron Law #5)');
  assert.equal(hasAbsPathWrite, false,
    'auto-confirm.mjs must not writeFileSync(absPath, ...) the canonical artifact (Iron Law #5)');
});

// ----------------------------------------------------------------------------
section('Fix #2 RED — buildPromptInjection stage_complete Write-tool directive');

// Task 2-2: future behavior. Will be GREEN after Fix #2 Task 2-3 rewrites
// the stage_complete case in buildPromptInjection (lines 614-629).
test('stage_complete injection contains Write-tool directive when artifact non-null', () => {
  // RED: current injection says "auto-written at" not "Write it using the Write tool".
  const s = baseState({ mode: 'fix', current_stage: 'workflow-investigate' });
  const text = buildPromptInjection(
    {
      action: 'stage_complete',
      reason: 'r',
      payload: {
        stage: 'workflow-investigate',
        nextSkill: 'workflow-investigate-review',
        summary: 'three root causes',
        artifact: { basename: 'investigation.md', absPath: '/tmp/t/investigation.md' },
        lastMessage: 'details',
      },
    },
    s,
  );
  // After Fix #2: injection must instruct the agent to Write the artifact itself.
  assert.match(text, /Write/,
    'injection must contain "Write" tool directive when artifact is non-null');
  assert.match(text, /investigation\.md/,
    'injection must name the canonical artifact basename');
  // The directive must not say "auto-written" (that's the bug being fixed).
  assert.doesNotMatch(text, /auto-written/,
    'injection must NOT claim the artifact was auto-written (removed by Fix #2)');
});

// Task 2-2 null-artifact variant: when artifact is null, injection must contain an
// explicit "no artifact" acknowledgement line (not just silently omit the line).
// RED: current code just omits the artifact line with no replacement text.
// GREEN after Fix #2 Task 2-3 adds an explicit null-artifact clause.
test('stage_complete injection omits Write-tool directive when artifact is null', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
  const text = buildPromptInjection(
    {
      action: 'stage_complete',
      reason: 'r',
      payload: {
        stage: 'workflow-coding',
        nextSkill: 'workflow-agent-review',
        summary: 'coding complete',
        artifact: null,
        lastMessage: 'done',
      },
    },
    s,
  );
  // After Fix #2: no Write-tool directive, and no auto-written claim either.
  assert.doesNotMatch(text, /auto-written/,
    'injection must not claim artifact was auto-written when artifact is null');
  // After Fix #2: must NOT contain a "Write" tool directive for the artifact
  // (the Write directive is only for non-null artifacts).
  // Currently injection contains neither directive for null artifact, but also
  // contains no explicit "no artifact for this stage" note — Fix #2 must add one.
  assert.match(text, /no.*artifact|artifact.*not required|no canonical artifact/i,
    'injection must explicitly state no artifact is required when artifact is null (Fix #2 clause)');
  // Must still have the mandatory block and next-skill invocation.
  assert.match(text, /\[MANDATORY WORKFLOW STEP\]/);
  assert.match(text, /workflow-agent-review/);
});

// ----------------------------------------------------------------------------
section('Fix #3 RED — stuck-loop escape + terminal stage behavior');

// Task 3-1a: @post-fold — expected behavior after Fix #3.
// Verifies autoConfirmSignature embeds completedCount (monotone integer), NOT
// the action string. Current code produces slug:mode:stage:action.
// After Fix #3 Task 3-2 it must produce slug:mode:stage:completedCount.
// RED: current autoConfirmSignature returns "feat-x:fix:workflow-investigate:enter_skill"
//      new format must be "feat-x:fix:workflow-investigate:0" (completedCount=0).
// @post-fold — assertion valid after Fix #3 Task 3-2.
test('Stop hook stuck-loop escape uses completedCount-based signature (post-fold assertion)', () => {
  // Build a state with known completedCount.
  const s = baseState({ mode: 'fix', current_stage: 'workflow-investigate', completed_stages: [] });
  s.task_id = 'feat-x';
  // After Fix #3: signature must encode completedCount (0) not action string.
  const sig = autoConfirmSignature(s, 'enter_skill');
  // Current (buggy): 'feat-x:fix:workflow-investigate:enter_skill'
  // Expected (fixed): 'feat-x:fix:workflow-investigate:0'
  assert.match(sig, /^feat-x:fix:workflow-investigate:\d+$/,
    `signature must encode completedCount as a digit, not action string. Got: "${sig}"`);
  assert.doesNotMatch(sig, /enter_skill/,
    `signature must NOT embed the action string. Got: "${sig}"`);
});

// Task 3-1b: @post-fold — after Fix #3, stop-stage-enforcer is deleted.
// The folded auto-confirm must be the ONLY Stop hook, meaning no
// /tmp/smelter-stop-loop-*.json file (the stop-stage-enforcer counter pattern)
// is ever created — only the auto-confirm per-session counter file exists.
// RED: currently stop-stage-enforcer.mjs is still registered and writes its
//      own /tmp/smelter-stop-loop-*.json on every non-terminal Stop.
//      This test verifies the post-fold world where that file never appears.
// @post-fold — assertion valid after Fix #3 Task 3-6 deletes stop-stage-enforcer.
test('Stop hook on terminal stage (workflow-human-check) emits halt not block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-fix3-terminal-'));
  const stubDir = mkdtempSync(join(tmpdir(), 'cls-fix3-terminal-'));
  const stub = join(stubDir, 'cls.sh');
  writeFileSync(stub, '#!/bin/sh\nprintf "halt"\n', { mode: 0o755 });
  try {
    const slug = 'termtest';
    const featDir = join(dir, '.smt', 'features', slug, 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, `${slug}.state.json`);
    const state = baseState({
      mode: 'fix',
      current_stage: 'workflow-human-check',
      completed_stages: [
        'workflow-investigate', 'workflow-investigate-review',
        'workflow-write-test', 'workflow-coding',
        'workflow-agent-review', 'workflow-e2e', 'workflow-e2e-review',
        'workflow-team-code-review',
      ],
      events: [
        passEvent('workflow-investigate'),
        passEvent('workflow-investigate-review'),
        passEvent('workflow-write-test'),
        passEvent('workflow-coding'),
        passEvent('workflow-agent-review'),
        passEvent('workflow-e2e'),
        passEvent('workflow-e2e-review'),
        passEvent('workflow-team-code-review'),
      ],
    });
    writeFileSync(statePath, JSON.stringify(state));
    mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
    const sessionId = 'fix3-term-sess';
    writeFileSync(
      join(dir, '.smt', 'state', `active-feature-${sessionId}.json`),
      JSON.stringify({ slug, session_id: sessionId }),
    );
    const payload = JSON.stringify({
      cwd: dir,
      session_id: sessionId,
      last_assistant_text: 'Awaiting your approval before proceeding.',
    });
    const res = spawnSync('node', [HOOK], {
      input: payload,
      encoding: 'utf-8',
      env: { ...process.env, SMT_CLASSIFIER_CMD: stub },
    });
    // Halt behavior (already passes pre-fold).
    assert.equal(res.status, 0,
      `expected exit 0 (halt) on terminal stage, got ${res.status}\nstderr: ${res.stderr}\nstdout: ${res.stdout}`);
    assert.equal(res.stdout.trim(), '', 'terminal halt must emit no block decision');

    // @post-fold RED assertion: stop-stage-enforcer.mjs must be deleted.
    // Currently the file exists (Fix #3 Task 3-6 deletes it).
    // After the fold this assertion flips GREEN.
    const enforcerAbs = join(__dirname, 'stop-stage-enforcer.mjs');
    assert.equal(existsSync(enforcerAbs), false,
      'stop-stage-enforcer.mjs must be deleted after Fix #3 fold (post-fold assertion)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
section('Review-skill verdict detection + fail routing');
// ----------------------------------------------------------------------------
test('detectReviewVerdict finds "Verdict\\n\\nfail"', () => {
  assert.equal(detectReviewVerdict('Verdict\n\nfail\n\nRoute:'), 'fail');
});
test('detectReviewVerdict finds "Verdict: fail"', () => {
  assert.equal(detectReviewVerdict('Final Verdict: fail'), 'fail');
});
test('detectReviewVerdict finds "verdict = fail"', () => {
  assert.equal(detectReviewVerdict('- verdict = fail'), 'fail');
});
test('detectReviewVerdict finds pass', () => {
  assert.equal(detectReviewVerdict('Verdict\n\npass'), 'pass');
});
test('detectReviewVerdict returns null when absent', () => {
  assert.equal(detectReviewVerdict('No verdict here, just prose.'), null);
});
test('detectReviewVerdict prefers last occurrence', () => {
  assert.equal(detectReviewVerdict('Verdict: pass in round 1. Final verdict: fail.'), 'fail');
});
test('detectReviewFailCause picks insufficient_scenario', () => {
  assert.equal(detectReviewFailCause('Missing Cases: insufficient scenario coverage.'), 'insufficient_scenario');
});
test('detectReviewFailCause picks artifact_missing', () => {
  assert.equal(detectReviewFailCause('artifact_missing detected for this stage'), 'artifact_missing');
});
test('detectReviewFailCause returns null on unknown', () => {
  assert.equal(detectReviewFailCause('generic prose'), null);
});
test('decide: review stage_complete with fail verdict routes back via producer chain', () => {
  const state = baseState({ mode: 'implement', current_stage: 'workflow-e2e-review' });
  state.allowed_skills = ['workflow-coding', 'workflow-e2e', 'workflow-e2e-review'];
  const lastMessage = [
    '2-round review done.',
    'Verdict\n\nfail',
    'Route: workflow-coding',
    'insufficient scenario coverage on CLI surface.',
  ].join('\n');
  const d = decide({
    state,
    lastAssistantText: lastMessage,
    statePath: '/tmp/nope.state.json',
    stageClassifier: () => ({ verdict: 'complete', summary: 'review done' }),
    questionShape: 'statement',
  });
  assert.equal(d.action, 'enter_skill');
  assert.equal(d.payload.direction, 'back');
  assert.equal(d.payload.skill, 'workflow-coding');
  assert.match(d.reason, /review fail verdict/);
});
test('decide: review stage_complete with pass verdict advances forward', () => {
  const state = baseState({ mode: 'implement', current_stage: 'workflow-e2e-review' });
  state.allowed_skills = ['workflow-coding', 'workflow-e2e', 'workflow-e2e-review', 'workflow-human-check'];
  state.completed_stages = ['workflow-coding', 'workflow-e2e'];
  const lastMessage = 'All rounds pass. Verdict: pass';
  const d = decide({
    state,
    lastAssistantText: lastMessage,
    statePath: '/tmp/nope.state.json',
    stageClassifier: () => ({ verdict: 'complete', summary: 'review done' }),
    questionShape: 'statement',
  });
  assert.equal(d.action, 'stage_complete');
});

// ----------------------------------------------------------------------------
section('findActiveTaskState staleness guard (casual-chat protection)');
// ----------------------------------------------------------------------------
test('ACTIVE_STATE_MAX_AGE_MS is exported (1 hour default)', () => {
  assert.equal(typeof ACTIVE_STATE_MAX_AGE_MS, 'number');
  assert.ok(ACTIVE_STATE_MAX_AGE_MS >= 10 * 60 * 1000);
});
test('findActiveTaskState mtime-fallback rejects state older than threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smt-stale-'));
  try {
    const slug = 'legacy';
    const taskDir = join(dir, '.smt', 'features', slug, 'task');
    mkdirSync(taskDir, { recursive: true });
    const statePath = join(taskDir, `${slug}.state.json`);
    writeFileSync(statePath, '{}', 'utf-8');
    const stale = (Date.now() - (ACTIVE_STATE_MAX_AGE_MS + 60_000)) / 1000;
    utimesSync(statePath, stale, stale);
    // No sessionId, no pointer — fallback kicks in but should see stale.
    const found = findActiveTaskState(dir, '');
    assert.equal(found, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('findActiveTaskState mtime-fallback accepts recent state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smt-fresh-'));
  try {
    const slug = 'active';
    const taskDir = join(dir, '.smt', 'features', slug, 'task');
    mkdirSync(taskDir, { recursive: true });
    const statePath = join(taskDir, `${slug}.state.json`);
    writeFileSync(statePath, '{}', 'utf-8');
    const found = findActiveTaskState(dir, '');
    assert.equal(found, statePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
section('Fix A: applyProseCompletionPass — pass event write on stage_complete (prose-completion path)');
// ----------------------------------------------------------------------------

function seedStateOnDisk({ mode = 'fix', current_stage = 'workflow-investigate', events = [], completed_stages = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smt-fixA-'));
  const taskDir = join(dir, '.smt', 'features', 'test-task', 'task');
  mkdirSync(taskDir, { recursive: true });
  const statePath = join(taskDir, 'test-task.state.json');
  const s = baseState({ mode, current_stage, events, completed_stages });
  writeFileSync(statePath, JSON.stringify(s), 'utf-8');
  return { dir, statePath, state: s };
}

test('Fix A 1-1: writes pass event when no prior pass event exists', () => {
  const { dir, statePath, state } = seedStateOnDisk();
  try {
    assert.equal(typeof applyProseCompletionPass, 'function', 'applyProseCompletionPass must be exported');
    applyProseCompletionPass(state, statePath);
    const passEvents = state.events.filter(e => e.skill === 'workflow-investigate' && e.result === 'pass');
    assert.equal(passEvents.length, 1, 'exactly one pass event written');
    assert.equal(passEvents[0].declarer, 'hook', 'declarer marked as hook');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix A 1-2: idempotent — pass event already exists, no duplicate written', () => {
  const { dir, statePath, state } = seedStateOnDisk({ events: [passEvent('workflow-investigate')] });
  try {
    const before = state.events.length;
    applyProseCompletionPass(state, statePath);
    assert.equal(state.events.length, before, 'no new event added');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix A 1-3: fail event exists — pass event NOT written (permanent lockout in session)', () => {
  const { dir, statePath, state } = seedStateOnDisk({ events: [failEvent('workflow-investigate')] });
  try {
    const before = state.events.length;
    applyProseCompletionPass(state, statePath);
    assert.equal(state.events.length, before, 'fail event blocks pass write');
    const passCount = state.events.filter(e => e.skill === 'workflow-investigate' && e.result === 'pass').length;
    assert.equal(passCount, 0, 'no pass event written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix A 1-4: statePath null — no-op, no crash', () => {
  const state = baseState({ mode: 'fix', current_stage: 'workflow-investigate' });
  // Must not throw
  applyProseCompletionPass(state, null);
  applyProseCompletionPass(state, undefined);
  applyProseCompletionPass(null, '/tmp/whatever');
  assert.equal(state.events.length, 0, 'no event written without state/statePath');
});

test('Fix A 1-5: after write, shouldRunStageCompletionClassifier returns false (loop broken)', () => {
  const { dir, statePath, state } = seedStateOnDisk();
  try {
    applyProseCompletionPass(state, statePath);
    const longText = 'a'.repeat(50);
    assert.equal(shouldRunStageCompletionClassifier(state, longText), false, 'classifier short-circuits after Fix A');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix A 1-6: completed_stages NOT advanced (avoids validateEvidenceIntegrity throw)', () => {
  const { dir, statePath, state } = seedStateOnDisk();
  try {
    const beforeLen = state.completed_stages.length;
    applyProseCompletionPass(state, statePath);
    assert.equal(state.completed_stages.length, beforeLen, 'completed_stages untouched');
    assert.ok(!state.completed_stages.includes('workflow-investigate'), 'stage not added to completed_stages');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix A 1-7: state persisted to disk before returning (signature-ordering safety)', () => {
  const { dir, statePath, state } = seedStateOnDisk();
  try {
    applyProseCompletionPass(state, statePath);
    const persisted = JSON.parse(readFileSync(statePath, 'utf-8'));
    const passOnDisk = (persisted.events || []).filter(e => e.skill === 'workflow-investigate' && e.result === 'pass');
    assert.equal(passOnDisk.length, 1, 'pass event persisted to disk');
    assert.equal(passOnDisk[0].declarer, 'hook');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix A 1-8: loop-breaking invariant — decide() after Fix A returns advance, not stage_complete again', () => {
  const { dir, statePath, state } = seedStateOnDisk();
  try {
    // First decide() — classifier returns complete → stage_complete
    const stub = () => ({ verdict: 'complete', summary: 'prose findings' });
    const longProse = 'Investigation done. Found three root causes in auto-confirm.mjs line 387.';
    const first = decide({ state, lastAssistantText: longProse, statePath, stageClassifier: stub });
    assert.equal(first.action, 'stage_complete', 'first decide returns stage_complete');

    // Fix A fires
    applyProseCompletionPass(state, statePath);

    // Second decide() on same state — last.result === 'pass' AND last.skill === current_stage → advance
    const second = decide({ state, lastAssistantText: longProse, statePath, stageClassifier: stub });
    assert.notEqual(second.action, 'stage_complete', 'second decide does not re-fire stage_complete');
    assert.notEqual(second.action, 'stage_incomplete', 'second decide does not return incomplete');
    assert.equal(second.action, 'advance', 'second decide returns advance (loop broken)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
section('Fix A companion: decide() L495 advance branch guard (last.skill === current_stage)');
// ----------------------------------------------------------------------------

test('Fix A companion 2-1: same-stage pass + current_stage → advance fires (regression test)', () => {
  // Normal PostToolUse:Skill path: pass event for current_stage
  const s = baseState({
    mode: 'fix',
    current_stage: 'workflow-investigate',
    events: [passEvent('workflow-investigate')],
  });
  const d = decide({
    state: s,
    lastAssistantText: 'done',
    statePath: '/tmp/fake/task/f.state.json',
    stageClassifier: () => ({ verdict: 'unknown', summary: '' }),
  });
  assert.equal(d.action, 'advance', 'existing PostToolUse→advance flow preserved');
});

test('Fix A companion 2-2: cross-stage pass (last.skill !== current_stage) → advance skipped', () => {
  // After Fix A writes pass for workflow-investigate, agent invokes review skill
  // → current_stage = 'workflow-investigate-review', but last.skill = 'workflow-investigate'
  const s = baseState({
    mode: 'fix',
    current_stage: 'workflow-investigate-review',
    events: [passEvent('workflow-investigate')],
  });
  const d = decide({
    state: s,
    lastAssistantText: 'a'.repeat(50),
    statePath: '/tmp/fake/task/f.state.json',
    stageClassifier: () => ({ verdict: 'unknown', summary: '' }),
  });
  assert.notEqual(d.action, 'advance', 'cross-stage pass does NOT trigger advance');
});

test('Fix A companion 2-3: null/undefined current_stage → advance branch safely skipped (no crash)', () => {
  const s = baseState({
    mode: 'fix',
    current_stage: null,
    events: [passEvent('workflow-investigate')],
  });
  const d = decide({
    state: s,
    lastAssistantText: 'a'.repeat(50),
    statePath: '/tmp/fake/task/f.state.json',
    stageClassifier: () => ({ verdict: 'unknown', summary: '' }),
  });
  // Must not crash and must not return advance (current_stage is null → guard trips)
  assert.notEqual(d.action, 'advance', 'null current_stage does not trigger advance');
});

test('Fix A companion 2-4: cross-stage pass + prior fail on current_stage (producer-chain recovery) → advance fires', () => {
  // Producer-chain recovery: current_stage failed earlier, producer ran and passed,
  // the currentStageHasFail OR-branch allows advance even though last.skill !== current_stage.
  const s = baseState({
    mode: 'fix',
    current_stage: 'workflow-coding',
    events: [failEvent('workflow-coding', 'scope_mismatch'), passEvent('workflow-tasker')],
  });
  const d = decide({
    state: s,
    lastAssistantText: 'a'.repeat(50),
    statePath: '/tmp/fake/task/f.state.json',
    stageClassifier: () => ({ verdict: 'unknown', summary: '' }),
  });
  assert.equal(d.action, 'advance', 'currentStageHasFail OR-branch allows advance on producer-chain recovery');
});

// ----------------------------------------------------------------------------
section('Fix B: buildStageCompletionPrompt — transition-acknowledgement exception clause');
// ----------------------------------------------------------------------------

test('Fix B 3-1: prompt contains BOTH "Finished means" rule AND new exception clause (append, not replace)', () => {
  const p = buildStageCompletionPrompt({
    lastMessage: 'any',
    currentStage: 'workflow-investigate',
    mode: 'fix',
  });
  // Ordered-substring: Finished-means rule must precede the exception clause
  const idxFinished = p.indexOf('Finished');
  const idxException = p.search(/Exception|USER.*selected/i);
  assert.ok(idxFinished >= 0, 'pre-existing "Finished" rule preserved');
  assert.ok(idxException >= 0, 'new exception clause present');
  assert.ok(idxFinished < idxException, '"Finished" rule precedes exception clause (append semantics)');
});

test('Fix B 3-2: exception clause requires "USER" selection phrasing (uppercased)', () => {
  const p = buildStageCompletionPrompt({
    lastMessage: 'any',
    currentStage: 'workflow-investigate',
    mode: 'fix',
  });
  // The clause must use USER (uppercase) to distinguish from agent speculation
  assert.match(p, /USER/, 'clause uses uppercase USER to emphasize user-selection requirement');
});

test('Fix B 3-3: exception explicitly excludes agent speculation', () => {
  const p = buildStageCompletionPrompt({
    lastMessage: 'any',
    currentStage: 'workflow-investigate',
    mode: 'fix',
  });
  // Clause must name agent-speculation as a counter-example (Do NOT apply...)
  assert.match(p, /agent[- ]speculation|speculation|I think we should/i, 'agent speculation called out as excluded');
});

test('Fix B 3-4: exception covers review-stage completion language', () => {
  const p = buildStageCompletionPrompt({
    lastMessage: 'any',
    currentStage: 'workflow-investigate-review',
    mode: 'fix',
  });
  // Clause must reference review-stage completion phrasing
  assert.match(p, /review passed|consensus reached|all rounds/i, 'review-stage language included in examples');
});

test('Fix B 3-5: exception excludes "/fix" as file path token', () => {
  const p = buildStageCompletionPrompt({
    lastMessage: 'any',
    currentStage: 'workflow-investigate',
    mode: 'fix',
  });
  // Clause must warn against matching /fix in file paths
  assert.match(p, /file path|fix\/auth\.ts|path token/i, 'file-path exclusion present');
});

test('Fix B 3-6: exception excludes pure Korean investigation-complete without user selection', () => {
  const p = buildStageCompletionPrompt({
    lastMessage: 'any',
    currentStage: 'workflow-investigate',
    mode: 'fix',
  });
  // Clause must reference investigation-complete-alone exclusion
  assert.match(p, /조사 완료|investigation done|without explicit user selection/i, 'bare investigation-complete excluded');
});

// ----------------------------------------------------------------------------
section('Fix A E2E: end-to-end main() flow with disk readback');
// ----------------------------------------------------------------------------

test('Fix A E2E: full write+readback+idempotency+classifier+completed_stages invariants', () => {
  const { dir, statePath, state } = seedStateOnDisk();
  try {
    // (1) in-memory events gains pass entry
    applyProseCompletionPass(state, statePath);
    const memPassCount = state.events.filter(e => e.skill === 'workflow-investigate' && e.result === 'pass').length;
    assert.equal(memPassCount, 1, '(1) in-memory events has exactly one pass entry');

    // (2) disk-readback — state file on disk contains the pass event
    const diskState = JSON.parse(readFileSync(statePath, 'utf-8'));
    const diskPassCount = (diskState.events || []).filter(e => e.skill === 'workflow-investigate' && e.result === 'pass').length;
    assert.equal(diskPassCount, 1, '(2) disk state file has exactly one pass entry (writeState succeeded)');

    // (3) idempotency — second call does not duplicate in-memory or on disk
    applyProseCompletionPass(state, statePath);
    const memAfter = state.events.filter(e => e.skill === 'workflow-investigate' && e.result === 'pass').length;
    const diskAfter = JSON.parse(readFileSync(statePath, 'utf-8')).events.filter(
      e => e.skill === 'workflow-investigate' && e.result === 'pass'
    ).length;
    assert.equal(memAfter, 1, '(3a) in-memory idempotent');
    assert.equal(diskAfter, 1, '(3b) disk idempotent');

    // (4) shouldRunStageCompletionClassifier returns false after Fix A
    assert.equal(shouldRunStageCompletionClassifier(state, 'a'.repeat(50)), false, '(4) classifier short-circuits');

    // (5) completed_stages unchanged from seed (design invariant to avoid validateEvidenceIntegrity throw)
    assert.equal(state.completed_stages.length, 0, '(5) completed_stages unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
console.log('');
console.log(`\nauto-confirm: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}: ${f.message}`);
  process.exit(1);
}
