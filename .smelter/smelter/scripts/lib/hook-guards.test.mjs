/**
 * hook-guards.test.mjs — RED tests for shared UserPromptSubmit hook guards.
 *
 * Target: scripts/lib/hook-guards.mjs (does not exist yet).
 * Surface: checkReentrancyOrBail, readLastDetection, writeLastDetection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkReentrancyOrBail,
  readLastDetection,
  writeLastDetection,
} from './hook-guards.mjs';

function withTempCwd(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'smt-hook-guards-'));
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  try { return fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('HG1 reentrancy guard returns true and emits {continue:true} when env set', () => {
  const orig = process.env.SMELTER_CLASSIFIER_SUBPROCESS;
  process.env.SMELTER_CLASSIFIER_SUBPROCESS = '1';
  const writes = [];
  try {
    const bail = checkReentrancyOrBail({ stdout: { write: (s) => writes.push(s) } });
    assert.equal(bail, true);
    assert.match(writes.join(''), /"continue"\s*:\s*true/);
  } finally {
    if (orig === undefined) delete process.env.SMELTER_CLASSIFIER_SUBPROCESS;
    else process.env.SMELTER_CLASSIFIER_SUBPROCESS = orig;
  }
});

test('HG2 reentrancy guard returns false when env unset', () => {
  const orig = process.env.SMELTER_CLASSIFIER_SUBPROCESS;
  delete process.env.SMELTER_CLASSIFIER_SUBPROCESS;
  try {
    const bail = checkReentrancyOrBail({ stdout: { write: () => {} } });
    assert.equal(bail, false);
  } finally {
    if (orig !== undefined) process.env.SMELTER_CLASSIFIER_SUBPROCESS = orig;
  }
});

test('HG3 writeLastDetection writes JSON, readable by readLastDetection (happy path)', () => {
  withTempCwd((cwd) => {
    writeLastDetection({ cwd, sessionId: 'sess-A', payload: { kind: 'slash', name: 'fix', source: 'slash' } });
    const file = join(cwd, '.smt', 'state', 'last-detection-sess-A.json');
    assert.equal(existsSync(file), true);
    const result = readLastDetection({ cwd, sessionId: 'sess-A' });
    assert.equal(result.detection.kind, 'slash');
    assert.equal(result.detection.name, 'fix');
    assert.equal(result.session_id, 'sess-A');
    assert.ok(result.ts > 0);
  });
});

test('HG4 readLastDetection returns null when file absent', () => {
  withTempCwd((cwd) => {
    assert.equal(readLastDetection({ cwd, sessionId: 'no-sess' }), null);
  });
});

test('HG5 readLastDetection returns null when session_id mismatches', () => {
  withTempCwd((cwd) => {
    writeLastDetection({ cwd, sessionId: 'sess-A', payload: { kind: 'slash' } });
    const file = join(cwd, '.smt', 'state', 'last-detection-sess-A.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.session_id = 'someone-else';
    writeFileSync(file, JSON.stringify(raw));
    assert.equal(readLastDetection({ cwd, sessionId: 'sess-A' }), null);
  });
});

test('HG6 readLastDetection returns null when TTL expired', () => {
  withTempCwd((cwd) => {
    writeLastDetection({ cwd, sessionId: 'sess-T', payload: { kind: 'slash' } });
    const file = join(cwd, '.smt', 'state', 'last-detection-sess-T.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.ts = Date.now() - 120_000;
    writeFileSync(file, JSON.stringify(raw));
    assert.equal(readLastDetection({ cwd, sessionId: 'sess-T', ttlMs: 60_000 }), null);
  });
});

test('HG7 readLastDetection returns null on malformed JSON without throwing', () => {
  withTempCwd((cwd) => {
    const file = join(cwd, '.smt', 'state', 'last-detection-sess-M.json');
    writeFileSync(file, '{ this is not json');
    assert.equal(readLastDetection({ cwd, sessionId: 'sess-M' }), null);
  });
});

test('HG8 writeLastDetection atomic — no leftover .tmp file after write', () => {
  withTempCwd((cwd) => {
    writeLastDetection({ cwd, sessionId: 'sess-X', payload: { kind: 'magic', name: 'fix' } });
    const stateDir = join(cwd, '.smt', 'state');
    const tmpFiles = readdirSync(stateDir).filter(f => f.includes('.tmp'));
    assert.equal(tmpFiles.length, 0);
  });
});
