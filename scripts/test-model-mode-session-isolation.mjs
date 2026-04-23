#!/usr/bin/env node
// RED tests for session-scoped-model-mode-state-file.
// These tests encode the post-fix contract described in
// .smt/features/session-scoped-model-mode-state-file/task/investigation.md
// and MUST fail against the current (unscoped) implementation.
//
// Distribution per workflow-write-test (10+ cases):
//   happy 2, boundary 2, error 2, edge 2, integration 2
//
// Each case prints `PASS <name>` or `FAIL <name>: <reason>` and sets a non-zero
// exit code on any failure so `node scripts/test-model-mode-session-isolation.mjs`
// is a single-command RED/GREEN signal.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const savedEnv = {
  HOME: process.env.HOME,
  SMELTER_SESSION_ID: process.env.SMELTER_SESSION_ID,
  CLAUDE_CODEX_SETTINGS_PATH: process.env.CLAUDE_CODEX_SETTINGS_PATH,
};

let failed = 0;
let passed = 0;

function record(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failed++;
    const reason = error instanceof Error ? error.message : String(error);
    process.stdout.write(`FAIL ${name}: ${reason}\n`);
  }
}

function makeFixture() {
  const tempHome = mkdtempSync(join(tmpdir(), 'mm-iso-home-'));
  const tempCwd = mkdtempSync(join(tmpdir(), 'mm-iso-cwd-'));
  const stateDir = join(tempCwd, '.smt', 'state');
  const claudeDir = join(tempHome, '.claude');
  const claudeCodexDir = join(tempHome, '.claude-codex');
  const settingsPath = join(claudeDir, 'settings.json');
  const claudeJsonPath = join(claudeCodexDir, '.claude.json');

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(claudeCodexDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ env: {}, model: 'sonnet' }) + '\n');
  writeFileSync(claudeJsonPath, JSON.stringify({ bootstrap: true }) + '\n');

  return { tempHome, tempCwd, stateDir, settingsPath, claudeJsonPath };
}

function cleanupFixture(fx) {
  rmSync(fx.tempHome, { recursive: true, force: true });
  rmSync(fx.tempCwd, { recursive: true, force: true });
}

