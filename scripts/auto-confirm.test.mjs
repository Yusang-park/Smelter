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
section('buildClassifierPrompt (LLM sub-agent prompt shape)');
// ----------------------------------------------------------------------------
test('prompt embeds the assistant message verbatim', () => {
  const p = buildClassifierPrompt('Shall I proceed?');
  assert.match(p, /Shall I proceed\?/);
});
test('prompt instructs binary continue/halt output', () => {
  const p = buildClassifierPrompt('hello');
  assert.match(p, /continue/);
  assert.match(p, /halt/);
});
test('prompt is language-agnostic (mentions "any language")', () => {
  const p = buildClassifierPrompt('hello');
  assert.match(p, /any language/i);
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
test('stub returning "continue" → continue', () => {
  const { dir, stub } = makeStub('continue');
  try {
    const v = classifyProceedPromptViaSubAgent('next?', { cmd: stub });
    assert.equal(v, 'continue');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('stub returning "halt" → halt', () => {
  const { dir, stub } = makeStub('halt');
  try {
    const v = classifyProceedPromptViaSubAgent('done.', { cmd: stub });
    assert.equal(v, 'halt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('stub returning garbage → halt (safe default, no fallback)', () => {
  const { dir, stub } = makeStub('maybe?');
  try {
    const v = classifyProceedPromptViaSubAgent('?', { cmd: stub });
    assert.equal(v, 'halt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('stub exit non-zero → halt', () => {
  const { dir, stub } = makeStub('continue', 1);
  try {
    const v = classifyProceedPromptViaSubAgent('?', { cmd: stub });
    assert.equal(v, 'halt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('empty input → halt without spawning', () => {
  assert.equal(classifyProceedPromptViaSubAgent('', { cmd: '/bin/false' }), 'halt');
  assert.equal(classifyProceedPromptViaSubAgent(null, { cmd: '/bin/false' }), 'halt');
});
test('missing binary → halt (no fallback)', () => {
  const v = classifyProceedPromptViaSubAgent('proceed?', { cmd: '/nonexistent/path/xyz' });
  assert.equal(v, 'halt');
});
test('stub trimmed whitespace + trailing newline accepted', () => {
  const { dir, stub } = makeStub('continue\\n');
  try {
    const v = classifyProceedPromptViaSubAgent('?', { cmd: stub });
    assert.equal(v, 'continue');
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('investigate-review pass halts for user mode decision in investigate mode', () => {
  const s = baseState({
    mode: 'investigate',
    allowed_skills: ['workflow-investigate', 'workflow-investigate-review'],
    current_stage: 'workflow-investigate-review',
    completed_stages: ['workflow-investigate'],
    events: [passEvent('workflow-investigate-review')],
  });
  const d = decide({ state: s, lastAssistantText: 'mode_transition gate' });
  assert.equal(d.action, 'halt');
  assert.match(d.reason, /investigate mode user decision/);
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
test('H2: advance injection names the skill when payload.skill is set', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-write-test' });
  const text = buildPromptInjection({ action: 'advance', reason: 'r', payload: { skill: 'workflow-coding' } }, s);
  assert.match(text, /workflow-coding/);
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

// ----------------------------------------------------------------------------
section('H3: stuck-loop guard (signature counter + threshold escape)');
// ----------------------------------------------------------------------------
test('H3: threshold constant is 3', () => {
  assert.equal(AUTO_CONFIRM_STUCK_THRESHOLD, 3);
});
test('H3: autoConfirmSignature composes slug/mode/stage/action', () => {
  const s = baseState({ mode: 'fix', current_stage: 'workflow-investigate' });
  s.task_id = 'feat-x';
  const sig = autoConfirmSignature(s, 'enter_skill');
  assert.equal(sig, 'feat-x:fix:workflow-investigate:enter_skill');
});
test('H3: autoConfirmSignature with null state + null action', () => {
  assert.equal(autoConfirmSignature(null, null), 'no-state:null');
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
  writeFileSync(stub, `#!/bin/sh\nprintf 'continue'\n`, { mode: 0o755 });
  try {
    const featDir = join(dir, '.smt', 'features', 'p', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'p.state.json');
    const state = baseState({ mode: 'fix', current_stage: 'workflow-tasker', events: [] });
    writeState(statePath, state);
    mkdirSync(join(dir, '.smt'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);
    const sessionId = 'sess-continue-1';
    const payload = JSON.stringify({ cwd: dir, session_id: sessionId, last_assistant_text: '진행할까요?' });
    const res = spawnSync('node', [HOOK], { input: payload, encoding: 'utf-8', env: { ...process.env, SMT_CLASSIFIER_CMD: stub } });
    assert.equal(res.status, 2, `expected block exit 2, got ${res.status}\nstderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.meta.sub_agent_model, 'sonnet');
    const queuePath = join(dir, '.smt', 'state', `auto-confirm-queue-${sessionId}.json`);
    const queue = JSON.parse(readFileSync(queuePath, 'utf-8'));
    assert.equal(queue.session_id, sessionId, 'queue payload must embed session_id');
    assert.equal(queue.sub_agent_model, 'sonnet');
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
test('current_stage=done (session_wrap) → exit 0, no queue (terminal halt)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-v2-'));
  try {
    const featDir = join(dir, '.smt', 'features', 'd', 'task');
    mkdirSync(featDir, { recursive: true });
    const statePath = join(featDir, 'd.state.json');
    // Bypass writeState's schema validator (which rejects 'done' since it's not
    // in WORKFLOW_SKILLS) — production paths set current_stage='done' via Edit.
    const s = baseState({ mode: 'fix', events: [] });
    s.current_stage = 'done';
    writeFileSync(statePath, JSON.stringify(s));
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
    mkdirSync(join(dir, '.smt'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);
    const sessionId = 'sess-pass-1';
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
    mkdirSync(join(dir, '.smt'), { recursive: true });
    writeFileSync(join(dir, '.smt', 'active_task'), statePath);

    // Session A writes.
    const aId = 'sess-A';
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
console.log('');
console.log(`\nauto-confirm: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}: ${f.message}`);
  process.exit(1);
}
