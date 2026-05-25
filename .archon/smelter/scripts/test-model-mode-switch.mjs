#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'model-mode-switch-home-'));
const tempCwd = mkdtempSync(join(tmpdir(), 'model-mode-switch-cwd-'));
const claudeDir = join(tempHome, '.claude');
const claudeCodexDir = join(tempHome, '.claude-codex');
const claudeJsonPath = join(claudeCodexDir, '.claude.json');
const stateDir = join(tempCwd, '.smt', 'state');
const TEST_SESSION_ID = 'test-session-switch';
const statePath = join(stateDir, `model-mode-${TEST_SESSION_ID}.json`);
const settingsPath = join(claudeDir, 'settings.json');
const savedEnv = {
  HOME: process.env.HOME,
  CLAUDE_CODEX_SETTINGS_PATH: process.env.CLAUDE_CODEX_SETTINGS_PATH,
};

mkdirSync(stateDir, { recursive: true });
mkdirSync(claudeDir, { recursive: true });
mkdirSync(claudeCodexDir, { recursive: true });
writeFileSync(claudeJsonPath, JSON.stringify({ bootstrap: true }) + '\n');
writeFileSync(settingsPath, JSON.stringify({ env: {}, model: 'sonnet' }) + '\n');

process.env.HOME = tempHome;
process.env.CLAUDE_CODEX_SETTINGS_PATH = settingsPath;
const origCwd = process.cwd();
process.chdir(tempCwd);

const { CODEX_MODEL_OPTIONS } = await import('./lib/codex-models.mjs');
const {
  applyCodexMode,
  applyClaudeMode,
  buildModelModeState,
  writeJsonFile,
  getCodexConfigDir,
  getCodexClaudeJsonPath,
} = await import('./set-model-mode.mjs');

try {
  let settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.env ??= {};
  settings.model = 'sonnet';

  const activeCodexModel = applyCodexMode(settings, TEST_SESSION_ID);
  writeJsonFile(claudeJsonPath, { additionalModelOptionsCache: CODEX_MODEL_OPTIONS });
  writeJsonFile(statePath, buildModelModeState(activeCodexModel));
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  let claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
  const codexCache = Array.isArray(claudeJson.additionalModelOptionsCache)
    ? claudeJson.additionalModelOptionsCache
    : [...CODEX_MODEL_OPTIONS];

  assert.equal(settings.model, undefined, 'expected Codex mode not to persist a shared Claude model override');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, undefined);
  assert.ok(true, 'expected additionalModelOptionsCache to exist');
  assert.equal(codexCache.length, CODEX_MODEL_OPTIONS.length, 'expected canonical codex model option count');
  assert.equal(new Set(codexCache.map((option) => option.value)).size, CODEX_MODEL_OPTIONS.length, 'expected unique codex model values');
  assert.deepEqual(codexCache, CODEX_MODEL_OPTIONS, 'expected canonical codex model options');
  assert.ok(codexCache.some((option) => option.value === 'gpt-5.5'), 'expected gpt-5.5 model option');
  assert.ok(codexCache.some((option) => option.value === 'gpt-5.3-codex-spark'), 'expected codex-spark model option');

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.mode, 'codex');
  assert.equal(state.model, CODEX_MODEL_OPTIONS[0].label);
  assert.equal(getCodexConfigDir(tempHome), claudeCodexDir, 'codex config dir should be isolated at ~/.claude-codex');
  assert.equal(getCodexClaudeJsonPath(tempHome), claudeJsonPath, 'codex model cache should live at ${CLAUDE_CONFIG_DIR}/.claude.json (non-hashed) to match Claude Code v2.1+ resolver');

  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.env ??= {};
  settings.model = 'sonnet';
  applyClaudeMode(settings, tempCwd, TEST_SESSION_ID);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  writeJsonFile(claudeJsonPath, { additionalModelOptionsCache: [] });

  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));

  assert.equal(settings.model, undefined, 'expected Claude mode not to persist a shared Claude model override');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.deepEqual(claudeJson.additionalModelOptionsCache, [], 'expected Claude mode to clear codex model options');

  console.log('model mode switch test passed');
} finally {
  process.chdir(origCwd);
  if (savedEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = savedEnv.HOME;
  if (savedEnv.CLAUDE_CODEX_SETTINGS_PATH === undefined) delete process.env.CLAUDE_CODEX_SETTINGS_PATH;
  else process.env.CLAUDE_CODEX_SETTINGS_PATH = savedEnv.CLAUDE_CODEX_SETTINGS_PATH;
}