function withEnv(envPatch, fn) {
  const prior = {};
  for (const k of Object.keys(envPatch)) {
    prior[k] = process.env[k];
    if (envPatch[k] === undefined) delete process.env[k];
    else process.env[k] = envPatch[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prior)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

async function loadSetModelMode() {
  // Fresh import each call — module-level consts bind to process.cwd() at
  // import time in the legacy impl, and this test swaps cwd between cases.
  const url = new URL('../codex-for-claude-code/scripts/set-model-mode.mjs', import.meta.url).href
    + `?t=${Date.now()}-${Math.random()}`;
  return await import(url);
}

// ---------------------------------------------------------------------------
// happy 1 — getModelModeStatePath embeds sid in filename
// ---------------------------------------------------------------------------
await (async () => {
  const fx = makeFixture();
  try {
    await withEnv({ HOME: fx.tempHome, CLAUDE_CODEX_SETTINGS_PATH: fx.settingsPath }, async () => {
      const mod = await loadSetModelMode();
      record('happy_scoped_path_contains_sid', () => {
        const sid = 'abc123-XYZ';
        const path = mod.getModelModeStatePath(fx.tempCwd, sid);
        assert.ok(path.endsWith(`model-mode-${sid}.json`), `expected scoped filename, got: ${path}`);
        assert.ok(path.startsWith(fx.tempCwd), `expected scoped path under cwd, got: ${path}`);
      });
    });
  } finally { cleanupFixture(fx); }
})();

// ---------------------------------------------------------------------------
// happy 2 — applyCodexMode writes to scoped path for given sid
// ---------------------------------------------------------------------------
await (async () => {
  const fx = makeFixture();
  try {
    await withEnv({ HOME: fx.tempHome, CLAUDE_CODEX_SETTINGS_PATH: fx.settingsPath }, async () => {
      const mod = await loadSetModelMode();
      const origCwd = process.cwd();
      process.chdir(fx.tempCwd);
      try {
        record('happy_apply_codex_mode_writes_scoped', () => {
          const sid = 'sid-happy-2';
          const settings = { env: {}, model: 'sonnet' };
          mod.applyCodexMode(settings, sid);
          const scoped = join(fx.stateDir, `model-mode-${sid}.json`);
          assert.ok(existsSync(scoped), `scoped file should exist at ${scoped}`);
          const unscoped = join(fx.stateDir, 'model-mode.json');
          assert.ok(!existsSync(unscoped), `unscoped file must not be written, found at ${unscoped}`);
        });
      } finally { process.chdir(origCwd); }
    });
  } finally { cleanupFixture(fx); }
})();

// ---------------------------------------------------------------------------
// boundary 1 — two distinct SIDs produce isolated files (no cross-read)
// ---------------------------------------------------------------------------
await (async () => {
  const fx = makeFixture();
  try {
    await withEnv({ HOME: fx.tempHome, CLAUDE_CODEX_SETTINGS_PATH: fx.settingsPath }, async () => {
      const mod = await loadSetModelMode();
      const origCwd = process.cwd();
      process.chdir(fx.tempCwd);
      try {
        record('boundary_two_sids_isolated', () => {
          const sidA = 'sid-alpha';
          const sidB = 'sid-beta';
          mod.applyCodexMode({ env: {}, model: 'sonnet' }, sidA);
          mod.applyCodexMode({ env: {}, model: 'sonnet' }, sidB);
          const a = join(fx.stateDir, `model-mode-${sidA}.json`);
          const b = join(fx.stateDir, `model-mode-${sidB}.json`);
          assert.ok(existsSync(a), 'sid A scoped file exists');
          assert.ok(existsSync(b), 'sid B scoped file exists');
          // Ensure each is its own file, not a shared symlink
          writeFileSync(a, JSON.stringify({ mode: 'codex', model: 'A' }));
          writeFileSync(b, JSON.stringify({ mode: 'codex', model: 'B' }));
          const readA = JSON.parse(readFileSync(a, 'utf8'));
          const readB = JSON.parse(readFileSync(b, 'utf8'));
          assert.equal(readA.model, 'A');
          assert.equal(readB.model, 'B');
        });
      } finally { process.chdir(origCwd); }
    });
  } finally { cleanupFixture(fx); }
})();

// ---------------------------------------------------------------------------
// boundary 2 — UUID-format sid (hyphens + alnum) accepted
// ---------------------------------------------------------------------------
await (async () => {
  const fx = makeFixture();
  try {
    await withEnv({ HOME: fx.tempHome, CLAUDE_CODEX_SETTINGS_PATH: fx.settingsPath }, async () => {
      const mod = await loadSetModelMode();
      record('boundary_uuid_sid_accepted', () => {
        const sid = randomUUID();
        const path = mod.getModelModeStatePath(fx.tempCwd, sid);
        assert.ok(path.includes(sid), `UUID sid must appear in path: ${path}`);
      });
    });
  } finally { cleanupFixture(fx); }
})();

// ---------------------------------------------------------------------------
// error 1 — getModelModeStatePath without sid throws
// ---------------------------------------------------------------------------
await (async () => {
  const fx = makeFixture();
  try {
    const mod = await loadSetModelMode();
    record('error_missing_sid_throws', () => {
      assert.throws(() => mod.getModelModeStatePath(fx.tempCwd, null),
        /sid|session|required|missing/i,
        'expected throw when sid is null');
      assert.throws(() => mod.getModelModeStatePath(fx.tempCwd, ''),
        /sid|session|required|missing|empty/i,
        'expected throw when sid is empty string');
      assert.throws(() => mod.getModelModeStatePath(fx.tempCwd, undefined),
        /sid|session|required|missing|undefined/i,
        'expected throw when sid is undefined');
    });
  } finally { cleanupFixture(fx); }
})();

// ---------------------------------------------------------------------------
// error 2 — path-traversal sid rejected (throws or sanitizes away)
// ---------------------------------------------------------------------------
await (async () => {
  const fx = makeFixture();
  try {
    const mod = await loadSetModelMode();
    record('error_path_traversal_sid_rejected', () => {
      assert.throws(() => mod.getModelModeStatePath(fx.tempCwd, '../../etc/passwd'),
        /sid|invalid|unsafe|sanitiz/i,
        'expected throw on path-traversal sid');
      assert.throws(() => mod.getModelModeStatePath(fx.tempCwd, '/absolute'),
        /sid|invalid|unsafe|sanitiz/i,
        'expected throw on absolute-path sid');
    });
  } finally { cleanupFixture(fx); }
})();

// ---------------------------------------------------------------------------
// edge 1 — plain claude (no SMELTER_SESSION_ID) → readProjectModelMode null
// ---------------------------------------------------------------------------
await (async () => {
  const fx = makeFixture();
  try {
    await withEnv({ HOME: fx.tempHome, SMELTER_SESSION_ID: undefined }, async () => {
      const origCwd = process.cwd();
      process.chdir(fx.tempCwd);
      try {
        // Put a stale unscoped file that should NOT be read
        mkdirSync(fx.stateDir, { recursive: true });
        writeFileSync(join(fx.stateDir, 'model-mode.json'),
          JSON.stringify({ mode: 'codex', model: 'Codex gpt-5.4' }));
        const url = new URL('./lib/subagent-classifier.mjs', import.meta.url).href
          + `?t=${Date.now()}-${Math.random()}`;
        const mod = await import(url);
        record('edge_plain_claude_null_state', () => {
          // post-fix: readProjectModelMode requires { cwd, sessionId }; no sid → null
          const result = mod.readProjectModelMode
            ? mod.readProjectModelMode({ cwd: fx.tempCwd, sessionId: null })
            : null;
          assert.equal(result, null, 'plain claude (no sid) must return null; refuses stale unscoped file');
        });
      } finally { process.chdir(origCwd); }
    });
  } finally { cleanupFixture(fx); }
})();

// ---------------------------------------------------------------------------
// edge 2 — TTL sweep prunes old scoped files but skips current sid
// ---------------------------------------------------------------------------
await (async () => {
  const fx = makeFixture();
  try {
    const currentSid = 'sid-current';
    const staleSid = 'sid-stale';
    const currentFile = join(fx.stateDir, `model-mode-${currentSid}.json`);
    const staleFile = join(fx.stateDir, `model-mode-${staleSid}.json`);
    writeFileSync(currentFile, JSON.stringify({ mode: 'codex' }));
    writeFileSync(staleFile, JSON.stringify({ mode: 'codex' }));
    const twoDaysAgo = (Date.now() - 48 * 3600 * 1000) / 1000;
    utimesSync(staleFile, twoDaysAgo, twoDaysAgo);

    const mod = await loadSetModelMode();
    record('edge_ttl_sweep_prunes_stale_keeps_current', () => {
      if (typeof mod.sweepStaleModelModeStates !== 'function') {
        throw new Error('sweepStaleModelModeStates(stateDir, currentSid, maxAgeMs) not exported');
      }
      mod.sweepStaleModelModeStates(fx.stateDir, currentSid, 24 * 3600 * 1000);
      assert.ok(existsSync(currentFile), 'current-sid file must be preserved');
      assert.ok(!existsSync(staleFile), 'stale file must be pruned');
    });
  } finally { cleanupFixture(fx); }
})();

// ---------------------------------------------------------------------------
// integration 1 — applyCodexMode → applyClaudeMode round-trip with sid
// ---------------------------------------------------------------------------
await (async () => {
  const fx = makeFixture();
  try {
    await withEnv({ HOME: fx.tempHome, CLAUDE_CODEX_SETTINGS_PATH: fx.settingsPath }, async () => {
      const mod = await loadSetModelMode();
      const origCwd = process.cwd();
      process.chdir(fx.tempCwd);
      try {
        record('integration_apply_codex_then_claude_roundtrip', () => {
          const sid = 'sid-roundtrip';
          const scoped = join(fx.stateDir, `model-mode-${sid}.json`);
          const settings = { env: {}, model: 'sonnet' };
          mod.applyCodexMode(settings, sid);
          assert.ok(existsSync(scoped), 'scoped file present after codex mode');
          mod.applyClaudeMode(settings, fx.tempCwd, sid);
          assert.ok(!existsSync(scoped), 'scoped file removed after claude mode');
        });
      } finally { process.chdir(origCwd); }
    });
  } finally { cleanupFixture(fx); }
})();

// ---------------------------------------------------------------------------
// integration 2 — legacy unscoped file is unlinked by wrapper sweep
// ---------------------------------------------------------------------------
await (async () => {
  const fx = makeFixture();
  try {
    const legacy = join(fx.stateDir, 'model-mode.json');
    writeFileSync(legacy, JSON.stringify({ mode: 'codex', model: 'Codex gpt-5.4' }));
    const mod = await loadSetModelMode();
    record('integration_legacy_unscoped_file_unlinked', () => {
      if (typeof mod.unlinkLegacyModelModeState !== 'function') {
        throw new Error('unlinkLegacyModelModeState(stateDir) not exported');
      }
      mod.unlinkLegacyModelModeState(fx.stateDir);
      assert.ok(!existsSync(legacy), 'legacy unscoped file must be removed');
    });
  } finally { cleanupFixture(fx); }
})();

// ---------------------------------------------------------------------------
// Restore env + summary
// ---------------------------------------------------------------------------
for (const k of Object.keys(savedEnv)) {
  if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
