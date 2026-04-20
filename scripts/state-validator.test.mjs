#!/usr/bin/env node
/**
 * state-validator.test.mjs — Evidence integrity validation.
 * Feature: harness-integrity-4-fixes T4
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEvidenceIntegrity } from './state-validator.mjs';
import { createInitialState, writeState } from './state-schema.mjs';

function baseState() {
  return createInitialState({ taskId: 'feat', mode: 'investigate' });
}

// ── Happy path ─────────────────────────────────────────────────────────────
test('T4-H1: empty completed_stages passes (initial seed)', () => {
  const state = baseState();
  const errs = validateEvidenceIntegrity(state, '/tmp/dummy.state.json');
  assert.deepEqual(errs, []);
});

test('T4-H2: completed_stage with canonical artifact basename passes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't4-h2-'));
  try {
    const artifact = join(cwd, 'investigation.md'); // canonical for workflow-investigate
    writeFileSync(artifact, 'evidence', 'utf-8');
    const state = baseState();
    state.completed_stages.push('workflow-investigate');
    state.events.push({
      t: new Date().toISOString(), skill: 'workflow-investigate',
      result: 'pass', declarer: 'hook',
      evidence: { type: 'file_present', path: artifact },
    });
    const errs = validateEvidenceIntegrity(state, join(cwd, 'x.state.json'));
    assert.deepEqual(errs, [], `unexpected errors: ${errs.join(', ')}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T4-H3: wrong basename for skill is rejected (anti-forge)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't4-h3-'));
  try {
    const plan = join(cwd, 'plan.md'); // exists but wrong skill
    writeFileSync(plan, 'real plan content', 'utf-8');
    const state = baseState();
    state.completed_stages.push('workflow-investigate');
    state.events.push({
      t: new Date().toISOString(), skill: 'workflow-investigate',
      result: 'pass', declarer: 'hook',
      evidence: { type: 'file_present', path: plan },
    });
    const errs = validateEvidenceIntegrity(state, join(cwd, 'x.state.json'));
    assert.ok(errs.length > 0);
    assert.match(errs[0], /wrong basename|investigation\.md/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Boundary ───────────────────────────────────────────────────────────────
test('T4-B1: completed_stage with NO matching pass event → error', () => {
  const state = baseState();
  state.completed_stages.push('workflow-investigate');
  const errs = validateEvidenceIntegrity(state, '/tmp/x.state.json');
  assert.ok(errs.length > 0);
  assert.match(errs[0], /forged|no pass event|evidence/i);
});

test('T4-B2: pass event missing evidence.path → error', () => {
  const state = baseState();
  state.completed_stages.push('workflow-investigate');
  state.events.push({
    t: new Date().toISOString(), skill: 'workflow-investigate',
    result: 'pass', declarer: 'hook',
    evidence: { type: 'user_input' },
  });
  const errs = validateEvidenceIntegrity(state, '/tmp/x.state.json');
  assert.ok(errs.length > 0);
  assert.match(errs[0], /evidence\.path/i);
});

// ── Error path ─────────────────────────────────────────────────────────────
test('T4-E1: evidence.path points to non-existent file → error', () => {
  const state = baseState();
  state.completed_stages.push('workflow-investigate');
  state.events.push({
    t: new Date().toISOString(), skill: 'workflow-investigate',
    result: 'pass', declarer: 'hook',
    evidence: { type: 'file_present', path: '/tmp/does-not-exist-xyz.md' },
  });
  const errs = validateEvidenceIntegrity(state, '/tmp/x.state.json');
  assert.ok(errs.length > 0);
  assert.match(errs[0], /does not exist|not found/i);
});

test('T4-E2: relative evidence.path resolves against state dir', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't4-e2-'));
  try {
    const artifact = join(cwd, 'sub', 'investigation.md');
    mkdirSync(join(cwd, 'sub'), { recursive: true });
    writeFileSync(artifact, 'ev', 'utf-8');
    const state = baseState();
    state.completed_stages.push('workflow-investigate');
    state.events.push({
      t: new Date().toISOString(), skill: 'workflow-investigate',
      result: 'pass', declarer: 'hook',
      evidence: { type: 'file_present', path: 'sub/investigation.md' },
    });
    const errs = validateEvidenceIntegrity(state, join(cwd, 'x.state.json'));
    assert.deepEqual(errs, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Edge case ──────────────────────────────────────────────────────────────
test('T4-C1: multiple completed_stages — each validated independently', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't4-c1-'));
  try {
    const a = join(cwd, 'investigation.md'); writeFileSync(a, '1');
    const b = join(cwd, 'investigation-review.md'); writeFileSync(b, '2');
    const state = baseState();
    state.completed_stages.push('workflow-investigate', 'workflow-investigate-review');
    state.events.push(
      { t: new Date().toISOString(), skill: 'workflow-investigate', result: 'pass', declarer: 'hook', evidence: { type: 'file_present', path: a } },
      { t: new Date().toISOString(), skill: 'workflow-investigate-review', result: 'pass', declarer: 'hook', evidence: { type: 'file_present', path: b } },
    );
    const errs = validateEvidenceIntegrity(state, join(cwd, 'x.state.json'));
    assert.deepEqual(errs, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T4-C2: stage with fail event only (no pass) → error', () => {
  const state = baseState();
  state.completed_stages.push('workflow-investigate');
  state.events.push({
    t: new Date().toISOString(), skill: 'workflow-investigate',
    result: 'fail', declarer: 'hook', cause: 'assertion',
  });
  const errs = validateEvidenceIntegrity(state, '/tmp/x.state.json');
  assert.ok(errs.length > 0);
});

// ── Integration: writeState wiring ─────────────────────────────────────────
test('T4-I1: writeState() throws when evidence integrity fails', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't4-i1-'));
  try {
    const sp = join(cwd, 'x.state.json');
    const state = baseState();
    state.completed_stages.push('workflow-investigate');
    // No matching pass event → should throw
    assert.throws(() => writeState(sp, state), /evidence|forged|pass event/i);
    assert.ok(!existsSync(sp) || true, 'file may or may not exist; key is throw');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Security hardening ────────────────────────────────────────────────────
test('T4-S1: tautological evidence (path === statePath) is rejected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't4-s1-'));
  try {
    const sp = join(cwd, 'x.state.json');
    const state = baseState();
    state.completed_stages.push('workflow-investigate');
    state.events.push({
      t: new Date().toISOString(), skill: 'workflow-investigate',
      result: 'pass', declarer: 'hook',
      evidence: { type: 'file_present', path: sp }, // <-- same as state file
    });
    // Write the state file so existsSync returns true (prove it's purely the tautology guard firing)
    writeFileSync(sp, '{}', 'utf-8');
    const errs = validateEvidenceIntegrity(state, sp);
    assert.ok(errs.length > 0, 'tautology must be rejected');
    assert.match(errs[0], /tautolog/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T4-S2: empty file as evidence is rejected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't4-s2-'));
  try {
    const empty = join(cwd, 'empty.md');
    writeFileSync(empty, '', 'utf-8');
    const state = baseState();
    state.completed_stages.push('workflow-investigate');
    state.events.push({
      t: new Date().toISOString(), skill: 'workflow-investigate',
      result: 'pass', declarer: 'hook',
      evidence: { type: 'file_present', path: empty },
    });
    const errs = validateEvidenceIntegrity(state, join(cwd, 'x.state.json'));
    assert.ok(errs.length > 0);
    assert.match(errs[0], /empty/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T4-S3: directory as evidence path is rejected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't4-s3-'));
  try {
    const state = baseState();
    state.completed_stages.push('workflow-investigate');
    state.events.push({
      t: new Date().toISOString(), skill: 'workflow-investigate',
      result: 'pass', declarer: 'hook',
      evidence: { type: 'file_present', path: cwd }, // directory, not file
    });
    const errs = validateEvidenceIntegrity(state, join(cwd, 'x.state.json'));
    assert.ok(errs.length > 0);
    assert.match(errs[0], /not a file/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('T4-I2: writeState() succeeds with valid evidence', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 't4-i2-'));
  try {
    const art = join(cwd, 'investigation.md');
    writeFileSync(art, 'ok', 'utf-8');
    const state = baseState();
    state.completed_stages.push('workflow-investigate');
    state.events.push({
      t: new Date().toISOString(), skill: 'workflow-investigate',
      result: 'pass', declarer: 'hook',
      evidence: { type: 'file_present', path: art },
    });
    const sp = join(cwd, 'x.state.json');
    writeState(sp, state);
    assert.ok(existsSync(sp));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
