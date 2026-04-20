#!/usr/bin/env node
/**
 * stop-stage-enforcer.test.mjs — real-interface tests via stdin/stdout/exit.
 *
 * Exercises the renamed + extended Stop hook:
 *   - workflow mode (fix/implement/plan) + non-terminal stage → block
 *   - terminal stage (workflow-human-check / done / mode terminal) → continue
 *   - mid-flow stall (tracked changes + no terminal signal) → block w/ resume hint
 *   - non-Smelter project / verify / simple_fix / investigate → continue
 *   - legacy E2E reminder format preserved when summary.e2e_required + workflow-e2e is next
 *
 * Run: node scripts/stop-stage-enforcer.test.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  rmSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, 'stop-stage-enforcer.mjs');

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
    failures.push({ label, message: err.message, stack: err.stack });
    console.log(`  FAIL  ${label}`);
    console.log(`        ${err.message}`);
  }
}

function trackingPathFor(projectDir) {
  const hash = createHash('md5').update(projectDir).digest('hex').slice(0, 8);
  return `/tmp/smelter-session-files-${hash}.json`;
}

function setupProject({
  state = null,
  summary = null,
  trackedFiles = null,
  sessionId = null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sse-'));
  // Always create .smt root so non-Smelter test can omit it
  if (state || summary) {
    const slug = 'feat-x';
    const taskDir = join(dir, '.smt', 'features', slug, 'task');
    mkdirSync(taskDir, { recursive: true });
    if (state) {
      const statePath = join(taskDir, `${slug}.state.json`);
      writeFileSync(statePath, JSON.stringify(state, null, 2));
      const stateRoot = join(dir, '.smt', 'state');
      mkdirSync(stateRoot, { recursive: true });
      // Session-isolated pointer: prefer per-session when sessionId provided,
      // else non-scoped fallback. Global `.smt/active_task` is no longer
      // written (migration 2026-04-20).
      const pointerName = sessionId ? `active-feature-${sessionId}.json` : 'active-feature.json';
      writeFileSync(
        join(stateRoot, pointerName),
        JSON.stringify({ slug, session_id: sessionId || '', updated_at: Date.now() }),
      );
    }
    if (summary) {
      const summaryDir = join(dir, '.smt', 'features', slug, 'state');
      mkdirSync(summaryDir, { recursive: true });
      writeFileSync(
        join(summaryDir, 'summary.json'),
        JSON.stringify(summary, null, 2),
      );
    }
  }
  if (trackedFiles) {
    writeFileSync(trackingPathFor(dir), JSON.stringify(trackedFiles));
  }
  return dir;
}

function loopCounterPathFor(projectDir, sessionId) {
  const projectHash = createHash('md5').update(projectDir).digest('hex').slice(0, 8);
  const sessHash = sessionId
    ? createHash('md5').update(String(sessionId)).digest('hex').slice(0, 8)
    : 'no-session';
  return `/tmp/smelter-stop-loop-${projectHash}-${sessHash}.json`;
}

function tearDown(dir, sessionId) {
  try { unlinkSync(trackingPathFor(dir)); } catch {}
  try { unlinkSync(loopCounterPathFor(dir, sessionId)); } catch {}
  try { unlinkSync(loopCounterPathFor(dir, null)); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

function runHook(payload, cwd) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function parseStdout(res) {
  try { return JSON.parse(res.stdout); }
  catch { throw new Error(`stdout not JSON: ${res.stdout}\nstderr: ${res.stderr}`); }
}

function makeState({ mode, current_stage, completed_stages = [], allowed_skills }) {
  return {
    schema_version: '2.4.1',
    task_id: 'feat-x',
    mode,
    chained_modes: [],
    allowed_skills,
    current_stage,
    completed_stages,
    created_at: '2026-04-20T00:00:00.000Z',
    updated_at: '2026-04-20T00:00:00.000Z',
    target_type: null,
    surface: [],
    exempt: { tdd: false, e2e: false },
    team_runtime: {},
    events: [],
    test_cycles: [],
    active_feedback: [],
    sub_tasks: [],
  };
}

const FIX_ALLOWED = [
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

console.log('\n[stage enforcement — workflow modes]');

test('C1 fix mid-flow (coding stage, missing review/e2e/human-check) → block + advance', () => {
  const state = makeState({
    mode: 'fix',
    current_stage: 'workflow-coding',
    completed_stages: ['workflow-investigate', 'workflow-tasker', 'workflow-write-test'],
    allowed_skills: FIX_ALLOWED,
  });
  const dir = setupProject({ state, trackedFiles: ['scripts/foo.mjs'] });
  try {
    const res = runHook({ cwd: dir }, dir);
    const out = parseStdout(res);
    assert.equal(out.decision, 'block', 'must block on non-terminal coding stage');
    assert.match(out.reason, /workflow-agent-review|advance/i, 'reason must hint next stage');
  } finally { tearDown(dir); }
});

test('C2 fix at workflow-human-check stage → continue (terminal)', () => {
  const state = makeState({
    mode: 'fix',
    current_stage: 'workflow-human-check',
    completed_stages: FIX_ALLOWED.slice(0, -1),
    allowed_skills: FIX_ALLOWED,
  });
  const dir = setupProject({ state });
  try {
    const res = runHook({ cwd: dir }, dir);
    const out = parseStdout(res);
    assert.equal(out.continue, true, 'human-check stage must let Stop pass');
  } finally { tearDown(dir); }
});

test('C3 fix done → continue', () => {
  const state = makeState({
    mode: 'fix',
    current_stage: 'done',
    completed_stages: FIX_ALLOWED,
    allowed_skills: FIX_ALLOWED,
  });
  const dir = setupProject({ state });
  try {
    const res = runHook({ cwd: dir }, dir);
    const out = parseStdout(res);
    assert.equal(out.continue, true);
  } finally { tearDown(dir); }
});

test('C4 implement mode + missing E2E → block + advance to workflow-e2e', () => {
  const state = makeState({
    mode: 'implement',
    current_stage: 'workflow-agent-review',
    completed_stages: [
      'workflow-investigate', 'workflow-tasker', 'workflow-write-test',
      'workflow-coding',
    ],
    allowed_skills: FIX_ALLOWED, // implement uses same chain
  });
  const dir = setupProject({ state, trackedFiles: ['scripts/foo.mjs'] });
  try {
    const res = runHook({ cwd: dir }, dir);
    const out = parseStdout(res);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /workflow-e2e/);
  } finally { tearDown(dir); }
});

test('C5 simple_fix mode + workflow-coding → continue (terminal for that mode)', () => {
  const state = makeState({
    mode: 'simple_fix',
    current_stage: 'workflow-coding',
    completed_stages: [],
    allowed_skills: ['workflow-coding'],
  });
  const dir = setupProject({ state, trackedFiles: ['scripts/foo.mjs'] });
  try {
    const res = runHook({ cwd: dir }, dir);
    const out = parseStdout(res);
    assert.equal(out.continue, true, 'simple_fix terminal must not block');
  } finally { tearDown(dir); }
});

test('C6 verify mode → continue (not a workflow_mode for stage guard)', () => {
  const state = makeState({
    mode: 'verify',
    current_stage: 'workflow-verify',
    completed_stages: [],
    allowed_skills: ['workflow-verify'],
  });
  const dir = setupProject({ state, trackedFiles: ['scripts/foo.mjs'] });
  try {
    const res = runHook({ cwd: dir }, dir);
    const out = parseStdout(res);
    assert.equal(out.continue, true);
  } finally { tearDown(dir); }
});

test('C7 investigate mode at terminal → continue', () => {
  const state = makeState({
    mode: 'investigate',
    current_stage: 'workflow-investigate-review',
    completed_stages: ['workflow-investigate'],
    allowed_skills: ['workflow-investigate', 'workflow-investigate-review'],
  });
  const dir = setupProject({ state });
  try {
    const res = runHook({ cwd: dir }, dir);
    const out = parseStdout(res);
    assert.equal(out.continue, true);
  } finally { tearDown(dir); }
});

test('C8 non-Smelter project (no .smt) → continue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sse-'));
  try {
    const res = runHook({ cwd: dir }, dir);
    const out = parseStdout(res);
    assert.equal(out.continue, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('C9 mid-flow stall: fix coding stage + tracked changes → block w/ mid-flow hint', () => {
  const state = makeState({
    mode: 'fix',
    current_stage: 'workflow-coding',
    completed_stages: ['workflow-investigate', 'workflow-tasker', 'workflow-write-test'],
    allowed_skills: FIX_ALLOWED,
  });
  const dir = setupProject({ state, trackedFiles: ['scripts/foo.mjs', 'src/bar.ts'] });
  try {
    const res = runHook({ cwd: dir }, dir);
    const out = parseStdout(res);
    assert.equal(out.decision, 'block');
    // Reason should reference mid-flow OR the next stage with tracked-files hint
    assert.match(out.reason, /mid-flow|tracked|advance/i);
  } finally { tearDown(dir); }
});

test('C10 legacy E2E reminder format preserved when summary.e2e_required + next is workflow-e2e', () => {
  const state = makeState({
    mode: 'implement',
    current_stage: 'workflow-coding',
    completed_stages: [
      'workflow-investigate', 'workflow-tasker', 'workflow-write-test',
    ],
    allowed_skills: FIX_ALLOWED,
  });
  const summary = { e2e_required: true, e2e_done: false, status: 'in_progress' };
  const dir = setupProject({ state, summary, trackedFiles: ['scripts/foo.mjs'] });
  try {
    const res = runHook({ cwd: dir }, dir);
    const out = parseStdout(res);
    assert.equal(out.decision, 'block');
    // Either legacy "[E2E]" or new "[Stage]" — both must mention next workflow step
    assert.match(out.reason, /\[E2E\]|\[Stage\]/);
  } finally { tearDown(dir); }
});

test('C11 plan mode at workflow-tasker-review (terminal for plan) → continue', () => {
  const state = makeState({
    mode: 'plan',
    current_stage: 'workflow-tasker-review',
    completed_stages: [
      'workflow-brainstorm', 'workflow-brainstorm-review',
      'workflow-investigate', 'workflow-investigate-review', 'workflow-tasker',
    ],
    allowed_skills: [
      'workflow-brainstorm', 'workflow-brainstorm-review',
      'workflow-investigate', 'workflow-investigate-review',
      'workflow-tasker', 'workflow-tasker-review',
    ],
  });
  const dir = setupProject({ state });
  try {
    const res = runHook({ cwd: dir }, dir);
    const out = parseStdout(res);
    assert.equal(out.continue, true, 'plan mode terminal must not block');
  } finally { tearDown(dir); }
});

console.log('\n[session-aware active-state resolution]');

test('C12 per-session pointer isolates sessions (concurrent-session safety)', () => {
  // Set up: non-scoped pointer points to feature A (terminal). Per-session
  // pointer for sessionId X points to feature B (mid-flow). The hook must read
  // feature B's state (mid-flow) and BLOCK; it must NOT fall back to the
  // non-scoped pointer when the per-session one exists — that would let a
  // concurrent session's write swap this session's chain target.
  const dir = mkdtempSync(join(tmpdir(), 'sse-'));
  const sessionId = 'sess-X';
  try {
    const stateRoot = join(dir, '.smt', 'state');
    mkdirSync(stateRoot, { recursive: true });

    // Feature A — non-scoped pointer target, terminal stage (would pass)
    const slugA = 'feat-a-terminal';
    const taskDirA = join(dir, '.smt', 'features', slugA, 'task');
    mkdirSync(taskDirA, { recursive: true });
    const stateA = makeState({
      mode: 'fix',
      current_stage: 'workflow-human-check',
      completed_stages: FIX_ALLOWED.slice(0, -1),
      allowed_skills: FIX_ALLOWED,
    });
    writeFileSync(join(taskDirA, `${slugA}.state.json`), JSON.stringify(stateA, null, 2));
    writeFileSync(
      join(stateRoot, 'active-feature.json'),
      JSON.stringify({ slug: slugA, session_id: '', updated_at: Date.now() }),
    );

    // Feature B — per-session target, mid-flow (should block)
    const slugB = 'feat-b-midflow';
    const taskDirB = join(dir, '.smt', 'features', slugB, 'task');
    mkdirSync(taskDirB, { recursive: true });
    const stateB = makeState({
      mode: 'fix',
      current_stage: 'workflow-coding',
      completed_stages: ['workflow-investigate', 'workflow-tasker', 'workflow-write-test'],
      allowed_skills: FIX_ALLOWED,
    });
    writeFileSync(join(taskDirB, `${slugB}.state.json`), JSON.stringify(stateB, null, 2));
    writeFileSync(
      join(stateRoot, `active-feature-${sessionId}.json`),
      JSON.stringify({ slug: slugB, session_id: sessionId, updated_at: Date.now() }),
    );

    const res = runHook({ cwd: dir, session_id: sessionId }, dir);
    const out = parseStdout(res);
    assert.equal(out.decision, 'block', 'must read per-session feature B (mid-flow), not non-scoped feature A (terminal)');
    assert.match(out.reason, /workflow-agent-review|advance/i);
  } finally { tearDown(dir); }
});

test('C13 no per-session pointer AND no non-scoped pointer → state=null → continue', () => {
  // Post-migration: deprecating `.smt/active_task` means a session without
  // a matching per-session pointer (and without a non-scoped fallback) sees
  // no active state at all. Stop allows. Prior to migration, `.smt/active_task`
  // would catch this case; the semantic has intentionally inverted.
  const dir = mkdtempSync(join(tmpdir(), 'sse-'));
  mkdirSync(join(dir, '.smt'), { recursive: true });
  try {
    const res = runHook({ cwd: dir, session_id: 'sess-no-pointer' }, dir);
    const out = parseStdout(res);
    assert.equal(out.continue, true, 'no pointer for session → no active state → Stop allows');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log('\n[stuck-loop escape]');

test('C14 same-state block 3x consecutively → escape on 3rd Stop (continue + warning)', () => {
  // Repro of the 2026-04-20 infinite-loop incident from the other session:
  // mode=fix, current_stage=null, agent produces only text → Stop never advances.
  const state = makeState({
    mode: 'fix',
    current_stage: null,
    completed_stages: [],
    allowed_skills: FIX_ALLOWED,
  });
  const sessionId = 'sess-loop-test';
  const dir = setupProject({ state, sessionId });
  try {
    // Block 1
    let res = runHook({ cwd: dir, session_id: sessionId }, dir);
    let out = parseStdout(res);
    assert.equal(out.decision, 'block', '1st same-state Stop must block');
    // Block 2
    res = runHook({ cwd: dir, session_id: sessionId }, dir);
    out = parseStdout(res);
    assert.equal(out.decision, 'block', '2nd same-state Stop must block');
    // Block 3 → escape
    res = runHook({ cwd: dir, session_id: sessionId }, dir);
    out = parseStdout(res);
    assert.equal(out.continue, true, '3rd consecutive same-state Stop must escape (continue)');
    assert.match(out.systemMessage || '', /stuck-loop/i, 'escape must include stuck-loop warning');
  } finally { tearDown(dir, sessionId); }
});

test('C15 state change between Stops resets loop counter', () => {
  const stateA = makeState({
    mode: 'fix', current_stage: null, completed_stages: [], allowed_skills: FIX_ALLOWED,
  });
  const sessionId = 'sess-reset-test';
  const dir = setupProject({ state: stateA, sessionId });
  try {
    // Block 1 (signature A)
    let res = runHook({ cwd: dir, session_id: sessionId }, dir);
    assert.equal(parseStdout(res).decision, 'block');
    // Block 2 (signature A)
    res = runHook({ cwd: dir, session_id: sessionId }, dir);
    assert.equal(parseStdout(res).decision, 'block');
    // State changes (simulate skill-stage-transition writing new state)
    const slug = 'feat-x';
    const statePath = join(dir, '.smt', 'features', slug, 'task', `${slug}.state.json`);
    const stateB = makeState({
      mode: 'fix',
      current_stage: 'workflow-investigate',
      completed_stages: [],
      allowed_skills: FIX_ALLOWED,
    });
    writeFileSync(statePath, JSON.stringify(stateB, null, 2));
    // Block 3 — different signature, must still block (counter reset to 1)
    res = runHook({ cwd: dir, session_id: sessionId }, dir);
    const out = parseStdout(res);
    assert.equal(out.decision, 'block', 'state change must reset counter — 3rd Stop on new signature still blocks');
  } finally { tearDown(dir, sessionId); }
});

console.log('\n[broadened workflow-mode coverage]');

test('C16 investigate mode at workflow-investigate (non-terminal) → block + advance', () => {
  const state = makeState({
    mode: 'investigate',
    current_stage: 'workflow-investigate',
    completed_stages: [],
    allowed_skills: ['workflow-investigate', 'workflow-investigate-review'],
  });
  const dir = setupProject({ state });
  try {
    const res = runHook({ cwd: dir }, dir);
    const out = parseStdout(res);
    assert.equal(out.decision, 'block', 'investigate non-terminal stage must block');
    assert.match(out.reason, /workflow-investigate-review/, 'must advance to review stage');
  } finally { tearDown(dir); }
});

test('C17 summary is resolved via per-session pointer when sessionId provided', () => {
  // Two features: feature-A (non-scoped) has e2e_required=true; feature-B
  // (per-session) has e2e_required=false. The hook must use feature-B's
  // summary when sessionId is provided, NOT accidentally hit feature-A's.
  const dir = mkdtempSync(join(tmpdir(), 'sse-'));
  const sessionId = 'sess-summary-iso';
  try {
    const stateRoot = join(dir, '.smt', 'state');
    mkdirSync(stateRoot, { recursive: true });

    // Non-scoped → feature-A with e2e_required summary
    const slugA = 'feat-a-nonscope';
    mkdirSync(join(dir, '.smt', 'features', slugA, 'task'), { recursive: true });
    mkdirSync(join(dir, '.smt', 'features', slugA, 'state'), { recursive: true });
    const stateA = makeState({
      mode: 'implement', current_stage: 'workflow-coding',
      completed_stages: ['workflow-investigate', 'workflow-tasker', 'workflow-write-test'],
      allowed_skills: FIX_ALLOWED,
    });
    writeFileSync(join(dir, '.smt', 'features', slugA, 'task', `${slugA}.state.json`), JSON.stringify(stateA));
    writeFileSync(join(dir, '.smt', 'features', slugA, 'state', 'summary.json'), JSON.stringify({ e2e_required: true, e2e_done: false, status: 'in_progress' }));
    writeFileSync(join(stateRoot, 'active-feature.json'), JSON.stringify({ slug: slugA }));

    // Per-session → feature-B with no e2e_required
    const slugB = 'feat-b-session';
    mkdirSync(join(dir, '.smt', 'features', slugB, 'task'), { recursive: true });
    mkdirSync(join(dir, '.smt', 'features', slugB, 'state'), { recursive: true });
    const stateB = makeState({
      mode: 'fix', current_stage: 'workflow-coding',
      completed_stages: ['workflow-investigate', 'workflow-tasker', 'workflow-write-test'],
      allowed_skills: FIX_ALLOWED,
    });
    writeFileSync(join(dir, '.smt', 'features', slugB, 'task', `${slugB}.state.json`), JSON.stringify(stateB));
    writeFileSync(join(dir, '.smt', 'features', slugB, 'state', 'summary.json'), JSON.stringify({ e2e_required: false, status: 'in_progress' }));
    writeFileSync(join(stateRoot, `active-feature-${sessionId}.json`), JSON.stringify({ slug: slugB }));

    writeFileSync(trackingPathFor(dir), JSON.stringify(['scripts/foo.mjs']));
    const res = runHook({ cwd: dir, session_id: sessionId }, dir);
    const out = parseStdout(res);
    assert.equal(out.decision, 'block', 'B is non-terminal → must block');
    assert.doesNotMatch(out.reason, /\[E2E\]/, 'must NOT use feature-A summary (no [E2E] tag)');
  } finally {
    try { unlinkSync(trackingPathFor(dir)); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log('');
console.log(`stop-stage-enforcer: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}: ${f.message}`);
  process.exit(1);
}
