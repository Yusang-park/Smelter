#!/usr/bin/env node
/**
 * codex-mode-home-bleed.test.mjs — RED tests for the ~/.smt/config.json
 * cross-session classifier bleed.
 *
 * Scope:
 *  1. session-start-smt.mjs must NOT write `codexMode` to ~/.smt/config.json
 *     under any env.
 *  2. auto-confirm.pickSubAgentModel() must NOT pick a codex model based on a
 *     stale global config file.
 *  3. subagent-classifier.selectClassifierModel() must NOT route to
 *     gpt-5.4-mini based on a stale global config file.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const SESSION_START = join(ROOT, 'scripts', 'session-start-smt.mjs');

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${label}\n        ${err.message}`);
  }
}

function makeTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'codex-bleed-'));
  mkdirSync(join(home, '.smt', 'state'), { recursive: true });
  return home;
}

function seedConfig(home, cfg) {
  writeFileSync(join(home, '.smt', 'config.json'), JSON.stringify(cfg));
}

function readConfig(home) {
  const p = join(home, '.smt', 'config.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

await test('(1a) session-start with CODEX_MODE=1 does not create codexMode key', () => {
  const home = makeTempHome();
  try {
    const r = spawnSync(process.execPath, [SESSION_START], {
      input: JSON.stringify({ session_id: 'home-bleed-1a' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, CODEX_MODE: '1', SMELTER_MODEL_MODE: 'codex' },
    });
    assert.equal(r.status, 0, r.stderr);
    const cfg = readConfig(home);
    if (cfg === null) return;
    assert.ok(
      !('codexMode' in cfg),
      `expected no codexMode key; got ${JSON.stringify(cfg)}`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await test('(1b) session-start preserves unrelated keys in pre-existing config.json', () => {
  const home = makeTempHome();
  try {
    seedConfig(home, { autoConfirm: true, unrelated: 'keep-me' });
    const r = spawnSync(process.execPath, [SESSION_START], {
      input: JSON.stringify({ session_id: 'home-bleed-1b' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, CODEX_MODE: '1', SMELTER_MODEL_MODE: 'codex' },
    });
    assert.equal(r.status, 0, r.stderr);
    const cfg = readConfig(home);
    assert.equal(cfg.autoConfirm, true);
    assert.equal(cfg.unrelated, 'keep-me');
    assert.ok(!('codexMode' in cfg), `expected no codexMode key; got ${JSON.stringify(cfg)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await test('(2) pickSubAgentModel ignores stale ~/.smt/config.json.codexMode=true when env is clean', async () => {
  const home = makeTempHome();
  const prevHome = process.env.HOME;
  const prevCodexMode = process.env.CODEX_MODE;
  const prevMode = process.env.SMELTER_MODEL_MODE;
  try {
    seedConfig(home, { codexMode: true });
    process.env.HOME = home;
    delete process.env.CODEX_MODE;
    delete process.env.SMELTER_MODEL_MODE;
    const mod = await import('./auto-confirm.mjs?' + Date.now());
    const picked = mod.pickSubAgentModel();
    assert.notEqual(
      picked, 'gpt-5.4-mini',
      `plain-claude classifier must not pick codex model based on global config; got ${picked}`,
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevCodexMode === undefined) delete process.env.CODEX_MODE; else process.env.CODEX_MODE = prevCodexMode;
    if (prevMode === undefined) delete process.env.SMELTER_MODEL_MODE; else process.env.SMELTER_MODEL_MODE = prevMode;
    rmSync(home, { recursive: true, force: true });
  }
});

await test('(3) selectClassifierModel ignores stale ~/.smt/config.json.codexMode=true when env is clean', async () => {
  const home = makeTempHome();
  const prevHome = process.env.HOME;
  const prevCodexMode = process.env.CODEX_MODE;
  const prevMode = process.env.SMELTER_MODEL_MODE;
  const prevActive = process.env.SMELTER_ACTIVE_MODEL;
  const prevSid = process.env.SMELTER_SESSION_ID;
  try {
    seedConfig(home, { codexMode: true });
    process.env.HOME = home;
    delete process.env.CODEX_MODE;
    delete process.env.SMELTER_MODEL_MODE;
    delete process.env.SMELTER_ACTIVE_MODEL;
    delete process.env.SMELTER_SESSION_ID;
    const mod = await import('./lib/subagent-classifier.mjs?' + Date.now());
    const picked = mod.selectClassifierModel();
    assert.notEqual(
      picked, 'gpt-5.4-mini',
      `plain-claude classifier must not pick codex model based on global config; got ${picked}`,
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevCodexMode === undefined) delete process.env.CODEX_MODE; else process.env.CODEX_MODE = prevCodexMode;
    if (prevMode === undefined) delete process.env.SMELTER_MODEL_MODE; else process.env.SMELTER_MODEL_MODE = prevMode;
    if (prevActive === undefined) delete process.env.SMELTER_ACTIVE_MODEL; else process.env.SMELTER_ACTIVE_MODEL = prevActive;
    if (prevSid === undefined) delete process.env.SMELTER_SESSION_ID; else process.env.SMELTER_SESSION_ID = prevSid;
    rmSync(home, { recursive: true, force: true });
  }
});

console.log('');
console.log(`codex-mode-home-bleed: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
