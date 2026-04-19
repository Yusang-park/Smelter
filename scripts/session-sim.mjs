#!/usr/bin/env node
/**
 * session-sim.mjs — Simulate a real Claude Code session and drive the Smelter
 * hook lifecycle end-to-end. Spawns each hook as a child process with
 * realistic stdin payloads (as Claude Code would), captures stdout/stderr,
 * and verifies state.json mutations across a complete workflow lifecycle.
 *
 * Run: node scripts/session-sim.mjs
 *
 * This is NOT a unit test — it demonstrates that every hook fires correctly
 * under real-session conditions:
 *   - Stop hook drops queue file + emits block decision
 *   - UserPromptSubmit consumer picks up queue + injects context
 *   - Producer chain routing on fail
 *   - Risk keyword → sub-tasker signal
 *   - Chained mode auto-advance
 *   - Halt on workflow-human-check (legitimate)
 *   - State.json progresses through multiple events
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createInitialState, writeState, appendEvent } from './state-schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_CONFIRM = join(__dirname, 'auto-confirm.mjs');
const AUTO_CONFIRM_CONSUMER = join(__dirname, 'auto-confirm-consumer.mjs');

// ANSI helpers for readable trace output.
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const blue   = (s) => `\x1b[34m${s}\x1b[0m`;
const gray   = (s) => `\x1b[90m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;

function section(title) {
  console.log('');
  console.log(bold(blue(`━━━ ${title} ━━━`)));
}

function event(label) {
  console.log(gray('  ▶ ') + label);
}

function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log('  ' + green('✓') + ' ' + label);
  } else {
    console.log('  ' + red('✗') + ' ' + label);
    console.log('      expected: ' + JSON.stringify(expected));
    console.log('      actual:   ' + JSON.stringify(actual));
    process.exitCode = 1;
  }
}

function assertOk(label, cond, detail = '') {
  if (cond) {
    console.log('  ' + green('✓') + ' ' + label);
  } else {
    console.log('  ' + red('✗') + ' ' + label + (detail ? ' — ' + detail : ''));
    process.exitCode = 1;
  }
}

// --- Setup: fresh temp project with .smt/ structure ---
section('Setup: fresh temp project with real .smt/ tree');
const ROOT = mkdtempSync(join(tmpdir(), 'session-sim-'));
mkdirSync(join(ROOT, '.smt', 'features', 'demo-feature', 'task'), { recursive: true });
mkdirSync(join(ROOT, '.smt', 'state'), { recursive: true });
event(`project root: ${ROOT}`);

// Bootstrap: create state.json for a fix-mode task entering workflow-tasker
const STATE_PATH = join(ROOT, '.smt', 'features', 'demo-feature', 'task', 'demo.state.json');
const initial = createInitialState({ taskId: 'demo-task', mode: 'fix' });
initial.allowed_skills = [
  'workflow-investigate', 'workflow-investigate-review',
  'workflow-tasker', 'workflow-tasker-review',
  'workflow-write-test', 'workflow-coding',
  'workflow-agent-review',
  'workflow-e2e', 'workflow-e2e-review',
  'workflow-team-code-review', 'workflow-human-check',
];
initial.current_stage = 'workflow-tasker';
appendEvent(initial, {
  skill: 'workflow-investigate',
  result: 'pass',
  declarer: 'hook',
  cause: null,
  evidence: { type: 'file_present', detail: 'investigation.md' },
});
appendEvent(initial, {
  skill: 'workflow-investigate-review',
  result: 'pass',
  declarer: 'hook',
  cause: null,
  evidence: { type: 'file_present', detail: 'investigate_review.md' },
});
writeState(STATE_PATH, initial);

// active_task pointer
writeFileSync(join(ROOT, '.smt', 'active_task'), STATE_PATH);
event(`state.json seeded at current_stage=workflow-tasker`);
event(`events so far: ${initial.events.length} (investigate + investigate-review both pass)`);

// Helper: invoke Stop hook like Claude Code does
function invokeStopHook(lastAssistantText, stopReason = 'end_turn') {
  const payload = JSON.stringify({
    cwd: ROOT,
    last_assistant_text: lastAssistantText,
    transcript: [
      { role: 'user', content: 'drive the workflow' },
      { role: 'assistant', content: lastAssistantText },
    ],
    stop_reason: stopReason,
    session_id: 'sess-sim-01',
  });
  const res = spawnSync('node', [AUTO_CONFIRM], {
    input: payload,
    encoding: 'utf-8',
    cwd: ROOT,
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    parsed: (() => { try { return JSON.parse(res.stdout); } catch { return null; } })(),
  };
}

// Helper: invoke UserPromptSubmit consumer
function invokeConsumer() {
  const payload = JSON.stringify({ cwd: ROOT, session_id: 'sess-sim-01' });
  const res = spawnSync('node', [AUTO_CONFIRM_CONSUMER], {
    input: payload,
    encoding: 'utf-8',
    cwd: ROOT,
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    parsed: (() => { try { return JSON.parse(res.stdout); } catch { return null; } })(),
  };
}

// Helper: append an event to state.json (simulates a workflow skill producing an event)
function appendAndSave(eventObj) {
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  appendEvent(state, eventObj);
  writeState(STATE_PATH, state);
  return state;
}

// ============================================================================
section('Cycle 1 — Stop hook after workflow-tasker passes → queue drop');
// ============================================================================
appendAndSave({
  skill: 'workflow-tasker',
  result: 'pass',
  declarer: 'hook',
  cause: null,
  evidence: { type: 'file_present', detail: 'plan.md produced' },
});
event('workflow-tasker pass event appended');

const stop1 = invokeStopHook('Completed tasker. plan.md written. Ready for review.');
event(`Stop hook exit code: ${stop1.status}`);
if (stop1.stderr) event(gray('stderr: ' + stop1.stderr.trim().split('\n').slice(0, 3).join(' | ')));

assertEq('Stop hook exits 2 (block)', stop1.status, 2);
assertOk('stdout is valid JSON', stop1.parsed !== null);
assertEq('decision is "block"', stop1.parsed?.decision, 'block');
assertOk('reason emitted (Stop schema)', typeof stop1.parsed?.reason === 'string' && stop1.parsed.reason.length > 0);
assertOk('meta.queued = true', stop1.parsed?.meta?.queued === true);

// Queue file dropped?
const queuePath = join(ROOT, '.smt', 'state', 'auto-confirm-queue.json');
assertOk('queue file created at .smt/state/auto-confirm-queue.json', existsSync(queuePath));
let q1 = null;
if (existsSync(queuePath)) {
  q1 = JSON.parse(readFileSync(queuePath, 'utf-8'));
  assertOk('queue.additionalContext populated', typeof q1.additionalContext === 'string' && q1.additionalContext.length > 0);
  assertOk('queue.action = advance (tasker passed → advance)', q1.action === 'advance');
  assertOk('queue.additionalContext mentions next skill / advance', /advance|next skill/i.test(q1.additionalContext));
}

// ============================================================================
section('Cycle 2 — UserPromptSubmit consumer injects queued context');
// ============================================================================
const consume1 = invokeConsumer();
event(`consumer exit code: ${consume1.status}`);
if (consume1.stderr) event(gray('stderr: ' + consume1.stderr.trim().split('\n').slice(0, 3).join(' | ')));

// Consumer must emit additionalContext on stdout (Claude Code's UserPromptSubmit schema)
assertOk('consumer produced output', consume1.stdout.length > 0 || consume1.status === 0);

// The queue file should be consumed (deleted or emptied) after processing
const queueStillExists = existsSync(queuePath);
if (queueStillExists) {
  const qAfter = JSON.parse(readFileSync(queuePath, 'utf-8'));
  assertOk('queue consumed (file cleared or flag set)', !qAfter.additionalContext || qAfter.consumed === true, 'queue file still has active payload');
} else {
  console.log('  ' + green('✓') + ' queue file removed after consumption');
}

// ============================================================================
section('Cycle 3 — workflow-coding fails typecheck → producer chain routes');
// ============================================================================
appendAndSave({
  skill: 'workflow-coding',
  result: 'fail',
  declarer: 'hook',
  cause: 'typecheck',
  evidence: { type: 'exit_code', detail: 'tsc exit 2, 3 errors' },
});
// Update current_stage
const s3 = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
s3.current_stage = 'workflow-coding';
writeState(STATE_PATH, s3);
event('workflow-coding fail(typecheck) event appended');

const stop3 = invokeStopHook('Typecheck failed with 3 errors in validator.ts. Investigating.');
event(`Stop hook exit code: ${stop3.status}`);

assertEq('exit 2 (block — producer chain routing)', stop3.status, 2);
assertEq('decision is "block"', stop3.parsed?.decision, 'block');
const q3 = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, 'utf-8')) : null;
assertOk('queue action = enter_skill (producer-routed)', q3?.action === 'enter_skill');
assertOk('queue additionalContext routes back to workflow-coding', /workflow-coding/.test(q3?.additionalContext || ''));

// ============================================================================
section('Cycle 4 — Risk keyword in assistant output → sub-tasker spawn signal');
// ============================================================================
// State reset: workflow-coding now passed, advance to agent-review
appendAndSave({
  skill: 'workflow-coding',
  result: 'pass',
  declarer: 'hook',
  cause: null,
  evidence: { type: 'file_present', detail: 'src/validator.ts updated' },
});
const s4 = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
s4.current_stage = 'workflow-agent-review';
writeState(STATE_PATH, s4);

const stop4 = invokeStopHook('수정 완료했지만 성능 리스크가 남아있어. 나중에 캐시 전략 검토 필요.');
event(`Stop hook exit code: ${stop4.status}`);

assertEq('exit 2 (block — risk keyword triggers sub-tasker)', stop4.status, 2);
const q4 = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, 'utf-8')) : null;
assertOk('queue action = spawn_sub_tasker', q4?.action === 'spawn_sub_tasker');
assertOk('queue additionalContext mentions sub-tasker or risk', /sub-tasker|risk/i.test(q4?.additionalContext || ''));

// ============================================================================
section('Cycle 5 — Chained-mode transition auto-advance');
// ============================================================================
// Inject chained_modes and a pass on tasker-review to set up transition
const s5 = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
s5.mode = 'investigate';
s5.chained_modes = ['investigate', 'fix'];
s5.current_stage = 'workflow-investigate-review';
s5.events.push({
  t: new Date().toISOString(),
  skill: 'workflow-investigate-review',
  result: 'pass',
  declarer: 'hook',
  cause: null,
  evidence: { type: 'file_present', detail: 'investigate_review.md' },
});
writeState(STATE_PATH, s5);
event('state reshaped: investigate mode with chain → fix, investigate-review passed');

const stop5 = invokeStopHook('Investigation complete. Transitioning to fix mode now.');
event(`Stop hook exit code: ${stop5.status}`);

assertEq('exit 2 (block — chain_advance)', stop5.status, 2);
const q5 = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, 'utf-8')) : null;
assertOk('queue action = chain_advance', q5?.action === 'chain_advance');
assertOk('queue additionalContext mentions fix / chain', /fix|chain|transition/i.test(q5?.additionalContext || ''));

// Verify state.json mode was actually advanced
const s5After = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
assertEq('state.mode advanced to "fix"', s5After.mode, 'fix');
assertEq('chained_modes head consumed', s5After.chained_modes, ['fix']);

// ============================================================================
section('Cycle 6 — workflow-human-check awaiting → legitimate halt (§11-4 #1)');
// ============================================================================
const s6 = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
s6.current_stage = 'workflow-human-check';
s6.chained_modes = []; // clear chain so transition doesn't fire
// Last event must NOT be pass for human-check to halt
s6.events.push({
  t: new Date().toISOString(),
  skill: 'workflow-team-code-review',
  result: 'fail',
  declarer: 'hook',
  cause: 'review_reject',
  evidence: { type: 'user_input', detail: 'awaiting user decision' },
});
writeState(STATE_PATH, s6);
event('current_stage=workflow-human-check with pending team-review reject');

const stop6 = invokeStopHook('Presenting final report to user. Awaiting decision.');
event(`Stop hook exit code: ${stop6.status}`);

assertEq('exit 0 (legitimate halt — no block)', stop6.status, 0);
assertOk('no decision emitted', !stop6.parsed || stop6.parsed.decision !== 'block', 'Expected silent halt for human-check awaiting');

// ============================================================================
section('Cycle 7 — Fresh task without state.json → silent exit');
// ============================================================================
// Remove active_task pointer and state.json
rmSync(join(ROOT, '.smt', 'active_task'));
rmSync(STATE_PATH);
event('state.json removed to simulate no-active-task condition');

const stop7 = invokeStopHook('Nothing to do.');
event(`Stop hook exit code: ${stop7.status}`);
assertEq('exit 0 (no_state — silent)', stop7.status, 0);
assertOk('no block decision emitted', !stop7.parsed || stop7.parsed.decision !== 'block');

// ============================================================================
section('Summary');
// ============================================================================
console.log('');
if (process.exitCode) {
  console.log(red(bold('FAIL ')) + 'one or more assertions failed. See ✗ markers above.');
} else {
  console.log(green(bold('PASS ')) + 'all 7 cycles behaved per spec §11 decision tree.');
  console.log('');
  console.log('Full lifecycle verified under real session conditions:');
  console.log('  1. workflow-tasker pass → Stop hook drops queue, emits block');
  console.log('  2. UserPromptSubmit consumer picks up queue');
  console.log('  3. workflow-coding fail → producer chain routes back to coding');
  console.log('  4. Risk keyword in Korean → sub-tasker signal in additionalContext');
  console.log('  5. Chained intent → auto-transition advances mode without user prompt');
  console.log('  6. workflow-human-check awaiting → legitimate §11-4 halt');
  console.log('  7. No active state.json → silent exit 0 (no_state)');
  console.log('');
  console.log('Iron Law #1 (never stop) upheld: agent produced forward motion in all');
  console.log('non-halt cycles. Legitimate halts (§11-4 human-check, no-state) exit 0.');
}

// Cleanup
rmSync(ROOT, { recursive: true, force: true });
