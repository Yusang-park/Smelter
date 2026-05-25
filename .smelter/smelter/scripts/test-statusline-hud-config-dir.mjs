#!/usr/bin/env node
// RED-first test suite for: statusline-hud must honor CLAUDE_CONFIG_DIR.
//
// Contract under test:
//   scripts/statusline-hud.mjs must resolve its claude.json path as
//   `${process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude')}/.claude.json`
//   for BOTH reads and writes. This prevents a codex-window statusline tick
//   from leaking CODEX_MODEL_OPTIONS into the plain ~/.claude/.claude.json
//   (the file plain claude sessions read).
//
// All 10 cases are structured happy / boundary / error / edge / integration
// per the workflow-write-test distribution gate. Each case sets up a fresh
// temp HOME + codex dir, runs statusline-hud.mjs, then inspects the real
// files on disk.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HUD = '/Users/yusang/Smelter/.smelter/smelter/scripts/statusline-hud.mjs';
const TEST_SID = 'test-session-config-dir';
const PLAIN_CACHE_MARKER = [{ value: 'claude-opus-4-7', label: 'Opus 4.7', description: 'baseline' }];
const EMPTY_CACHE = [];
const NONEMPTY_CODEX_CACHE = [
  { value: 'gpt-5.4', label: 'Codex gpt-5.4', description: 'Codex balanced model' },
];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'smelter-hud-configdir-'));
  const home = join(root, 'home');
  const codexDir = join(home, '.claude-codex');
  const plainDir = join(home, '.claude');
  const cwd = join(root, 'project');
  const stateDir = join(cwd, '.smt', 'state');
  mkdirSync(home, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(plainDir, { recursive: true });
  mkdirSync(join(plainDir, 'hud', 'last-model'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { root, home, codexDir, plainDir, cwd, stateDir };
}

function writePlain(fx, cache) {
  writeFileSync(join(fx.plainDir, '..', '.claude.json'), JSON.stringify({ additionalModelOptionsCache: cache }) + '\n');
}

function writeCodexJson(fx, body) {
  writeFileSync(join(fx.codexDir, '.claude.json'), JSON.stringify(body) + '\n');
}

function readPlain(fx) {
  const p = join(fx.home, '.claude.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function readCodex(fx) {
  const p = join(fx.codexDir, '.claude.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeModelMode(fx, mode) {
  writeFileSync(
    join(fx.stateDir, `model-mode-${TEST_SID}.json`),
    JSON.stringify({ mode, model: 'Codex gpt-5.4', updated_at: new Date().toISOString() }) + '\n',
  );
}

function runHud(fx, { configDir = null, stdinExtra = {} } = {}) {
  const env = {
    ...process.env,
    HOME: fx.home,
    HUD_DRY_RUN: '1',
    SMELTER_SESSION_ID: TEST_SID,
  };
  if (configDir !== null) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  return execFileSync('node', [HUD], {
    input: JSON.stringify({ cwd: fx.cwd, ...stdinExtra }),
    encoding: 'utf8',
    env,
  });
}

function cleanup(fx) {
  rmSync(fx.root, { recursive: true, force: true });
}

let passed = 0;
const results = [];

function run(name, body) {
  const fx = makeFixture();
  try {
    body(fx);
    results.push({ name, ok: true });
    passed++;
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  } finally {
    cleanup(fx);
  }
}

// ─── happy ────────────────────────────────────────────────────────────────
run('happy_codex_window_writes_to_codex_claude_json', (fx) => {
  // Plain file pre-seeded with a non-codex cache so we can detect a wrong write.
  writePlain(fx, PLAIN_CACHE_MARKER);
  writeCodexJson(fx, { additionalModelOptionsCache: EMPTY_CACHE });
  writeModelMode(fx, 'codex');
  runHud(fx, { configDir: fx.codexDir });
  const plainAfter = readPlain(fx);
  const codexAfter = readCodex(fx);
  assert.deepEqual(plainAfter?.additionalModelOptionsCache, PLAIN_CACHE_MARKER,
    'plain ~/.claude.json must be untouched when CLAUDE_CONFIG_DIR points elsewhere');
  assert.ok(Array.isArray(codexAfter?.additionalModelOptionsCache) && codexAfter.additionalModelOptionsCache.length > 0,
    'codex dir claude.json must receive the self-heal write');
  assert.ok(codexAfter.additionalModelOptionsCache.some((o) => String(o.value ?? o).startsWith('gpt-')),
    'codex dir cache must contain at least one gpt-* option after self-heal');
});

run('happy_plain_window_writes_to_plain_claude_json', (fx) => {
  // No CLAUDE_CONFIG_DIR → script resolves to ~/.claude/.claude.json.
  // Codex mode is asserted via model-mode state so the self-heal branch fires
  // (documented behavior for plain shells whose env advertises codex via
  // inherited SMELTER_MODEL_MODE).
  writePlain(fx, EMPTY_CACHE);
  writeModelMode(fx, 'codex');
  runHud(fx, { configDir: null });
  const plainAfter = readPlain(fx);
  assert.ok(Array.isArray(plainAfter?.additionalModelOptionsCache) && plainAfter.additionalModelOptionsCache.length > 0,
    'plain ~/.claude.json must receive the self-heal write when CLAUDE_CONFIG_DIR is unset');
});

// ─── boundary ─────────────────────────────────────────────────────────────
run('boundary_empty_string_config_dir_falls_back_to_plain', (fx) => {
  writePlain(fx, EMPTY_CACHE);
  writeCodexJson(fx, { additionalModelOptionsCache: PLAIN_CACHE_MARKER });
  writeModelMode(fx, 'codex');
  runHud(fx, { configDir: '' });
  const plainAfter = readPlain(fx);
  const codexAfter = readCodex(fx);
  assert.ok(Array.isArray(plainAfter?.additionalModelOptionsCache) && plainAfter.additionalModelOptionsCache.length > 0,
    'empty CLAUDE_CONFIG_DIR must fall back to plain');
  assert.deepEqual(codexAfter?.additionalModelOptionsCache, PLAIN_CACHE_MARKER,
    'codex dir must be untouched when CLAUDE_CONFIG_DIR is blank (no config-dir override)');
});

run('boundary_nonempty_cache_skips_write', (fx) => {
  // If the resolved file already has cache entries, the self-heal guard
  // must short-circuit and not overwrite them.
  writePlain(fx, PLAIN_CACHE_MARKER);
  writeCodexJson(fx, { additionalModelOptionsCache: NONEMPTY_CODEX_CACHE });
  writeModelMode(fx, 'codex');
  runHud(fx, { configDir: fx.codexDir });
  const codexAfter = readCodex(fx);
  assert.deepEqual(codexAfter?.additionalModelOptionsCache, NONEMPTY_CODEX_CACHE,
    'existing non-empty cache must not be rewritten');
  assert.deepEqual(readPlain(fx)?.additionalModelOptionsCache, PLAIN_CACHE_MARKER,
    'plain dir must remain untouched across the run');
});

// ─── error ────────────────────────────────────────────────────────────────
run('error_nonexistent_config_dir_does_not_crash_or_leak', (fx) => {
  writePlain(fx, PLAIN_CACHE_MARKER);
  writeModelMode(fx, 'codex');
  const bogus = join(fx.home, 'nope-does-not-exist');
  // Must not throw and must not fall back to plain.
  runHud(fx, { configDir: bogus });
  assert.deepEqual(readPlain(fx)?.additionalModelOptionsCache, PLAIN_CACHE_MARKER,
    'plain dir must stay untouched even when resolved dir is missing');
  assert.equal(existsSync(join(bogus, '.claude.json')), false,
    'missing dir must not be created');
});

run('error_malformed_claude_json_does_not_corrupt_other_dirs', (fx) => {
  writePlain(fx, PLAIN_CACHE_MARKER);
  writeFileSync(join(fx.codexDir, '.claude.json'), '{not valid json');
  writeModelMode(fx, 'codex');
  runHud(fx, { configDir: fx.codexDir });
  // Plain dir stays clean even though codex dir was malformed.
  assert.deepEqual(readPlain(fx)?.additionalModelOptionsCache, PLAIN_CACHE_MARKER,
    'malformed codex claude.json must not cause a plain-dir write');
});

// ─── edge ─────────────────────────────────────────────────────────────────
run('edge_plain_mode_never_writes_regardless_of_config_dir', (fx) => {
  writePlain(fx, EMPTY_CACHE);
  writeCodexJson(fx, { additionalModelOptionsCache: EMPTY_CACHE });
  writeModelMode(fx, 'claude'); // plain mode — self-heal guard should hold
  runHud(fx, { configDir: fx.codexDir });
  assert.deepEqual(readPlain(fx)?.additionalModelOptionsCache, EMPTY_CACHE,
    'plain dir must not be filled by plain-mode invocation');
  assert.deepEqual(readCodex(fx)?.additionalModelOptionsCache, EMPTY_CACHE,
    'codex dir must not be filled by plain-mode invocation');
});

run('edge_read_path_symmetric_with_write_path', (fx) => {
  // Canary-seed plain with "wrong" cache and codex with "right" cache.
  // In codex mode with CLAUDE_CONFIG_DIR=codex, the statusline must READ from
  // codex (right), not plain (wrong) — verified by confirming that the
  // non-empty codex cache suppresses the self-heal write. If the code read
  // plain by accident, it would see [] and overwrite the codex file.
  const rightCache = NONEMPTY_CODEX_CACHE;
  writePlain(fx, EMPTY_CACHE);
  writeCodexJson(fx, { additionalModelOptionsCache: rightCache });
  writeModelMode(fx, 'codex');
  runHud(fx, { configDir: fx.codexDir });
  assert.deepEqual(readCodex(fx)?.additionalModelOptionsCache, rightCache,
    'read path must use same resolved dir as write path (bug-symptom: read plain → overwrite codex)');
});

// ─── integration ──────────────────────────────────────────────────────────
run('integration_codex_then_plain_runs_never_cross_write', (fx) => {
  // Two sequential runs: codex window, then plain window. Each must write
  // only to its own dir; neither must touch the other.
  writePlain(fx, EMPTY_CACHE);
  writeCodexJson(fx, { additionalModelOptionsCache: EMPTY_CACHE });
  writeModelMode(fx, 'codex');
  runHud(fx, { configDir: fx.codexDir });
  const plainMid = readPlain(fx);
  assert.deepEqual(plainMid?.additionalModelOptionsCache, EMPTY_CACHE,
    'mid-phase: plain dir must still be empty after codex run');
  const codexMid = readCodex(fx);
  assert.ok(codexMid?.additionalModelOptionsCache?.length > 0,
    'mid-phase: codex dir must have received the write');

  // Now the plain window: no CLAUDE_CONFIG_DIR, mode flipped to plain.
  writeModelMode(fx, 'claude');
  runHud(fx, { configDir: null });
  const plainAfter = readPlain(fx);
  const codexAfter = readCodex(fx);
  assert.deepEqual(plainAfter?.additionalModelOptionsCache, EMPTY_CACHE,
    'plain-window run with mode=claude must not write anything to plain');
  assert.deepEqual(codexAfter?.additionalModelOptionsCache, codexMid?.additionalModelOptionsCache,
    'plain-window run must not disturb codex dir written by prior codex run');
});

run('integration_multiple_codex_sessions_same_codex_dir', (fx) => {
  // Two codex runs in the same CLAUDE_CONFIG_DIR should be idempotent —
  // second run sees non-empty cache and skips the write.
  writePlain(fx, PLAIN_CACHE_MARKER);
  writeCodexJson(fx, { additionalModelOptionsCache: EMPTY_CACHE });
  writeModelMode(fx, 'codex');
  runHud(fx, { configDir: fx.codexDir });
  const firstCache = readCodex(fx)?.additionalModelOptionsCache;
  runHud(fx, { configDir: fx.codexDir });
  const secondCache = readCodex(fx)?.additionalModelOptionsCache;
  assert.deepEqual(firstCache, secondCache,
    'second codex run must not rewrite an already-populated codex cache');
  assert.deepEqual(readPlain(fx)?.additionalModelOptionsCache, PLAIN_CACHE_MARKER,
    'plain dir must remain untouched across both codex runs');
});

// ─── report ───────────────────────────────────────────────────────────────
for (const r of results) {
  console.log(r.ok ? `PASS ${r.name}` : `FAIL ${r.name}\n  ${r.err}`);
}
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(passed === results.length ? 0 : 1);
