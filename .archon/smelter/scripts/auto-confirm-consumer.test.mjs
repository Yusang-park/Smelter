#!/usr/bin/env node
/**
 * auto-confirm-consumer.test.mjs — focused E2E test for the UserPromptSubmit
 * consumer that picks up queued auto-confirm payloads dropped by the Stop hook.
 *
 * Tests run the script as a real subprocess (stdin JSON → stdout JSON) and
 * assert on the output schema + queue-file lifecycle.
 *
 * Run: node scripts/auto-confirm-consumer.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

import { consume } from './auto-confirm-consumer.mjs';
import { queuePath, QUEUE_MAX_AGE_MS } from './auto-confirm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, 'auto-confirm-consumer.mjs');

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

function withProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'acc-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function dropQueueFile(dir, sessionId, entry) {
  const path = queuePath(dir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entry));
  return path;
}

// ============================================================================
console.log('\n[consume() — pure function lifecycle]');
// ============================================================================

test('absent queue file → null', () => {
  withProject((dir) => {
    assert.equal(consume(dir, 'sess-1'), null);
  });
});

test('valid fresh entry → returned + file deleted', () => {
  withProject((dir) => {
    const path = dropQueueFile(dir, 'sess-1', {
      t: new Date().toISOString(),
      additionalContext: 'do the next thing',
      reason: 'test',
    });
    const entry = consume(dir, 'sess-1');
    assert.ok(entry);
    assert.equal(entry.additionalContext, 'do the next thing');
    assert.equal(existsSync(path), false, 'queue file should be deleted after consume');
  });
});

test('expired entry (older than QUEUE_MAX_AGE_MS) → null + file deleted', () => {
  withProject((dir) => {
    const stale = new Date(Date.now() - QUEUE_MAX_AGE_MS - 1000).toISOString();
    const path = dropQueueFile(dir, 'sess-1', { t: stale, additionalContext: 'stale' });
    assert.equal(consume(dir, 'sess-1'), null);
    assert.equal(existsSync(path), false, 'stale queue file should be deleted');
  });
});

test('malformed JSON → null + file deleted', () => {
  withProject((dir) => {
    const path = queuePath(dir, 'sess-1');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not-json');
    assert.equal(consume(dir, 'sess-1'), null);
    assert.equal(existsSync(path), false, 'corrupt queue file should be deleted');
  });
});

test('session-scoped: session A cannot consume session B queue', () => {
  withProject((dir) => {
    const pathB = dropQueueFile(dir, 'sess-B', {
      t: new Date().toISOString(),
      additionalContext: 'B-only',
    });
    // Session A asks — must not receive B's payload, must not delete B's file.
    assert.equal(consume(dir, 'sess-A'), null);
    assert.equal(existsSync(pathB), true, 'session B file untouched by session A consume');
  });
});

// ============================================================================
console.log('\n[CLI entry — real subprocess + JSON output schema]');
// ============================================================================

function runHook(input) {
  return spawnSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf-8' });
}

test('no queue file → exit 0, no stdout', () => {
  withProject((dir) => {
    const res = runHook({ cwd: dir, session_id: 'sess-1' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(res.stdout.trim(), '');
  });
});

test('fresh queue → exit 0, valid UserPromptSubmit hookSpecificOutput JSON', () => {
  withProject((dir) => {
    dropQueueFile(dir, 'sess-1', {
      t: new Date().toISOString(),
      additionalContext: 'continue with workflow-coding',
      reason: 'test',
    });
    const res = runHook({ cwd: dir, session_id: 'sess-1' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.continue, true);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(out.hookSpecificOutput.additionalContext, 'continue with workflow-coding');
    // Critical: NO `decision: 'continue'` (invalid for UserPromptSubmit schema)
    assert.ok(!('decision' in out) || out.decision === undefined, 'must not emit decision field');
  });
});

test('queue with no additionalContext → exit 0, no stdout', () => {
  withProject((dir) => {
    dropQueueFile(dir, 'sess-1', { t: new Date().toISOString(), reason: 'no-context' });
    const res = runHook({ cwd: dir, session_id: 'sess-1' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  });
});

test('expired queue → exit 0, no stdout, file deleted', () => {
  withProject((dir) => {
    const stale = new Date(Date.now() - QUEUE_MAX_AGE_MS - 1000).toISOString();
    const path = dropQueueFile(dir, 'sess-1', { t: stale, additionalContext: 'stale' });
    const res = runHook({ cwd: dir, session_id: 'sess-1' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assert.equal(existsSync(path), false);
  });
});

// ----------------------------------------------------------------------------
console.log('');
console.log(`\nauto-confirm-consumer: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}: ${f.message}`);
  process.exit(1);
}
