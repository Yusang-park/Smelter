#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wrapper = '/Users/yusang/smelter/scripts/claude-wrapper.mjs';
const SETTINGS_PATH = '/Users/yusang/smelter/settings.json';
const HUD_SUMMARY_TRIGGER = '/Users/yusang/smelter/scripts/hud-summary-trigger.mjs';
const tempHome = mkdtempSync(join(tmpdir(), 'claude-wrapper-home-'));
const versionsDir = join(tempHome, '.local', 'share', 'claude', 'versions');
mkdirSync(versionsDir, { recursive: true });
const fakeClaudeBinary = join(versionsDir, '1.0.0');
writeFileSync(fakeClaudeBinary, '#!/bin/sh\nexit 0\n');
chmodSync(fakeClaudeBinary, 0o755);

// Save state before tests so we can restore after
const savedSettings = readFileSync(SETTINGS_PATH, 'utf8');

function run(args) {
  return JSON.parse(
    execFileSync('node', [wrapper, ...args], {
      env: {
        ...process.env,
        HOME: tempHome,
        SMELTER_WRAPPER_TEST: '1',
      },
      encoding: 'utf8',
    }),
  );
}

function runScript(scriptPath, stdin, env = {}) {
  return execFileSync('node', [scriptPath], {
    input: stdin,
    env: {
      ...process.env,
      HOME: tempHome,
      ...env,
    },
    encoding: 'utf8',
  });
}

// Reset to a clean claude-alias state before each codex test so model defaulting is deterministic
function resetModelToSonnet() {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  settings.model = 'sonnet';
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

resetModelToSonnet();
const codex = run(['--codex', '--version']);
assert.equal(codex.mode, 'codex');
assert.deepEqual(codex.passthrough, ['--version']);
// ANTHROPIC_BASE_URL must NOT be in settings.json — it's only injected into child process env
assert.equal(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).env?.ANTHROPIC_BASE_URL, undefined);
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set only in wrapper's child process env, not in settings.json
// (setting it in settings.json blocks rate_limits/context_window from HUD stdin)
// Coming from 'sonnet' alias → should default to gpt-5.4
assert.equal(codex.activeModel, 'gpt-5.4');
// Slots 1-4 must NOT be redirected to gpt models
assert.equal(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).env?.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
assert.equal(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).env?.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);

// Re-entering codex mode keeps an already-selected Codex model for that window.
const codexPreserve = JSON.parse(
  execFileSync('node', [wrapper, '--codex', '--version'], {
    env: {
      ...process.env,
      HOME: tempHome,
      SMELTER_WRAPPER_TEST: '1',
      SMELTER_WRAPPER_TEST_ACTIVE_MODEL: 'gpt-5.4-mini',
    },
    encoding: 'utf8',
  }),
);
assert.equal(codexPreserve.activeModel, 'gpt-5.4-mini', 'codex mode should preserve selected codex model for that window');

// Full claude model IDs no longer force a global codex default into other windows.
const settings2 = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
settings2.model = 'claude-opus-4-6';
writeFileSync(SETTINGS_PATH, JSON.stringify(settings2, null, 2) + '\n');
const codexPreserveClaude = run(['--codex', '--version']);
assert.equal(codexPreserveClaude.activeModel, 'gpt-5.4', 'codex window without prior codex selection should use default model');

resetModelToSonnet();
const plain = run(['--version']);
assert.equal(plain.mode, 'claude');
assert.deepEqual(plain.passthrough, ['--version']);
assert.equal(savedSettings ? JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).env?.ANTHROPIC_BASE_URL : undefined, undefined);
assert.equal(plain.activeModel, null);

const forcedClaude = run(['--codex', '--claude', '--version']);
assert.equal(forcedClaude.mode, 'claude');
assert.deepEqual(forcedClaude.passthrough, ['--version']);
assert.equal(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).env?.ANTHROPIC_BASE_URL, undefined);

resetModelToSonnet();
const hudCacheDir = join(tempHome, '.claude', 'hud', 'task-summary');
mkdirSync(hudCacheDir, { recursive: true });
const hudCachePath = join(hudCacheDir, Buffer.from(process.cwd()).toString('base64url') + '.json');
writeFileSync(hudCachePath, JSON.stringify({
  raw_prompt: 'summarize current work',
  timestamp: new Date().toISOString(),
}, null, 2));

const hudClaude = JSON.parse(runScript(HUD_SUMMARY_TRIGGER, JSON.stringify({ cwd: process.cwd() })));
assert.match(hudClaude.hookSpecificOutput.additionalContext, /model: "haiku"/, 'expected Claude-family main model to keep haiku subagent');

const settings3 = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
settings3.model = 'gpt-5.4';
writeFileSync(SETTINGS_PATH, JSON.stringify(settings3, null, 2) + '\n');
writeFileSync(hudCachePath, JSON.stringify({
  raw_prompt: 'summarize current work',
  timestamp: new Date().toISOString(),
}, null, 2));

const hudCodex = JSON.parse(runScript(HUD_SUMMARY_TRIGGER, JSON.stringify({ cwd: process.cwd() })));
assert.match(hudCodex.hookSpecificOutput.additionalContext, /model: "gpt-5.4-mini"/, 'expected Codex-family main model to use gpt-5.4-mini subagent');

rmSync(hudCachePath, { force: true });

// Restore original state so tests don't leave system in wrong mode
writeFileSync(SETTINGS_PATH, savedSettings);

console.log('claude wrapper test passed');
