#!/usr/bin/env node
/**
 * workflow-state-seeder.test.mjs — pure lib extracted from keyword-detector.
 * Writes per-task `.state.json`, `active-feature-<sid>.json` pointer,
 * feature-summary + plan.md. Called from both UserPromptSubmit
 * (keyword-detector) and PreToolUse:Skill (state-contract-injector).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE = '../../scripts/lib/workflow-state-seeder.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'wss-')); }

test('SL1: seedWorkflowState creates state.json, pointer, plan.md', async () => {
  const { seedWorkflowState } = await import(MODULE);
  const cwd = tmp();
  try {
    const result = seedWorkflowState({
      directory: cwd,
      commandName: 'fix',
      args: 'missing null check in parser',
      sessionId: 'sl1-sess',
      source: 'skill-tool',
    });
    assert.ok(result.slug, 'slug returned');
    assert.ok(result.statePath && existsSync(result.statePath), '.state.json exists');
    assert.ok(result.pointerPath && existsSync(result.pointerPath), 'pointer exists');
    assert.ok(existsSync(join(cwd, '.smt', 'features', result.slug, 'task', 'plan.md')), 'plan.md seeded');
    const state = JSON.parse(readFileSync(result.statePath, 'utf-8'));
    assert.equal(state.mode, 'fix');
    assert.equal(state.user_mode, 'fix');
    assert.equal(state.task_type, 'write');
    assert.equal(state.step, 'INTENT');
    assert.deepEqual(state.step_flow, ['INTENT', 'DISCOVERY', 'TEST_DESIGN', 'EXECUTE', 'VERIFY', 'HUMAN_CHECK', 'DONE']);
    assert.deepEqual(state.allowed_actions, ['classify_intent']);
    assert.equal(state.task_id, result.slug);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL1b: seedWorkflowState supports live v0.4 modes explore and dobby', async () => {
  const { seedWorkflowState } = await import(MODULE);
  const cwd = tmp();
  try {
    const inv = seedWorkflowState({ directory: cwd, commandName: 'explore', args: 'probe', sessionId: 'sl1b-a', source: 'skill-tool' });
    const invState = JSON.parse(readFileSync(inv.statePath, 'utf-8'));
    assert.equal(invState.user_mode, 'explore');
    assert.equal(invState.task_type, 'read');

    const dobby = seedWorkflowState({ directory: cwd, commandName: 'dobby', args: 'manual edit', sessionId: 'sl1b-b', source: 'skill-tool' });
    const dobbyState = JSON.parse(readFileSync(dobby.statePath, 'utf-8'));
    assert.equal(dobbyState.user_mode, 'dobby');
    assert.equal(dobbyState.task_type, 'freeform');
    assert.equal(dobbyState.step, 'EXECUTE');
    assert.deepEqual(dobbyState.allowed_actions, ['read', 'write_source', 'run_test']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL2: deriveSlug always returns UUID-fixed slug regardless of prompt', async () => {
  const { deriveSlug } = await import(MODULE);
  const UUID_SLUG = /^feature-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  // All prompts — meaningful, whitespace-only, empty, repetitive — must yield
  // UUID-fixed slugs. Text-derived slugging was removed to prevent the
  // state↔artifact divergence bug (agent descriptive slug vs seeder slug).
  assert.match(deriveSlug('the is in at for bug description'), UUID_SLUG);
  assert.match(deriveSlug('   '), UUID_SLUG);
  assert.match(deriveSlug(''), UUID_SLUG);
  assert.match(deriveSlug('meaningful description here'), UUID_SLUG);
  // Each invocation returns a distinct slug.
  const a = deriveSlug('same prompt');
  const b = deriveSlug('same prompt');
  assert.notEqual(a, b, 'two calls produce distinct UUIDs');
});

test('SL3: shouldCreateNewFeature — skill-tool source REUSES live pointer', async () => {
  const { seedWorkflowState, shouldCreateNewFeature } = await import(MODULE);
  const cwd = tmp();
  try {
    seedWorkflowState({ directory: cwd, commandName: 'fix', args: 'first', sessionId: 'sl3', source: 'skill-tool' });
    const d = shouldCreateNewFeature(cwd, 'sl3', 'second invocation', 'skill-tool');
    assert.equal(d.create, false, 'skill-tool must reuse');
    assert.ok(d.reuseSlug);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL4: shouldCreateNewFeature — slash source ALWAYS creates new (user override)', async () => {
  const { seedWorkflowState, shouldCreateNewFeature } = await import(MODULE);
  const cwd = tmp();
  try {
    seedWorkflowState({ directory: cwd, commandName: 'fix', args: 'first', sessionId: 'sl4', source: 'skill-tool' });
    const d = shouldCreateNewFeature(cwd, 'sl4', 'second', 'slash');
    assert.equal(d.create, true, 'explicit /slash always creates new');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL5 (boundary): missing sessionId writes non-scoped pointer', async () => {
  const { seedWorkflowState } = await import(MODULE);
  const cwd = tmp();
  try {
    const r = seedWorkflowState({
      directory: cwd, commandName: 'fix', args: 'no session',
      sessionId: '', source: 'skill-tool',
    });
    assert.equal(r.pointerPath, join(cwd, '.smt', 'state', 'active-feature.json'));
    assert.ok(existsSync(r.pointerPath));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL7 (security): seedWorkflowState defense-in-depth — rejects traversal sessionId', async () => {
  const { seedWorkflowState } = await import(MODULE);
  const cwd = tmp();
  try {
    const r = seedWorkflowState({
      directory: cwd,
      commandName: 'fix',
      args: 'defense test',
      sessionId: '../../escape',
      source: 'skill-tool',
    });
    // Must succeed (lib sanitizes, not rejects outright), but pointer path
    // must not contain the traversal sequence.
    assert.ok(r, 'seeder still returns result (sanitize, not fail)');
    assert.ok(!r.pointerPath.includes('..'), 'pointer path must not contain traversal');
    assert.ok(!existsSync(join(cwd, '.smt', 'state', 'active-feature-../../escape.json')),
      'lib defense-in-depth must prevent traversal pointer');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL6 (error): invalid commandName returns null without throwing', async () => {
  const { seedWorkflowState } = await import(MODULE);
  const cwd = tmp();
  try {
    const r = seedWorkflowState({
      directory: cwd, commandName: 'totally-not-a-mode',
      sessionId: 'sl6', source: 'skill-tool',
    });
    assert.equal(r, null, 'unknown command → null (cancel/queue-like)');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SL8–SL14 — mode-upgrade branch: read-only state (verify/explore/brainstorm)
// under Skill(fix|implement) must reseed as write-mode, not silently reuse.
// ═══════════════════════════════════════════════════════════════════════════

test('SL8 (happy): verify state + Skill(fix) → mode-upgrade creates new', async () => {
  const { seedWorkflowState, shouldCreateNewFeature } = await import(MODULE);
  const cwd = tmp();
  try {
    seedWorkflowState({ directory: cwd, commandName: 'verify', args: 'check output', sessionId: 'sl8', source: 'skill-tool' });
    const d = shouldCreateNewFeature(cwd, 'sl8', 'now fix it', 'skill-tool', 'fix');
    assert.equal(d.create, true, 'verify→fix must upgrade, not reuse');
    assert.equal(d.reason, 'mode-upgrade');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL9 (happy): brainstorm state + Skill(implement) → mode-upgrade creates new', async () => {
  const { seedWorkflowState, shouldCreateNewFeature } = await import(MODULE);
  const cwd = tmp();
  try {
    seedWorkflowState({ directory: cwd, commandName: 'brainstorm', args: 'brainstorm caching', sessionId: 'sl9', source: 'skill-tool' });
    const d = shouldCreateNewFeature(cwd, 'sl9', 'build it', 'skill-tool', 'implement');
    assert.equal(d.create, true, 'brainstorm→implement must upgrade');
    assert.equal(d.reason, 'mode-upgrade');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL10 (boundary): fix state + Skill(fix) → stays reuse (idempotency)', async () => {
  const { seedWorkflowState, shouldCreateNewFeature } = await import(MODULE);
  const cwd = tmp();
  try {
    seedWorkflowState({ directory: cwd, commandName: 'fix', args: 'first bug', sessionId: 'sl10', source: 'skill-tool' });
    const d = shouldCreateNewFeature(cwd, 'sl10', 'second turn', 'skill-tool', 'fix');
    assert.equal(d.create, false, 'same-mode must reuse');
    assert.ok(d.reuseSlug);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL11 (boundary): fix state + Skill(implement) → stays reuse (cross write-mode not upgraded)', async () => {
  const { seedWorkflowState, shouldCreateNewFeature } = await import(MODULE);
  const cwd = tmp();
  try {
    seedWorkflowState({ directory: cwd, commandName: 'fix', args: 'first bug', sessionId: 'sl11', source: 'skill-tool' });
    const d = shouldCreateNewFeature(cwd, 'sl11', 'now build a feature', 'skill-tool', 'implement');
    assert.equal(d.create, false, 'cross write-mode stays reuse — user must explicit new-feature');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL12 (edge): verify state with completed human-check → prior-completed wins over mode-upgrade', async () => {
  const { seedWorkflowState, shouldCreateNewFeature } = await import(MODULE);
  const cwd = tmp();
  try {
    const r = seedWorkflowState({ directory: cwd, commandName: 'verify', args: 'check', sessionId: 'sl12', source: 'skill-tool' });
    // Simulate finished feature on disk — shouldCreateNewFeature reads raw JSON,
    // so bypass writeState's watchdog (not the code path under test) with fs.writeFileSync.
    const state = JSON.parse(readFileSync(r.statePath, 'utf-8'));
    state.completed_stages = ['workflow-human-check'];
    writeFileSync(r.statePath, JSON.stringify(state, null, 2));
    const d = shouldCreateNewFeature(cwd, 'sl12', 'now fix a new bug', 'skill-tool', 'fix');
    assert.equal(d.create, true);
    assert.equal(d.reason, 'prior-completed', 'prior-completed takes precedence over mode-upgrade');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL13 (integration): seedWorkflowState verify→fix e2e — new slug + state.mode=fix on disk', async () => {
  const { seedWorkflowState } = await import(MODULE);
  const cwd = tmp();
  try {
    const v = seedWorkflowState({ directory: cwd, commandName: 'verify', args: 'check first', sessionId: 'sl13', source: 'skill-tool' });
    const f = seedWorkflowState({ directory: cwd, commandName: 'fix', args: 'fix second', sessionId: 'sl13', source: 'skill-tool' });
    assert.notEqual(f.slug, v.slug, 'mode-upgrade must produce a different slug');
    assert.notEqual(f.reused, true, 'upgrade path must not return reused:true');
    const state = JSON.parse(readFileSync(f.statePath, 'utf-8'));
    assert.equal(state.mode, 'fix', 'new state.mode must be fix, not verify');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL14 (boundary): explore→explore via Skill(explore) keeps explicit reseed precedence', async () => {
  const { seedWorkflowState, shouldCreateNewFeature } = await import(MODULE);
  const cwd = tmp();
  try {
    seedWorkflowState({ directory: cwd, commandName: 'explore', args: 'probe', sessionId: 'sl14', source: 'skill-tool' });
    const d = shouldCreateNewFeature(cwd, 'sl14', 'probe again', 'skill-tool', 'explore');
    // explore-command-reseed must not be shadowed by mode-upgrade.
    assert.equal(d.create, true);
    assert.equal(d.reason, 'explore-command-reseed', 'existing explore-reseed precedence preserved');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL14b (boundary): magic explore during active write workflow reuses sticky feature', async () => {
  const { seedWorkflowState, shouldCreateNewFeature } = await import(MODULE);
  const cwd = tmp();
  try {
    seedWorkflowState({ directory: cwd, commandName: 'implement', args: 'active build', sessionId: 'sl14b', source: 'magic' });
    const d = shouldCreateNewFeature(cwd, 'sl14b', '파악해줘', 'magic', 'explore');
    assert.equal(d.create, false, 'natural-language explore must not reseed while workflow is active');
    assert.ok(d.reuseSlug);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL15 (catch-path log): seedWorkflowState emits a log line when the create path throws', async () => {
  // Catch at workflow-state-seeder.mjs:350-352 previously swallowed every
  // error silently, so downstream enforcer blocks had no upstream diagnostic.
  // After the fix, the catch must emit a `State seed failed:` line via the
  // existing log helper (workflow-state-seeder.mjs:197).
  const { seedWorkflowState } = await import(MODULE);
  const cwd = tmp();
  // Force mkdirSync inside the create path to throw: place a regular file at
  // `.smt` so any `mkdirSync('<cwd>/.smt/state', { recursive: true })` fails
  // with ENOTDIR.
  writeFileSync(join(cwd, '.smt'), 'blocker');
  const originalWrite = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  try {
    const r = seedWorkflowState({
      directory: cwd,
      commandName: 'fix',
      args: 'force failure',
      sessionId: 'sl15',
      source: 'skill-tool',
    });
    assert.equal(r, null, 'create-path failure must still return null (control flow unchanged)');
    const combined = captured.join('');
    assert.match(
      combined,
      /State seed failed/i,
      `expected stderr to contain 'State seed failed:' diagnostic; got: ${JSON.stringify(combined)}`,
    );
  } finally {
    process.stderr.write = originalWrite;
    rmSync(cwd, { recursive: true, force: true });
  }
});
