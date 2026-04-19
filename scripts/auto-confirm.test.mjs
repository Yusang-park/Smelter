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
  detectProceedPrompt,
  pickSubAgentModel,
  buildPromptInjection,
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
  assert.equal(detectModeTransitionSignal('transitioning to plan mode'), 'plan');
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
section('detectProceedPrompt (Korean + English ask-permission patterns)');
// ----------------------------------------------------------------------------
test('Korean 진행할까요 detected', () => {
  assert.equal(detectProceedPrompt('이대로 진행할까요?'), true);
});
test('Korean 계속할까요 detected', () => {
  assert.equal(detectProceedPrompt('계속할까요?'), true);
});
test('Korean 다음 단계로 진행할까요 detected', () => {
  assert.equal(detectProceedPrompt('다음 단계로 진행할까요?'), true);
});
test('English shall I proceed detected', () => {
  assert.equal(detectProceedPrompt('Shall I proceed?'), true);
});
test('English should I continue detected', () => {
  assert.equal(detectProceedPrompt('Should I continue with the implementation?'), true);
});
test('English ready to proceed detected', () => {
  assert.equal(detectProceedPrompt('Ready to proceed.'), true);
});
test('Clean completion message NOT detected', () => {
  assert.equal(detectProceedPrompt('All tests pass. Implementation complete.'), false);
});
test('Empty string NOT detected', () => {
  assert.equal(detectProceedPrompt(''), false);
});
test('Null input NOT detected', () => {
  assert.equal(detectProceedPrompt(null), false);
});

