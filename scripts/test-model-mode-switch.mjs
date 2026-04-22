#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const tempHome = mkdtempSync(join(tmpdir(), 'model-mode-switch-home-'));
const tempCwd = mkdtempSync(join(tmpdir(), 'model-mode-switch-cwd-'));
const claudeDir = join(tempHome, '.claude');
const scopedHash = createHash('sha256').update(tempCwd.normalize('NFC')).digest('hex').slice(0, 8);
const claudeJsonPath = join(claudeDir, `.claude-${scopedHash}.json`);
const stateDir = join(tempCwd, '.smt', 'state');
const statePath = join(stateDir, 'model-mode.json');
const settingsPath = join(claudeDir, 'settings.json');
const savedEnv = {
  HOME: process.env.HOME,
  CLAUDE_CODEX_SETTINGS_PATH: process.env.CLAUDE_CODEX_SETTINGS_PATH,
};

mkdirSync(stateDir, { recursive: true });
mkdirSync(claudeDir, { recursive: true });
writeFileSync(claudeJsonPath, JSON.stringify({ bootstrap: true }) + '\n');
writeFileSync(settingsPath, JSON.stringify({ env: {}, model: 'sonnet' }) + '\n');

process.env.HOME = tempHome;
process.env.CLAUDE_CODEX_SETTINGS_PATH = settingsPath;

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

  const activeCodexModel = applyCodexMode(settings);
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
  assert.equal(codexCache.length, 4, 'expected 4 codex model options');
  assert.equal(new Set(codexCache.map((option) => option.value)).size, 4, 'expected unique codex model values');
  assert.deepEqual(codexCache, CODEX_MODEL_OPTIONS, 'expected canonical codex model options');
  assert.ok(codexCache.some((option) => option.value === 'gpt-5.3-codex-spark'), 'expected codex-spark model option');

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.mode, 'codex');
  assert.equal(state.model, 'Codex gpt-5.4');
  assert.equal(getCodexConfigDir(tempHome), claudeDir, 'codex config dir should share ~/.claude for session history');
  assert.equal(getCodexClaudeJsonPath(tempCwd, tempHome), claudeJsonPath, 'codex model cache should live in scoped ~/.claude/.claude-<hash>.json');

  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.env ??= {};
  settings.model = 'sonnet';
  applyClaudeMode(settings, tempCwd);
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
  if (savedEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = savedEnv.HOME;
  if (savedEnv.CLAUDE_CODEX_SETTINGS_PATH === undefined) delete process.env.CLAUDE_CODEX_SETTINGS_PATH;
  else process.env.CLAUDE_CODEX_SETTINGS_PATH = savedEnv.CLAUDE_CODEX_SETTINGS_PATH;
}
