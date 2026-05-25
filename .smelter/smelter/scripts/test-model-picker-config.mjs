#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'model-picker-config-'));
const tempCwd = mkdtempSync(join(tmpdir(), 'model-picker-cwd-'));
const claudeJsonPath = join(tempHome, '.claude.json');
const TEST_SID = 'test-session-picker';
const modelModeStatePath = join(tempCwd, '.smt', 'state', `model-mode-${TEST_SID}.json`);
const settingsPath = join(tempHome, '.claude', 'settings.json');
const savedSettingsPathEnv = process.env.CLAUDE_CODEX_SETTINGS_PATH;

mkdirSync(join(tempCwd, '.smt', 'state'), { recursive: true });
writeFileSync(claudeJsonPath, JSON.stringify({ someOtherKey: true }) + '\n');

process.env.CLAUDE_CODEX_SETTINGS_PATH = settingsPath;

const { CODEX_MODEL_OPTIONS } = await import('./lib/codex-models.mjs');
const { patchClaudeJson, buildModelModeState, writeJsonFile } = await import('./set-model-mode.mjs');

try {
  mkdirSync(join(tempHome, '.claude'), { recursive: true });
  const settings = {};
  settings.model = 'sonnet';
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  patchClaudeJson(CODEX_MODEL_OPTIONS, claudeJsonPath);
  writeJsonFile(modelModeStatePath, buildModelModeState());

  const claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
  const cache = claudeJson.additionalModelOptionsCache;
  assert.deepEqual(cache, CODEX_MODEL_OPTIONS, 'expected codex model options to be written to ~/.claude.json');
  assert.equal(new Set(cache.map((option) => option.value)).size, cache.length, 'expected all model values to be unique');

  const modelModeState = JSON.parse(readFileSync(modelModeStatePath, 'utf8'));
  assert.equal(modelModeState.mode, 'codex');
  assert.equal(modelModeState.model, CODEX_MODEL_OPTIONS[0].label);

  console.log('model picker config test passed');
} finally {
  if (savedSettingsPathEnv === undefined) delete process.env.CLAUDE_CODEX_SETTINGS_PATH;
  else process.env.CLAUDE_CODEX_SETTINGS_PATH = savedSettingsPathEnv;
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
}
