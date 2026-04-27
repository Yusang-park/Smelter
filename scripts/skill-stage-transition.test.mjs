#!/usr/bin/env node
/**
 * skill-stage-transition.test.mjs — PostToolUse Skill→stage transition.
 * Feature: harness-integrity-4-fixes T3
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialState } from './state-schema.mjs';

const SCRIPT = join(process.cwd(), 'scripts', 'skill-stage-transition.mjs');

const SKILL_ARTIFACT = {
  'workflow-brainstorm': 'brainstorm.md',
  'workflow-brainstorm-review': 'brainstorm-review.md',
  'workflow-investigate': 'investigation.md',
  'workflow-investigate-review': 'investigation-review.md',
  'workflow-tasker': 'tasks.md',
  'workflow-tasker-review': 'tasks-review.md',
};

function seedState(cwd, { mode = 'explore', slug = 'feat', sessionId = 't3' } = {}) {
  const taskDir = join(cwd, '.smt', 'features', slug, 'task');
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(join(cwd, '.smt', 'state'), { recursive: true });
  const statePath = join(taskDir, `${slug}.state.json`);
  const state = createInitialState({ taskId: slug, mode });
  state.allowed_skills = { explore: ['workflow-investigate', 'workflow-investigate-review'],
    fix: ['workflow-investigate', 'workflow-coding', 'workflow-agent-review', 'workflow-e2e', 'workflow-human-check'],
    brainstorm: ['workflow-investigate', 'workflow-investigate-review', 'workflow-brainstorm', 'workflow-brainstorm-review', 'workflow-tasker'],
    implement: ['workflow-coding', 'workflow-e2e'],
    verify: ['workflow-verify', 'workflow-e2e', 'workflow-human-check'],
  }[mode] || [];
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  // Session-isolated pointer (post-migration). `.smt/active_task` no longer
  // read by consumers — write per-session pointer instead.
  const pointerName = sessionId ? `active-feature-${sessionId}.json` : 'active-feature.json';
  writeFileSync(
    join(cwd, '.smt', 'state', pointerName),
    JSON.stringify({ slug, session_id: sessionId || '', updated_at: Date.now() }),
    'utf-8',
  );
  return statePath;
}

// Pre-create the artifact file that skill-stage-transition expects so the
// hook will mark the stage complete instead of deferring.
function seedArtifact(statePath, skill, content = '# artifact\n') {
  const name = SKILL_ARTIFACT[skill];
  if (!name) return null;
  const taskDir = join(statePath, '..');
  const artifactPath = join(taskDir, name);
  writeFileSync(artifactPath, content, 'utf-8');
  return artifactPath;
}

function runTransition({ cwd, skill, sessionId = 't3' }) {
  const payload = JSON.stringify({
    cwd, ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    tool_name: 'Skill',
    tool_input: { skill },
    tool_response: 'ok',
  });
  return spawnSync(process.execPath, [SCRIPT], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, SMT_HOOK_WRITE: '1' },
  });
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

const VALID_TASKS_V052 = `---
schema_version: "0.51"
target_type: bug_fix
---

# tasks

- [x] goal: fix behavior
- [x] approach: minimal guarded change
- [ ] queue: add RED test, patch source, run checks
- [x] works: acceptance path named
- [x] omissions: no reviewed feature omitted
- [x] verified: test/typecheck/e2e commands listed
- [x] team_runtime: write-test=A, coding=A, agent-review=B, e2e=A
`;

const VALID_TASK_REVIEW_V052 = `---
schema_version: "0.51"
verdict: pass
consensus: 0.95
---

# tasks-review

- [x] works: queue covers expected behavior
- [x] omissions: no feature or review concern is missing
- [x] verified: validation commands are named
- [x] side_effects: none beyond scoped surface
- [x] decision: pass
`;

// ── Happy path ─────────────────────────────────────────────────────────────
test('T3-H1: workflow-investigate with artifact → completed_stages append', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-h1-'));
  try {
    const sp = seedState(cwd, { mode: 'explore' });
    seedArtifact(sp, 'workflow-investigate');
    const r = runTransition({ cwd, skill: 'workflow-investigate' });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const state = readState(sp);
    assert.equal(state.current_stage, 'workflow-investigate');
    assert.ok(state.completed_stages.includes('workflow-investigate'));
    assert.ok(state.events.some(e => e.skill === 'workflow-investigate' && e.result === 'pass' && e.evidence?.path));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T3-H2: workflow-investigate WITHOUT artifact → current_stage only, defers completion', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-h2-'));
  try {
    const sp = seedState(cwd, { mode: 'explore' });
    // Note: no artifact file written
    runTransition({ cwd, skill: 'workflow-investigate' });
    const state = readState(sp);
    assert.equal(state.current_stage, 'workflow-investigate', 'stage entered');
    assert.ok(!state.completed_stages.includes('workflow-investigate'), 'must NOT mark complete without artifact');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T3-H3: workflow-tasker requires v0.51 compact checklist before completion', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-h3-'));
  try {
    const sp = seedState(cwd, { mode: 'fix' });
    const state = readState(sp);
    state.allowed_skills = ['workflow-investigate', 'workflow-investigate-review', 'workflow-tasker', 'workflow-tasker-review'];
    writeFileSync(sp, JSON.stringify(state, null, 2), 'utf-8');
    seedArtifact(sp, 'workflow-tasker', '# legacy prose\n');

    const r = runTransition({ cwd, skill: 'workflow-tasker' });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const after = readState(sp);
    assert.equal(after.current_stage, 'workflow-tasker');
    assert.ok(!after.completed_stages.includes('workflow-tasker'));
    assert.ok(!after.events.some(e => e.skill === 'workflow-tasker' && e.result === 'pass'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T3-H4: workflow-tasker-review requires v0.51 review checklist before completion', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-h4-'));
  try {
    const sp = seedState(cwd, { mode: 'fix' });
    const state = readState(sp);
    state.allowed_skills = ['workflow-investigate', 'workflow-investigate-review', 'workflow-tasker', 'workflow-tasker-review'];
    writeFileSync(sp, JSON.stringify(state, null, 2), 'utf-8');
    seedArtifact(sp, 'workflow-tasker', VALID_TASKS_V052);
    seedArtifact(sp, 'workflow-tasker-review', VALID_TASK_REVIEW_V052);

    const r = runTransition({ cwd, skill: 'workflow-tasker-review' });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const after = readState(sp);
    assert.ok(after.completed_stages.includes('workflow-tasker-review'));
    assert.ok(after.events.some(e => e.skill === 'workflow-tasker-review' && e.result === 'pass'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Boundary: exception list ───────────────────────────────────────────────
test('T3-B1: workflow-e2e does NOT auto-complete (requires pass event)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-b1-'));
  try {
    const sp = seedState(cwd, { mode: 'fix' });
    runTransition({ cwd, skill: 'workflow-e2e' });
    const state = readState(sp);
    assert.equal(state.current_stage, 'workflow-e2e', 'current_stage set');
    assert.ok(!state.completed_stages.includes('workflow-e2e'), 'must NOT auto-complete');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T3-B2: workflow-human-check does NOT auto-complete', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-b2-'));
  try {
    const sp = seedState(cwd, { mode: 'fix' });
    runTransition({ cwd, skill: 'workflow-human-check' });
    const state = readState(sp);
    assert.ok(!state.completed_stages.includes('workflow-human-check'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T3-B3: workflow-agent-review in exception list — current_stage only', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-b3-'));
  try {
    const sp = seedState(cwd, { mode: 'fix' });
    runTransition({ cwd, skill: 'workflow-agent-review' });
    const state = readState(sp);
    assert.ok(!state.completed_stages.includes('workflow-agent-review'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T3-B4: workflow-write-test adopts pre-existing dirty source+test changes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-b4-'));
  try {
    spawnSync('git', ['init'], { cwd, encoding: 'utf8' });
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'bug.ts'), 'export const bug = true;\n');
    writeFileSync(join(cwd, 'src', 'bug.test.ts'), 'import { bug } from "./bug";\n');
    const sp = seedState(cwd, { mode: 'fix' });
    const state = readState(sp);
    state.allowed_skills = ['workflow-investigate', 'workflow-write-test', 'workflow-coding'];
    writeFileSync(sp, JSON.stringify(state, null, 2), 'utf-8');

    const r = runTransition({ cwd, skill: 'workflow-write-test' });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const after = readState(sp);
    assert.equal(after.current_stage, 'workflow-write-test');
    assert.ok(after.events.some(e => e.type === 'tdd_adopted' && e.skill === 'workflow-write-test'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T3-B5: workflow-write-test records TDD exemption for design/text target', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-b5-'));
  try {
    const sp = seedState(cwd, { mode: 'fix' });
    const state = readState(sp);
    state.target_type = 'design';
    state.allowed_skills = ['workflow-investigate', 'workflow-write-test', 'workflow-coding'];
    writeFileSync(sp, JSON.stringify(state, null, 2), 'utf-8');

    const r = runTransition({ cwd, skill: 'workflow-write-test' });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const after = readState(sp);
    assert.ok(after.events.some(e => e.type === 'tdd_exempt' && e.skill === 'workflow-write-test'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T3-B6: workflow-write-test records TDD exemption for CSS/style surface', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-b6-'));
  try {
    const sp = seedState(cwd, { mode: 'fix' });
    const state = readState(sp);
    state.surface = ['src/app.css'];
    state.allowed_skills = ['workflow-investigate', 'workflow-write-test', 'workflow-coding'];
    writeFileSync(sp, JSON.stringify(state, null, 2), 'utf-8');

    const r = runTransition({ cwd, skill: 'workflow-write-test' });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const after = readState(sp);
    assert.ok(after.events.some(e => e.type === 'tdd_exempt' && e.skill === 'workflow-write-test' && /style|css/i.test(e.evidence?.summary || '')));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Error path ─────────────────────────────────────────────────────────────
test('T3-E1: skill not in mode allowed_skills → warn, no mutation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-e1-'));
  try {
    const sp = seedState(cwd, { mode: 'explore' });
    const before = readState(sp);
    runTransition({ cwd, skill: 'workflow-coding' });
    const after = readState(sp);
    assert.deepEqual(after.completed_stages, before.completed_stages, 'no state change for disallowed');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T3-E2: no active state → no crash, noop', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-e2-'));
  try {
    const r = runTransition({ cwd, skill: 'workflow-investigate' });
    assert.notEqual(r.status, 2, 'should not emit block');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Edge case ──────────────────────────────────────────────────────────────
test('T3-C1: duplicate invocation is idempotent (no double-append)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-c1-'));
  try {
    const sp = seedState(cwd, { mode: 'explore' });
    seedArtifact(sp, 'workflow-investigate');
    runTransition({ cwd, skill: 'workflow-investigate' });
    runTransition({ cwd, skill: 'workflow-investigate' });
    const state = readState(sp);
    const count = state.completed_stages.filter(s => s === 'workflow-investigate').length;
    assert.equal(count, 1, `expected 1 occurrence, got ${count}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T3-C2: non-Skill tool call is ignored', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-c2-'));
  try {
    const sp = seedState(cwd, { mode: 'explore' });
    const payload = JSON.stringify({
      cwd, tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    });
    const r = spawnSync(process.execPath, [SCRIPT], { input: payload, encoding: 'utf8', env: { ...process.env, SMT_HOOK_WRITE: '1' } });
    assert.equal(r.status, 0);
    const state = readState(sp);
    assert.deepEqual(state.completed_stages, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Integration ────────────────────────────────────────────────────────────
test('T3-I1: sequential skill invocations build completed_stages in order', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-i1-'));
  try {
    const sp = seedState(cwd, { mode: 'explore' });
    seedArtifact(sp, 'workflow-investigate');
    seedArtifact(sp, 'workflow-investigate-review');
    runTransition({ cwd, skill: 'workflow-investigate' });
    runTransition({ cwd, skill: 'workflow-investigate-review' });
    const state = readState(sp);
    assert.deepEqual(state.completed_stages, ['workflow-investigate', 'workflow-investigate-review']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Security hardening ─────────────────────────────────────────────────────
// Post-migration the attack surface moved from `.smt/active_task` (file path
// redirect) to the per-session pointer's `slug` field (slug → path construction).
// Containment + canonical-shape checks must still reject adversarial values.
test('T3-S1: per-session pointer with traversal slug escaping cwd is rejected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-s1-'));
  try {
    const sp = seedState(cwd, { mode: 'explore' });
    seedArtifact(sp, 'workflow-investigate');
    // Forge per-session pointer with a slug that resolves outside cwd
    const forgedOutside = join(tmpdir(), `forged-${Date.now()}.state.json`);
    writeFileSync(forgedOutside, readFileSync(sp, 'utf-8'));
    // `../../../tmp/...` → join() normalizes to an absolute path outside cwd
    writeFileSync(
      join(cwd, '.smt', 'state', 'active-feature-t3.json'),
      JSON.stringify({ slug: `../../${forgedOutside.replace(/^.*\/tmp\//, 'tmp-escape-')}`, session_id: 't3', updated_at: Date.now() }),
    );
    runTransition({ cwd, skill: 'workflow-investigate' });
    const forgedAfter = JSON.parse(readFileSync(forgedOutside, 'utf-8'));
    assert.equal(forgedAfter.current_stage, null, 'outside-cwd state must not be mutated');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Entry-command stage seeding (workflow chain enforcement) ───────────────
// When the main agent invokes an entry command skill (brainstorm / fix / investigate /
// implement / verify) the hook must set current_stage
// to the mode's entry_skill WITHOUT writing to completed_stages, so Iron
// Law #5 is not violated but Stop hook no longer loops on a seeded entry.
test('ST-E1: Skill(skill="fix") in fix-mode state sets current_stage=workflow-investigate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'st-e1-'));
  try {
    const sp = seedState(cwd, { mode: 'fix' });
    const r = runTransition({ cwd, skill: 'fix' });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const state = readState(sp);
    assert.equal(state.current_stage, 'workflow-investigate', 'entry_skill must be seeded into current_stage');
    assert.deepEqual(state.completed_stages, [], 'completed_stages must remain empty (Iron Law #5)');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('ST-E2: repeated entry-command invocation is idempotent', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'st-e2-'));
  try {
    const sp = seedState(cwd, { mode: 'explore' });
    runTransition({ cwd, skill: 'explore' });
    runTransition({ cwd, skill: 'explore' });
    const state = readState(sp);
    assert.equal(state.current_stage, 'workflow-investigate');
    assert.deepEqual(state.completed_stages, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('ST-E2b: slash-prefixed entry command is normalized and advances v0.4 step', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'st-e2b-'));
  try {
    const sp = seedState(cwd, { mode: 'implement' });
    const state = readState(sp);
    state.user_mode = 'implement';
    state.task_type = 'write';
    state.step = 'INTENT';
    state.step_flow = ['INTENT', 'DISCOVERY', 'PLAN', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE'];
    state.allowed_actions = ['classify_intent'];
    state.allowed_skills = ['workflow-investigate', 'workflow-implementation-plan', 'workflow-write-test', 'workflow-coding'];
    writeFileSync(sp, JSON.stringify(state, null, 2));

    const r = runTransition({ cwd, skill: '/implement' });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const after = readState(sp);
    assert.equal(after.current_stage, 'workflow-investigate');
    assert.equal(after.step, 'DISCOVERY');
    assert.deepEqual(after.completed_stages, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('ST-E2c: entry command advances v0.4 step even when current_stage is already seeded', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'st-e2c-'));
  try {
    const sp = seedState(cwd, { mode: 'implement' });
    const state = readState(sp);
    state.current_stage = 'workflow-investigate';
    state.user_mode = 'implement';
    state.task_type = 'write';
    state.step = 'INTENT';
    state.step_flow = ['INTENT', 'DISCOVERY', 'PLAN', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE'];
    state.allowed_actions = ['classify_intent'];
    state.allowed_skills = ['workflow-investigate', 'workflow-implementation-plan', 'workflow-write-test', 'workflow-coding'];
    writeFileSync(sp, JSON.stringify(state, null, 2));

    const r = runTransition({ cwd, skill: '/implement' });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const after = readState(sp);
    assert.equal(after.current_stage, 'workflow-investigate');
    assert.equal(after.step, 'DISCOVERY');
    assert.deepEqual(after.completed_stages, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('ST-E2d: missing input session_id uses SMELTER_SESSION_ID for state transition', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'st-e2d-'));
  const prevSid = process.env.SMELTER_SESSION_ID;
  try {
    const sp = seedState(cwd, { mode: 'implement', sessionId: 'env-st' });
    const state = readState(sp);
    state.user_mode = 'implement';
    state.task_type = 'write';
    state.step = 'INTENT';
    state.step_flow = ['INTENT', 'DISCOVERY', 'PLAN', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE'];
    state.allowed_actions = ['classify_intent'];
    state.allowed_skills = ['workflow-investigate', 'workflow-implementation-plan', 'workflow-write-test', 'workflow-coding'];
    writeFileSync(sp, JSON.stringify(state, null, 2));

    process.env.SMELTER_SESSION_ID = 'env-st';
    const r = runTransition({ cwd, skill: '/implement', sessionId: null });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const after = readState(sp);
    assert.equal(after.current_stage, 'workflow-investigate');
    assert.equal(after.step, 'DISCOVERY');
  } finally {
    if (prevSid === undefined) delete process.env.SMELTER_SESSION_ID;
    else process.env.SMELTER_SESSION_ID = prevSid;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('ST-E3: unknown skill (non-workflow, non-entry) is ignored', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'st-e3-'));
  try {
    const sp = seedState(cwd, { mode: 'fix' });
    const before = readState(sp);
    const r = runTransition({ cwd, skill: 'hello' });
    assert.equal(r.status, 0);
    const after = readState(sp);
    assert.equal(after.current_stage, before.current_stage, 'non-matching skill must not mutate state');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('V04-I1: workflow-coding invocation advances bridged v0.4 step to EXECUTE', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'v04-i1-'));
  try {
    const sp = seedState(cwd, { mode: 'fix' });
    const state = readState(sp);
    state.user_mode = 'fix';
    state.task_type = 'write';
    state.step = 'TEST_DESIGN';
    state.step_flow = ['INTENT', 'DISCOVERY', 'PLAN', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE'];
    state.allowed_actions = ['read', 'write_test', 'run_test'];
    state.allowed_skills.push('workflow-coding');
    state.test_cycles = [{ action: 'added_case', run_result: 'fail' }];
    writeFileSync(sp, JSON.stringify(state, null, 2));

    const r = runTransition({ cwd, skill: 'workflow-coding' });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const after = readState(sp);
    assert.equal(after.step, 'EXECUTE');
    assert.deepEqual(after.allowed_actions, ['read', 'write_source', 'run_test']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('V04-I2: workflow-human-check invocation advances bridged v0.4 step to HUMAN_CHECK', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'v04-i2-'));
  try {
    const sp = seedState(cwd, { mode: 'fix' });
    const state = readState(sp);
    state.user_mode = 'fix';
    state.task_type = 'write';
    state.step = 'VERIFY';
    state.step_flow = ['INTENT', 'DISCOVERY', 'PLAN', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE'];
    state.allowed_actions = ['read', 'run_test', 'run_e2e', 'write_artifact'];
    state.allowed_skills.push('workflow-human-check');
    writeFileSync(sp, JSON.stringify(state, null, 2));

    const r = runTransition({ cwd, skill: 'workflow-human-check' });
    assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
    const after = readState(sp);
    assert.equal(after.step, 'HUMAN_CHECK');
    assert.deepEqual(after.allowed_actions, ['read', 'write_artifact', 'ask_user']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('ST-E4: entry command "brainstorm" maps to DISCOVERY entry_skill', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'st-e4-'));
  try {
    const sp = seedState(cwd, { mode: 'brainstorm' });
    const before = readState(sp);
    before.user_mode = 'brainstorm';
    before.task_type = 'design';
    before.step = 'INTENT';
    before.step_flow = ['INTENT', 'DISCOVERY', 'PLAN', 'DONE'];
    before.allowed_actions = ['classify_intent'];
    writeFileSync(sp, JSON.stringify(before, null, 2));

    const r = runTransition({ cwd, skill: 'brainstorm' });
    assert.equal(r.status, 0);
    const state = readState(sp);
    assert.equal(state.current_stage, 'workflow-investigate');
    assert.equal(state.step, 'DISCOVERY');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('ST-E5: entry command "dobby" does NOT advance freeform state to HUMAN_CHECK', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'st-e5-'));
  try {
    const sp = seedState(cwd, { mode: 'dobby' });
    const state = readState(sp);
    state.user_mode = 'dobby';
    state.task_type = 'freeform';
    state.step = 'EXECUTE';
    state.step_flow = ['INTENT', 'EXECUTE', 'HUMAN_CHECK', 'DONE'];
    state.allowed_actions = ['read', 'write_source', 'run_test'];
    state.allowed_skills = ['workflow-human-check'];
    state.current_stage = null;
    writeFileSync(sp, JSON.stringify(state, null, 2));

    const r = runTransition({ cwd, skill: 'dobby' });
    assert.equal(r.status, 0);
    const after = readState(sp);
    assert.equal(after.current_stage, null);
    assert.equal(after.step, 'EXECUTE');
    assert.deepEqual(after.allowed_actions, ['read', 'write_source', 'run_test']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Regression: no literal SKILL_ARTIFACT map in skill-stage-transition.mjs ──
// RED until Fix #1 Task 1-2 replaces the literal map with an import from
// state-validator.mjs.
test('regression: skill-stage-transition.mjs has NO literal SKILL_ARTIFACT map assignment (import-only)', () => {
  const src = readFileSync(SCRIPT, 'utf-8');
  const match = /^\s*const\s+SKILL_ARTIFACT\s*=\s*\{/m.test(src);
  assert.equal(match, false,
    'skill-stage-transition.mjs must not contain a literal SKILL_ARTIFACT = { ... } assignment; import from state-validator.mjs instead');
});

test('T3-S2: per-session pointer with slug producing non-canonical path is rejected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't3-s2-'));
  try {
    const sp = seedState(cwd, { mode: 'explore' });
    seedArtifact(sp, 'workflow-investigate');
    // Non-canonical: put state.json outside the /features/<slug>/task/ pattern
    const nonCanonical = join(cwd, 'random.state.json');
    writeFileSync(nonCanonical, readFileSync(sp, 'utf-8'));
    // slug="../random" → join(cwd, '.smt/features/../random/task/../random.state.json')
    // = cwd/.smt/random/task/random.state.json — non-canonical shape
    writeFileSync(
      join(cwd, '.smt', 'state', 'active-feature-t3.json'),
      JSON.stringify({ slug: '../random', session_id: 't3', updated_at: Date.now() }),
    );
    const before = JSON.parse(readFileSync(nonCanonical, 'utf-8'));
    runTransition({ cwd, skill: 'workflow-investigate' });
    const after = JSON.parse(readFileSync(nonCanonical, 'utf-8'));
    assert.equal(after.current_stage, before.current_stage, 'non-canonical path must not be mutated');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
