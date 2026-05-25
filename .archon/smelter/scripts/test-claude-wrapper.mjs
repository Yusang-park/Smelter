#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wrapper = '/Users/yusang/Smelter/.archon/smelter/scripts/claude-wrapper.mjs';
const HUD_SUMMARY_TRIGGER = '/Users/yusang/Smelter/.archon/smelter/scripts/hud-summary-trigger.mjs';
const tempHome = mkdtempSync(join(tmpdir(), 'claude-wrapper-home-'));
const SETTINGS_PATH = join(tempHome, '.claude', 'settings.json');
const versionsDir = join(tempHome, '.local', 'share', 'claude', 'versions');
mkdirSync(versionsDir, { recursive: true });
const fakeClaudeBinary = join(versionsDir, '1.0.0');
writeFileSync(fakeClaudeBinary, '#!/bin/sh\nexit 0\n');
chmodSync(fakeClaudeBinary, 0o755);

mkdirSync(join(tempHome, '.claude'), { recursive: true });
writeFileSync(SETTINGS_PATH, JSON.stringify({ model: 'sonnet' }, null, 2) + '\n');

function run(args) {
  return JSON.parse(
    execFileSync('node', [wrapper, ...args], {
      env: {
        ...process.env,
        HOME: tempHome,
        SMELTER_WRAPPER_TEST: '1',
        CLAUDE_CODEX_SETTINGS_PATH: SETTINGS_PATH,
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
      CLAUDE_CODEX_SETTINGS_PATH: SETTINGS_PATH,
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
assert.equal(codex.childEnvPreview.CLAUDE_CONFIG_DIR, join(tempHome, '.claude-codex'));
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
      CLAUDE_CODEX_SETTINGS_PATH: SETTINGS_PATH,
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
const plain = run(['--claude', '--version']);
assert.equal(plain.mode, 'claude');
assert.deepEqual(plain.passthrough, ['--version']);
assert.equal(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).env?.ANTHROPIC_BASE_URL, undefined);
assert.equal(plain.activeModel, null);

const forcedClaude = run(['--codex', '--claude', '--version']);
assert.equal(forcedClaude.mode, 'claude');
assert.deepEqual(forcedClaude.passthrough, ['--version']);
assert.equal(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).env?.ANTHROPIC_BASE_URL, undefined);

const inheritedCodexEnv = JSON.parse(
  execFileSync('node', [wrapper, '--claude', '--version'], {
    env: {
      ...process.env,
      HOME: tempHome,
      SMELTER_WRAPPER_TEST: '1',
      CODEX_MODE: '1',
      SMELTER_MODEL_MODE: 'codex',
      SMELTER_ACTIVE_MODEL: 'gpt-5.4',
      CLAUDE_CONFIG_DIR: join(tempHome, '.claude-codex'),
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3099',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    encoding: 'utf8',
  }),
);
assert.equal(inheritedCodexEnv.mode, 'claude');
assert.equal(inheritedCodexEnv.childEnvPreview.SMELTER_MODEL_MODE, 'claude');
assert.equal(inheritedCodexEnv.childEnvPreview.CODEX_MODE, undefined);
assert.equal(inheritedCodexEnv.childEnvPreview.SMELTER_ACTIVE_MODEL, undefined);
assert.equal(inheritedCodexEnv.childEnvPreview.CLAUDE_CONFIG_DIR, undefined);
assert.equal(inheritedCodexEnv.childEnvPreview.ANTHROPIC_BASE_URL, undefined);
assert.equal(inheritedCodexEnv.childEnvPreview.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);

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

console.log('claude wrapper test passed');
