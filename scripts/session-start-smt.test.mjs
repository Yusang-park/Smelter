#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

test('session-start syncs codex mode into ~/.smt/config.json when SMELTER_MODEL_MODE=codex', () => {
  const cfgPath = join(homedir(), '.smt', 'config.json');
  const prev = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : null;
  try {
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify({ session_id: 'test-session' }),
      encoding: 'utf8',
      env: { ...process.env, SMELTER_MODEL_MODE: 'codex' },
    });
    assert.equal(result.status, 0, result.stderr);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(cfg.codexMode, true);
  } finally {
    if (prev === null) {
      rmSync(cfgPath, { force: true });
    } else {
      writeFileSync(cfgPath, prev);
    }
  }
});
