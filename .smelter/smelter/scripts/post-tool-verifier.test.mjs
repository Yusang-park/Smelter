#!/usr/bin/env node
/**
 * post-tool-verifier.test.mjs — focused E2E test for the untrackTestedFiles
 * flow added to plug the "Step 8 E2E required" reminder noise.
 *
 * The hook runs as a real subprocess (stdin JSON → stdout JSON) and we
 * inspect the side-effect: the session-files tracking file at
 * /tmp/smelter-session-files-<hash>.json.
 *
 * Run: node scripts/post-tool-verifier.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, 'post-tool-verifier.mjs');

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

function trackingPathFor(projectDir) {
  const hash = createHash('md5').update(projectDir).digest('hex').slice(0, 8);
  return `/tmp/smelter-session-files-${hash}.json`;
}

function withProject(initialFiles, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ptv-'));
  const trackPath = trackingPathFor(dir);
  writeFileSync(trackPath, JSON.stringify(initialFiles));
  try {
    fn(dir, trackPath);
  } finally {
    try { unlinkSync(trackPath); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

function runHook(input) {
  return spawnSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf-8' });
}

console.log('\n[untrackTestedFiles — successful test command untracks source]');

test('node X.test.mjs success → X.mjs removed from tracking', () => {
  withProject(['scripts/auto-confirm.mjs', 'scripts/critic-watchdog.mjs'], (dir, trackPath) => {
    const res = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/auto-confirm.test.mjs' },
      tool_response: '71 passed, 0 failed',
      cwd: dir,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const files = JSON.parse(readFileSync(trackPath, 'utf-8'));
    assert.deepEqual(files, ['scripts/critic-watchdog.mjs']);
  });
});

test('all tested → tracking file deleted', () => {
  withProject(['scripts/auto-confirm.mjs'], (dir, trackPath) => {
    runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/auto-confirm.test.mjs' },
      tool_response: '71 passed, 0 failed',
      cwd: dir,
    });
    assert.equal(existsSync(trackPath), false, 'tracking file should be deleted when empty');
  });
});

test('failing test command does NOT untrack', () => {
  withProject(['scripts/auto-confirm.mjs'], (dir, trackPath) => {
    runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/auto-confirm.test.mjs' },
      tool_response: 'Error: 3 failed\nexit code: 1',
      cwd: dir,
    });
    const files = JSON.parse(readFileSync(trackPath, 'utf-8'));
    assert.deepEqual(files, ['scripts/auto-confirm.mjs']);
  });
});

test('non-test Bash command leaves tracking untouched', () => {
  withProject(['scripts/auto-confirm.mjs'], (dir, trackPath) => {
    runHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_response: 'total 12',
      cwd: dir,
    });
    const files = JSON.parse(readFileSync(trackPath, 'utf-8'));
    assert.deepEqual(files, ['scripts/auto-confirm.mjs']);
  });
});

test('basename match works (tracked relative, command absolute)', () => {
  withProject(['scripts/auto-confirm.mjs'], (dir, trackPath) => {
    runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node /absolute/path/auto-confirm.test.mjs' },
      tool_response: '71 passed',
      cwd: dir,
    });
    assert.equal(existsSync(trackPath), false);
  });
});

test('multiple tests in one command untrack all matched sources', () => {
  withProject([
    'scripts/auto-confirm.mjs',
    'scripts/critic-watchdog.mjs',
    'scripts/keep-me.mjs',
  ], (dir, trackPath) => {
    runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/auto-confirm.test.mjs && node scripts/critic-watchdog.test.mjs' },
      tool_response: 'ok 6',
      cwd: dir,
    });
    const files = JSON.parse(readFileSync(trackPath, 'utf-8'));
    assert.deepEqual(files, ['scripts/keep-me.mjs']);
  });
});

test('Edit/Write tool calls do not invoke untrack logic', () => {
  withProject(['scripts/auto-confirm.mjs'], (dir, trackPath) => {
    runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/whatever.txt' },
      tool_response: 'updated successfully',
      cwd: dir,
    });
    const files = JSON.parse(readFileSync(trackPath, 'utf-8'));
    // Should still contain auto-confirm.mjs (Edit doesn't untrack)
    assert.ok(files.includes('scripts/auto-confirm.mjs'));
  });
});

console.log('\n[file-modified error → retry-friendly message, not misleading "Edit failed"]');

test('Edit w/ file-modified error → message guides re-Read + retry', () => {
  withProject([], (dir) => {
    const res = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/human-check/SKILL.md' },
      tool_response: 'Error: File has been modified since read, either by the user or by a linter.',
      cwd: dir,
    });
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    const ctx = out.hookSpecificOutput && out.hookSpecificOutput.additionalContext || '';
    // Must NOT emit misleading "Verify file exists and content matches exactly"
    assert.doesNotMatch(ctx, /Verify file exists and content matches exactly/,
      'must not emit misleading generic Edit-failure guidance for file-modified race');
    // Must emit retry-friendly guidance that mentions Re-Read
    assert.match(ctx, /Re-Read|re-read|Read.*retry|File modified/i,
      'must guide agent to re-Read then retry');
  });
});

test('Write w/ file-modified error → message guides re-Read + retry', () => {
  withProject([], (dir) => {
    const res = runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/foo.md' },
      tool_response: 'Error: File has been modified since read, either by the user or by a linter.',
      cwd: dir,
    });
    const out = JSON.parse(res.stdout);
    const ctx = out.hookSpecificOutput && out.hookSpecificOutput.additionalContext || '';
    assert.doesNotMatch(ctx, /Check file permissions and directory existence/,
      'must not emit misleading Write-failure guidance for file-modified race');
    assert.match(ctx, /Re-Read|re-read|Read.*retry|File modified/i);
  });
});

test('Successful Write whose file CONTENT mentions the phrase must NOT trip file-modified branch', () => {
  withProject([], (dir) => {
    const res = runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/docs.md' },
      // Successful tool_response includes the created-file preview whose
      // content happens to mention the phrase. Must not classify as race.
      tool_response: 'File created successfully at: /tmp/docs.md\n\n# Notes\nWhen "File has been modified since read" appears, we re-read.',
      cwd: dir,
    });
    const out = JSON.parse(res.stdout);
    const ctx = out.hookSpecificOutput && out.hookSpecificOutput.additionalContext || '';
    assert.doesNotMatch(ctx, /recovery is mechanical/,
      'must not emit the file-modified retry guidance for a successful write');
    assert.match(ctx, /File written|Test the changes/, 'normal success guidance expected');
  });
});

console.log('');
console.log(`\npost-tool-verifier: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}: ${f.message}`);
  process.exit(1);
}
