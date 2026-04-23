#!/usr/bin/env node
/**
 * workflow-state-seeder.test.mjs — pure lib extracted from keyword-detector.
 * Writes per-task `.state.json`, `active-feature-<sid>.json` pointer,
 * feature-summary + plan.md. Called from both UserPromptSubmit
 * (keyword-detector) and PreToolUse:Skill (state-contract-injector).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
    assert.equal(state.task_id, result.slug);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('SL2: deriveSlug strips leading filler, caps length, falls back on empty', async () => {
  const { deriveSlug } = await import(MODULE);
  assert.equal(deriveSlug('the is in at for bug description'), 'bug-description');
  assert.match(deriveSlug('   '), /^feature-/, 'whitespace-only → synthetic slug');
  const long = deriveSlug('a '.repeat(100) + 'meaningful description here');
  assert.ok(long.length <= 50, `slug capped to 50 chars, got ${long.length}`);
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
