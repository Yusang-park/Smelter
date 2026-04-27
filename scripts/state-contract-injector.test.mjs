#!/usr/bin/env node
/**
 * state-contract-injector.test.mjs — PreToolUse:Skill hook that injects a
 * state-write contract reminder into every workflow-* Skill invocation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'state-contract-injector.mjs');

function run(payload) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runWithCwd(payload, cwd, extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ ...payload, cwd }),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeTempCwd() {
  return mkdtempSync(join(tmpdir(), 'sci-test-'));
}

function parse(s) { return JSON.parse(s); }

// ── Happy path ─────────────────────────────────────────────────────────────
test('H1: workflow-tasker-review skill invocation injects contract', () => {
  const cwd = makeTempCwd();
  try {
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-tasker-review' } }, cwd);
    assert.equal(r.status, 0);
    const out = parse(r.stdout);
    assert.equal(out.continue, true);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /Smelter state-write contract/);
    assert.match(out.hookSpecificOutput.additionalContext, /You do NOT write `\.state\.json` directly/);
    assert.match(out.hookSpecificOutput.additionalContext, /finalize-human-check/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('H1b: injected contract stays compact to avoid repeated prompt bloat', () => {
  const cwd = makeTempCwd();
  try {
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-coding' } }, cwd);
    assert.equal(r.status, 0);
    const out = parse(r.stdout);
    const ctx = out.hookSpecificOutput?.additionalContext || '';
    assert.ok(ctx.length > 0, 'workflow skill must still receive the state-write contract');
    assert.ok(ctx.length < 900, `contract should stay compact, got ${ctx.length} chars`);
    assert.match(ctx, /Do not write `\.state\.json` directly/i);
    assert.match(ctx, /finalize-human-check/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('H2: every workflow-* skill name triggers injection', () => {
  const cwd = makeTempCwd();
  try {
    for (const skill of [
      'workflow-investigate',
      'workflow-investigate-review',
      'workflow-implementation-plan',
      'workflow-implementation-plan-review',
      'workflow-infra-plan',
      'workflow-infra-plan-review',
      'workflow-infra-execute',
      'workflow-tasker',
      'workflow-tasker-review',
      'workflow-write-test',
      'workflow-coding',
      'workflow-agent-review',
      'workflow-e2e',
      'workflow-e2e-review',
      'workflow-team-code-review',
      'workflow-human-check',
      'workflow-brainstorm',
      'workflow-brainstorm-review',
      'workflow-verify',
    ]) {
      const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill } }, cwd);
      const out = parse(r.stdout);
      assert.ok(out.hookSpecificOutput?.additionalContext, `${skill} must receive injection`);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ── Boundary ───────────────────────────────────────────────────────────────
test('B1: non-workflow skill (caveman) is a no-op', () => {
  const r = run({ tool_name: 'Skill', tool_input: { skill: 'caveman' } });
  const out = parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.hookSpecificOutput, undefined, 'no additionalContext for non-workflow skills');
});

test('B2: command skills (fix, implement, ...) are no-op (do not start with workflow-)', () => {
  for (const skill of ['fix', 'implement', 'infra', 'explore', 'verify', 'brainstorm', 'queue']) {
    const r = run({ tool_name: 'Skill', tool_input: { skill } });
    const out = parse(r.stdout);
    assert.equal(out.hookSpecificOutput, undefined, `${skill} must not receive workflow injection`);
  }
});

test('B3: non-Skill tool (Write) is a no-op', () => {
  const r = run({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' } });
  const out = parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.hookSpecificOutput, undefined);
});

// ── Error path ─────────────────────────────────────────────────────────────
test('E1: malformed JSON on stdin → continue:true (fail-open)', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { input: 'not json', encoding: 'utf8' });
  assert.equal(result.status, 0);
  const out = parse(result.stdout);
  assert.equal(out.continue, true);
});

test('E2: missing tool_input → continue:true', () => {
  const r = run({ tool_name: 'Skill' });
  const out = parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.hookSpecificOutput, undefined);
});

test('E3: empty payload → continue:true', () => {
  const r = run({});
  const out = parse(r.stdout);
  assert.equal(out.continue, true);
});

// ── Command-skill state seeding (v3.3.4) ───────────────────────────────────
// When the agent invokes a command-level skill (fix / implement / explore /
// verify / brainstorm) via the Skill tool instead of a typed `/slash`, the
// UserPromptSubmit hook chain does not run and `keyword-detector.mjs` never
// seeds `.state.json`. pre-tool-enforcer then blocks every code edit. This
// hook closes that gap by seeding workflow state in-line.

test('H3: Skill(fix, args) seeds state.json + per-session pointer when none exist', () => {
  const cwd = makeTempCwd();
  try {
    const r = runWithCwd({
      tool_name: 'Skill',
      tool_input: { skill: 'fix', args: 'login button unresponsive' },
      session_id: 'test-sess-H3',
    }, cwd);
    assert.equal(r.status, 0);
    const out = parse(r.stdout);
    assert.equal(out.continue, true);
    const ptrPath = join(cwd, '.smt', 'state', 'active-feature-test-sess-H3.json');
    assert.ok(existsSync(ptrPath), 'per-session pointer must be written');
    const ptr = JSON.parse(readFileSync(ptrPath, 'utf-8'));
    assert.ok(ptr.slug);
    const statePath = join(cwd, '.smt', 'features', ptr.slug, 'task', `${ptr.slug}.state.json`);
    assert.ok(existsSync(statePath), '.state.json must be written');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.equal(state.mode, 'fix');
    assert.ok(Array.isArray(state.allowed_skills) && state.allowed_skills.length > 0, 'allowed_skills populated');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('H4: Skill(implement, args) seeds state.json with mode=implement', () => {
  const cwd = makeTempCwd();
  try {
    runWithCwd({
      tool_name: 'Skill',
      tool_input: { skill: 'implement', args: 'add user settings panel' },
      session_id: 'test-sess-H4',
    }, cwd);
    const ptr = JSON.parse(readFileSync(join(cwd, '.smt', 'state', 'active-feature-test-sess-H4.json'), 'utf-8'));
    const state = JSON.parse(readFileSync(
      join(cwd, '.smt', 'features', ptr.slug, 'task', `${ptr.slug}.state.json`), 'utf-8'));
    assert.equal(state.mode, 'implement');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('H4b: Skill(/implement, args) is normalized and seeds mode=implement', () => {
  const cwd = makeTempCwd();
  try {
    runWithCwd({
      tool_name: 'Skill',
      tool_input: { skill: '/implement', args: 'add codex model support' },
      session_id: 'test-sess-H4b',
    }, cwd);
    const ptr = JSON.parse(readFileSync(join(cwd, '.smt', 'state', 'active-feature-test-sess-H4b.json'), 'utf-8'));
    const state = JSON.parse(readFileSync(
      join(cwd, '.smt', 'features', ptr.slug, 'task', `${ptr.slug}.state.json`), 'utf-8'));
    assert.equal(state.mode, 'implement');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('B3: Skill(fix) with existing session pointer REUSES feature (skill-tool is not slash)', () => {
  const cwd = makeTempCwd();
  try {
    runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'fix', args: 'first issue' }, session_id: 'sess-B3' }, cwd);
    const ptr1 = JSON.parse(readFileSync(join(cwd, '.smt', 'state', 'active-feature-sess-B3.json'), 'utf-8'));
    runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'fix', args: 'second issue' }, session_id: 'sess-B3' }, cwd);
    const ptr2 = JSON.parse(readFileSync(join(cwd, '.smt', 'state', 'active-feature-sess-B3.json'), 'utf-8'));
    assert.equal(ptr2.slug, ptr1.slug, 'Skill-tool source must reuse active feature, not create new');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('B4: Skill(caveman) — neither seeds nor injects contract', () => {
  const cwd = makeTempCwd();
  try {
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'caveman' }, session_id: 'sess-B4' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, true);
    assert.equal(out.hookSpecificOutput, undefined, 'non-workflow, non-command skill: no contract');
    assert.ok(!existsSync(join(cwd, '.smt', 'state', 'active-feature-sess-B4.json')), 'no pointer written');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('E3: Skill(fix) with missing session_id falls back to non-scoped pointer', () => {
  const cwd = makeTempCwd();
  try {
    runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'fix', args: 'no session' } }, cwd);
    assert.ok(existsSync(join(cwd, '.smt', 'state', 'active-feature.json')), 'non-scoped pointer is fallback');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('E4: SMELTER_CLASSIFIER_SUBPROCESS=1 short-circuits seeding (re-entrancy guard)', () => {
  const cwd = makeTempCwd();
  try {
    runWithCwd(
      { tool_name: 'Skill', tool_input: { skill: 'fix', args: 're-entrancy test' }, session_id: 'sess-E4' },
      cwd,
      { SMELTER_CLASSIFIER_SUBPROCESS: '1' },
    );
    assert.ok(!existsSync(join(cwd, '.smt', 'state', 'active-feature-sess-E4.json')),
      'classifier subprocess must not seed');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Edge1: Skill(workflow-investigate) after Skill(fix) seed still injects contract', () => {
  const cwd = makeTempCwd();
  try {
    runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'fix', args: 'x' }, session_id: 'sess-edge1' }, cwd);
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-investigate' }, session_id: 'sess-edge1' }, cwd);
    const out = parse(r.stdout);
    assert.ok(out.hookSpecificOutput?.additionalContext, 'workflow-* still triggers contract');
    assert.match(out.hookSpecificOutput.additionalContext, /Smelter state-write contract/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SEC1: adversarial sessionId with path traversal is rejected at hook boundary', () => {
  const cwd = makeTempCwd();
  try {
    const evilSid = '../../../tmp/evil';
    runWithCwd({
      tool_name: 'Skill',
      tool_input: { skill: 'fix', args: 'traversal test' },
      session_id: evilSid,
    }, cwd);
    // No file should appear under the traversed path
    const traversedPath = join(cwd, '.smt', 'state', `active-feature-${evilSid}.json`);
    assert.ok(!existsSync(traversedPath), 'sanitizer must prevent traversal-literal pointer write');
    // No absolute escape either
    assert.ok(!existsSync('/tmp/evil.json'), 'sanitizer must not allow writes outside cwd');
    // Non-scoped pointer should be written as fallback (sessionId treated as empty)
    assert.ok(existsSync(join(cwd, '.smt', 'state', 'active-feature.json')),
      'rejected sessionId falls through to non-scoped pointer');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SEC2: legitimate UUID-form sessionId is accepted', () => {
  const cwd = makeTempCwd();
  try {
    const uuid = '3cf0d611-4ce4-44b5-a4c6-05b314b49b87';
    runWithCwd({
      tool_name: 'Skill',
      tool_input: { skill: 'fix', args: 'uuid test' },
      session_id: uuid,
    }, cwd);
    assert.ok(existsSync(join(cwd, '.smt', 'state', `active-feature-${uuid}.json`)),
      'UUID-form sessionId must be accepted');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('I2: seeded state.json passes state-schema.mjs validate()', async () => {
  const cwd = makeTempCwd();
  try {
    runWithCwd({
      tool_name: 'Skill',
      tool_input: { skill: 'fix', args: 'schema integration' },
      session_id: 'sess-I2',
    }, cwd);
    const ptr = JSON.parse(readFileSync(join(cwd, '.smt', 'state', 'active-feature-sess-I2.json'), 'utf-8'));
    const statePath = join(cwd, '.smt', 'features', ptr.slug, 'task', `${ptr.slug}.state.json`);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    const { validate } = await import('./state-schema.mjs');
    const errs = validate(state);
    assert.deepEqual(errs, [], `schema errors: ${errs.join('; ')}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ── Integration ────────────────────────────────────────────────────────────
test('I1: contract enumerates the three blocked write paths the agent must not attempt', () => {
  const cwd = makeTempCwd();
  try {
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-coding' } }, cwd);
    const ctx = parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /pre-tool-enforcer\.mjs/);
    assert.match(ctx, /classifier rejects/);
    assert.match(ctx, /COMPLETION_DEFERRED_SKILLS/);
    // Workflow-human-check finalize hook is named so the agent knows the legitimate path.
    assert.match(ctx, /finalize-human-check\.mjs/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ── Chain enforcement (skill-delegation-enforcement) ──────────────────────
// PreToolUse:Skill must block workflow-* skill invocations that skip ahead
// in the active state's allowed_skills chain. Allowed moves from current_stage X:
//   1. X itself (idempotent re-entry)
//   2. next skill in allowed_skills (forward)
//   3. workflow-human-check (user-escape, always callable)
//   4. Producer of X on fail-route (events[last]={skill:X,result:'fail'})
// All other workflow-* targets → { continue: false, stopReason: string }.

function seedState(cwd, sessionId, {
  mode = 'fix',
  current_stage = null,
  events = [],
  completed_stages = [],
  allowed_skills = [
    'workflow-investigate','workflow-investigate-review',
    'workflow-write-test','workflow-coding',
    'workflow-agent-review','workflow-e2e','workflow-e2e-review','workflow-human-check',
  ],
} = {}) {
  const slug = 'ce-test-slug';
  const featureDir = join(cwd, '.smt', 'features', slug, 'task');
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(join(cwd, '.smt', 'state'), { recursive: true });
  const state = {
    schema_version: '2.4.1',
    task_id: slug,
    mode,
    chained_modes: [],
    allowed_skills,
    current_stage,
    completed_stages,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    target_type: null,
    surface: [],
    exempt: { tdd: false, e2e: false },
    skip_brainstorm: false,
    team_runtime: {},
    events,
    scenarios: [],
    test_cycles: [],
    active_feedback: [],
    sub_tasks: [],
  };
  writeFileSync(join(featureDir, `${slug}.state.json`), JSON.stringify(state, null, 2));
  const ptrName = sessionId ? `active-feature-${sessionId}.json` : 'active-feature.json';
  writeFileSync(join(cwd, '.smt', 'state', ptrName), JSON.stringify({ slug, task: slug }));
  return { slug, statePath: join(featureDir, `${slug}.state.json`) };
}

test('CE1 happy: current=workflow-investigate, skill=workflow-investigate-review → allow', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE1', { current_stage: 'workflow-investigate' });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-investigate-review' }, session_id: 'sess-CE1' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE2 happy: current=workflow-write-test, skill=workflow-coding with RED evidence → allow', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE2', {
      current_stage: 'workflow-write-test',
      events: [{
        t: new Date().toISOString(),
        type: 'test_red',
        skill: 'workflow-write-test',
        result: 'pass',
        declarer: 'hook',
        evidence: { type: 'exit_code', code: 1 },
      }],
    });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-coding' }, session_id: 'sess-CE2' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE2b error: current=workflow-write-test, skill=workflow-coding without RED evidence → BLOCK', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE2b', { current_stage: 'workflow-write-test' });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-coding' }, session_id: 'sess-CE2b' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, false, 'coding must not start before a failing test is recorded');
    assert.match(
      out.hookSpecificOutput?.permissionDecisionReason || out.stopReason || '',
      /TDD entry evidence.*test_red.*tdd_adopted.*echo/is,
      'block reason must explain that echo-masked failures are not RED evidence'
    );
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE2d happy: current=workflow-write-test, skill=workflow-coding with adopted dirty-worktree evidence → allow', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE2d', {
      current_stage: 'workflow-write-test',
      events: [{
        t: new Date().toISOString(),
        type: 'tdd_adopted',
        skill: 'workflow-write-test',
        result: 'pass',
        declarer: 'hook',
        evidence: { type: 'diff', summary: 'pre-existing user test/source changes adopted' },
      }],
    });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-coding' }, session_id: 'sess-CE2d' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE2c error: missing input session_id uses SMELTER_SESSION_ID for chain enforcement', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE2c', { current_stage: 'workflow-write-test' });
    const r = runWithCwd(
      { tool_name: 'Skill', tool_input: { skill: 'workflow-coding' } },
      cwd,
      { SMELTER_SESSION_ID: 'sess-CE2c' },
    );
    const out = parse(r.stdout);
    assert.equal(out.continue, false, 'env session id must activate the scoped chain guard');
    assert.match(out.stopReason || out.hookSpecificOutput?.permissionDecisionReason || '', /RED|workflow-write-test|workflow-coding/i);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE3 boundary: current=workflow-investigate, skill=workflow-investigate (re-entry) → allow', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE3', { current_stage: 'workflow-investigate' });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-investigate' }, session_id: 'sess-CE3' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE4 boundary: current_stage=null → allow (no chain yet)', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE4', { current_stage: null });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-coding' }, session_id: 'sess-CE4' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE5 error: current=workflow-investigate, skill=workflow-coding (skip) → BLOCK', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE5', { current_stage: 'workflow-investigate' });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-coding' }, session_id: 'sess-CE5' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, false, 'chain skip must block');
    assert.match(
      out.hookSpecificOutput?.permissionDecisionReason || out.stopReason || '',
      /chain|workflow-investigate-review|expected/i,
      'block reason must name the expected next skill'
    );
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE6 error: current=workflow-tasker, skill=workflow-e2e (multi-skip) → BLOCK', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE6', {
      mode: 'implement',
      current_stage: 'workflow-tasker',
      allowed_skills: [
        'workflow-brainstorm','workflow-brainstorm-review',
        'workflow-investigate','workflow-investigate-review',
        'workflow-tasker','workflow-tasker-review',
        'workflow-write-test','workflow-coding',
        'workflow-agent-review','workflow-e2e','workflow-e2e-review',
        'workflow-team-code-review','workflow-human-check',
      ],
    });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-e2e' }, session_id: 'sess-CE6' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, false, 'multi-stage skip must block');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE6b happy: implement current=workflow-investigate-review advances to implementation-plan, not tasker', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE6b', {
      mode: 'implement',
      current_stage: 'workflow-investigate-review',
      allowed_skills: [
        'workflow-investigate','workflow-investigate-review',
        'workflow-implementation-plan','workflow-implementation-plan-review',
        'workflow-write-test','workflow-coding',
        'workflow-agent-review','workflow-e2e','workflow-e2e-review',
        'workflow-team-code-review','workflow-human-check',
      ],
    });
    const allowed = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-implementation-plan' }, session_id: 'sess-CE6b' }, cwd);
    assert.equal(parse(allowed.stdout).continue, true);

    const blocked = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-tasker' }, session_id: 'sess-CE6b' }, cwd);
    const out = parse(blocked.stdout);
    assert.equal(out.continue, false, 'mode-inactive tasker must not be the implement next step');
    assert.match(out.stopReason || out.hookSpecificOutput?.permissionDecisionReason || '', /workflow-implementation-plan/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE7 edge: workflow-human-check is always callable (user-escape)', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE7', { current_stage: 'workflow-investigate' });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-human-check' }, session_id: 'sess-CE7' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, true, 'human-check must always pass');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE8 edge: command skill (fix) is not chain-gated even with active state', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE8', { current_stage: 'workflow-investigate' });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'fix', args: 'foo' }, session_id: 'sess-CE8' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, true, 'command skills bypass chain check');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE9 edge: fail-route — review failed, back to producer allowed', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE9', {
      current_stage: 'workflow-investigate-review',
      events: [{ t: new Date().toISOString(), skill: 'workflow-investigate-review', result: 'fail', declarer: 'hook' }],
    });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-investigate' }, session_id: 'sess-CE9' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, true, 'producer-route on last-event-fail must allow backward move');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE10 integration: block payload — continue=false + descriptive stopReason', () => {
  const cwd = makeTempCwd();
  try {
    seedState(cwd, 'sess-CE10', { current_stage: 'workflow-investigate' });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-agent-review' }, session_id: 'sess-CE10' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, false);
    const reason = out.stopReason || out.hookSpecificOutput?.permissionDecisionReason || '';
    assert.ok(reason.length > 0, 'block must carry a reason');
    assert.match(reason, /workflow-investigate-review/, 'reason must name the expected next skill');
    assert.match(reason, /workflow-investigate/, 'reason must name current stage');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE11 edge: state pointer missing → chain check skipped (no false block)', () => {
  const cwd = makeTempCwd();
  try {
    // No seedState call → no pointer, no state.json.
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-coding' }, session_id: 'sess-CE11' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, true, 'absent state must not cause block');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CE12 edge: review pass event — forward to next in chain allowed', () => {
  const cwd = makeTempCwd();
  try {
    // After investigate-review passes, next is whatever the active allowed_skills order declares.
    seedState(cwd, 'sess-CE12', {
      current_stage: 'workflow-investigate-review',
      events: [{ t: new Date().toISOString(), skill: 'workflow-investigate-review', result: 'pass', declarer: 'hook' }],
    });
    const r = runWithCwd({ tool_name: 'Skill', tool_input: { skill: 'workflow-write-test' }, session_id: 'sess-CE12' }, cwd);
    const out = parse(r.stdout);
    assert.equal(out.continue, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CLF1 (classifier-skip log): SMELTER_CLASSIFIER_SUBPROCESS=1 emits a stderr warn before early-return', () => {
  // state-contract-injector.mjs:124-130 silently early-returns when the
  // re-entrancy guard fires. If an unrelated wrapper leaks this env var the
  // seed is skipped without any trace. Fix: emit a stderr line so the
  // inheritance bug is diagnosable. Early-return semantics (continue:true)
  // must NOT change.
  const cwd = makeTempCwd();
  try {
    const r = runWithCwd(
      { tool_name: 'Skill', tool_input: { skill: 'workflow-investigate' }, session_id: 'sess-CLF1' },
      cwd,
      { SMELTER_CLASSIFIER_SUBPROCESS: '1' },
    );
    const out = parse(r.stdout);
    assert.equal(out.continue, true, 'early-return contract (continue:true) unchanged');
    assert.match(
      r.stderr,
      /classifier.subprocess|re.entrancy|SMELTER_CLASSIFIER_SUBPROCESS/i,
      `expected classifier-skip diagnostic on stderr; got: ${JSON.stringify(r.stderr)}`,
    );
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
