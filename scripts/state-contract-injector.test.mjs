#!/usr/bin/env node
/**
 * state-contract-injector.test.mjs — PreToolUse:Skill hook that injects a
 * state-write contract reminder into every workflow-* Skill invocation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
  const r = run({ tool_name: 'Skill', tool_input: { skill: 'workflow-tasker-review' } });
  assert.equal(r.status, 0);
  const out = parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /Smelter state-write contract/);
  assert.match(out.hookSpecificOutput.additionalContext, /You do NOT write `\.state\.json` directly/);
  assert.match(out.hookSpecificOutput.additionalContext, /finalize-human-check/);
});

test('H2: every workflow-* skill name triggers injection', () => {
  for (const skill of [
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
    'workflow-brainstorm',
    'workflow-brainstorm-review',
    'workflow-verify',
  ]) {
    const r = run({ tool_name: 'Skill', tool_input: { skill } });
    const out = parse(r.stdout);
    assert.ok(out.hookSpecificOutput?.additionalContext, `${skill} must receive injection`);
  }
});

// ── Boundary ───────────────────────────────────────────────────────────────
test('B1: non-workflow skill (caveman) is a no-op', () => {
  const r = run({ tool_name: 'Skill', tool_input: { skill: 'caveman' } });
  const out = parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.hookSpecificOutput, undefined, 'no additionalContext for non-workflow skills');
});

test('B2: command skills (fix, implement, ...) are no-op (do not start with workflow-)', () => {
  for (const skill of ['fix', 'implement', 'investigate', 'verify', 'think', 'queue']) {
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
// When the agent invokes a command-level skill (fix / implement / investigate /
// verify / think) via the Skill tool instead of a typed `/slash`, the
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
  const r = run({ tool_name: 'Skill', tool_input: { skill: 'workflow-coding' } });
  const ctx = parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /pre-tool-enforcer\.mjs/);
  assert.match(ctx, /classifier rejects/);
  assert.match(ctx, /COMPLETION_DEFERRED_SKILLS/);
  // Workflow-human-check finalize hook is named so the agent knows the legitimate path.
  assert.match(ctx, /finalize-human-check\.mjs/);
});