// ----------------------------------------------------------------------------
section('pickSubAgentModel (sonnet default, mini under codex)');
// ----------------------------------------------------------------------------
test('default returns sonnet', () => {
  delete process.env.CODEX_MODE;
  assert.equal(pickSubAgentModel(), 'sonnet');
});
test('CODEX_MODE=1 env returns haiku', () => {
  process.env.CODEX_MODE = '1';
  try {
    assert.equal(pickSubAgentModel(), 'haiku');
  } finally {
    delete process.env.CODEX_MODE;
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
  withTempState(baseState({ mode: 'investigate', chained_modes: ['investigate', 'fix'] }), (path, state) => {
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
  withTempState(baseState({ mode: 'plan', chained_modes: ['plan', 'implement'] }), (path, state) => {
    const next = consumeNextChainedMode(path, state, '*');
    assert.equal(next, 'implement');
  });
});
test('requestedMode matching later entry skips head', () => {
  withTempState(baseState({ mode: 'investigate', chained_modes: ['investigate', 'plan', 'implement'] }), (path, state) => {
    const next = consumeNextChainedMode(path, state, 'implement');
    assert.equal(next, 'implement');
    assert.deepEqual(state.chained_modes, ['implement']);
  });
});
test('requestedMode not in remaining chain returns empty', () => {
  withTempState(baseState({ mode: 'fix', chained_modes: ['fix', 'implement'] }), (path, state) => {
    const next = consumeNextChainedMode(path, state, 'plan');
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
test('workflow-human-check with pass event does NOT halt (pass path continues)', () => {
  const s = baseState({ current_stage: 'workflow-human-check', events: [passEvent('workflow-human-check')] });
  const d = decide({ state: s, lastAssistantText: '' });
  // Passed human-check should advance, not halt
  assert.notEqual(d.action, 'halt');
});
test('_awaiting_mode_upgrade flag → halt', () => {
  const s = baseState();
  s._awaiting_mode_upgrade = true;
  const d = decide({ state: s, lastAssistantText: '' });
  assert.equal(d.action, 'halt');
});
test('current_stage === done → session_wrap', () => {
  const s = baseState({ current_stage: 'done' });
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
test('last event pass → advance', () => {
  const s = baseState({
    current_stage: 'workflow-write-test',
    events: [passEvent('workflow-write-test')],
  });
  const d = decide({ state: s, lastAssistantText: 'clean' });
  assert.equal(d.action, 'advance');
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
test('no signal + neutral message → halt (no infinite loop)', () => {
  const s = baseState({ current_stage: 'workflow-tasker', events: [] });
  const d = decide({ state: s, lastAssistantText: 'Implementation complete.' });
  assert.equal(d.action, 'halt');
});
test('no signal + Korean proceed prompt → continue (auto-confirm)', () => {
  const s = baseState({ current_stage: 'workflow-tasker', events: [] });
  const d = decide({ state: s, lastAssistantText: '다음 단계로 진행할까요?' });
  assert.equal(d.action, 'continue');
});
test('no signal + English proceed prompt → continue (auto-confirm)', () => {
  const s = baseState({ current_stage: 'workflow-tasker', events: [] });
  const d = decide({ state: s, lastAssistantText: 'Shall I proceed with the next step?' });
  assert.equal(d.action, 'continue');
});

// ----------------------------------------------------------------------------
section('decide() — chained intent auto-transition (§4-3 gate + §11 integration)');
// ----------------------------------------------------------------------------
test('chained_modes + transition signal → chain_advance', () => {
  withTempState(baseState({ mode: 'investigate', chained_modes: ['investigate', 'fix'], current_stage: 'workflow-investigate-review', events: [passEvent('workflow-investigate-review')] }), (path, state) => {
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
  withTempState(baseState({ mode: 'plan', chained_modes: ['plan', 'implement'], current_stage: 'workflow-human-check' }), (path, state) => {
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
  const s = baseState({ mode: 'plan', chained_modes: ['plan', 'implement'], events: [] });
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
test('chain_advance includes target + remaining chain tail', () => {
  const s = baseState({ mode: 'plan' });
  const text = buildPromptInjection({ action: 'chain_advance', reason: 'r', payload: { nextMode: 'implement', remaining: ['plan', 'implement', 'fix'] } }, s);
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
test('enter_skill action embeds sub-agent model hint', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-coding' });
  const text = buildPromptInjection({ action: 'enter_skill', reason: 'r', payload: { skill: 'workflow-coding' } }, s, { subAgentModel: 'sonnet' });
  assert.match(text, /sonnet/);
});
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
test('explicit .smt/active_task pointer wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const featDir = join(dir, '.smt', 'features', 'a', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'a.state.json');
    writeFileSync(statePath, '{}');
    mkdirSync(join(dir, '.smt'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);
    assert.equal(findActiveTaskState(dir), statePath);
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
test('active state + neutral message → exit 0, no queue (halt path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const featDir = join(dir, '.smt', 'features', 'h', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'h.state.json');
    const state = baseState({ mode: 'fix', current_stage: 'workflow-tasker', events: [] });
    writeState(statePath, state);
    mkdirSync(join(dir, '.smt'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);
    const payload = JSON.stringify({ cwd: dir, last_assistant_text: 'Implementation complete.' });
    const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8' });
    assert.equal(res.status, 0, `expected halt exit 0, got ${res.status}\nstderr: ${res.stderr}`);
    assert.equal(res.stdout.trim(), '');
    const queuePath = join(dir, '.smt', 'state', 'auto-confirm-queue.json');
    assert.equal(existsSync(queuePath), false, 'no queue file should be dropped on halt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('active state + proceed prompt → exit 2, queue-drop with sub_agent_model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const featDir = join(dir, '.smt', 'features', 'p', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'p.state.json');
    const state = baseState({ mode: 'fix', current_stage: 'workflow-tasker', events: [] });
    writeState(statePath, state);
    mkdirSync(join(dir, '.smt'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);
    const payload = JSON.stringify({ cwd: dir, last_assistant_text: '진행할까요?' });
    const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8' });
    assert.equal(res.status, 2, `expected block exit 2, got ${res.status}\nstderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.meta.sub_agent_model, 'sonnet');
    const queuePath = join(dir, '.smt', 'state', 'auto-confirm-queue.json');
    const queue = JSON.parse(readFileSync(queuePath, 'utf-8'));
    assert.equal(queue.sub_agent_model, 'sonnet');
    assert.match(queue.additionalContext, /sub-agent/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('active state + pass event → exit 2, queue-drop produced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const featDir = join(dir, '.smt', 'features', 'f', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'f.state.json');
    const state = baseState({ mode: 'fix', current_stage: 'workflow-tasker', events: [passEvent('workflow-tasker')] });
    writeState(statePath, state);
    // Point active_task at it.
    mkdirSync(join(dir, '.smt'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);
    const payload = JSON.stringify({ cwd: dir, last_assistant_text: 'completed step' });
    const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8' });
    assert.equal(res.status, 2, `expected block exit 2, got ${res.status}\nstderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.meta.queued, true, 'meta.queued should be true');
    // Queue file must exist and carry the injection.
    const queuePath = join(dir, '.smt', 'state', 'auto-confirm-queue.json');
    const queueRaw = readFileSync(queuePath, 'utf-8');
    const queue = JSON.parse(queueRaw);
    assert.ok(queue.additionalContext, 'queue payload should include additionalContext');
    assert.equal(queue.state_path, statePath);
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
