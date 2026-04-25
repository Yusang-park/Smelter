#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'session-start-smt.mjs');
const UPSTREAM_SKILL = readFileSync(join(ROOT, 'skills', 'caveman', 'SKILL.md'), 'utf8');

function runSessionStart() {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ session_id: 'test-session' }),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('session-start emits vendored caveman skill content', () => {
  const out = runSessionStart();
  const ctx = out.hookSpecificOutput?.additionalContext ?? '';

  assert.match(ctx, /name: caveman/);
  assert.match(ctx, /Respond terse like smart caveman\./);
  assert.equal(ctx.includes('[RESPONSE STYLE: CONCISE]'), false);
  assert.equal(ctx.includes(UPSTREAM_SKILL.trim()), true);
});

test('session-start does NOT write codexMode into ~/.smt/config.json under any env (cross-session-bleed regression)', () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'sst-home-'));
  mkdirSync(join(tempHome, '.smt'), { recursive: true });
  const cfgPath = join(tempHome, '.smt', 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ autoConfirm: true }));
  try {
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify({ session_id: 'test-session' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: tempHome, SMELTER_MODEL_MODE: 'codex', CODEX_MODE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.ok(!('codexMode' in cfg), `session-start must not write codexMode; got ${JSON.stringify(cfg)}`);
    assert.equal(cfg.autoConfirm, true, 'unrelated config keys must survive');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});
