#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'smelter-statusline-'));
const cwd = join(tempRoot, 'project');
const stateDir = join(cwd, '.omc', 'state');
const tempHome = join(tempRoot, 'home');
const modelModePath = join(tempHome, '.omc', 'state', 'model-mode.json');
const claudeJsonPath = join(tempHome, '.claude.json');
const hadExistingMode = existsSync(modelModePath);
const existingMode = hadExistingMode ? readFileSync(modelModePath, 'utf8') : null;

if (hadExistingMode) {
  rmSync(modelModePath, { force: true });
}

mkdirSync(stateDir, { recursive: true });
mkdirSync(join(tempHome, '.omc', 'state'), { recursive: true });
writeFileSync(claudeJsonPath, JSON.stringify({
  additionalModelOptionsCache: [
    { value: 'gpt-5.4', label: 'Codex gpt-5.4', description: 'Codex balanced model' },
  ],
}) + '\n');

function runHud(stdinData) {
  return execFileSync(
    'node',
    ['/Users/yusang/smelter/scripts/statusline-hud.mjs'],
    {
      input: JSON.stringify({ cwd, ...stdinData }),
      encoding: 'utf8',
      env: { ...process.env, HUD_DRY_RUN: '1', HOME: tempHome },
    },
  );
}

try {
  // Test 1: No mode badges when no mode is active
  const noModeOutput = runHud();
  assert.ok(!noModeOutput.includes('ULTRAWORK'), 'expected no ULTRAWORK badge when no mode is active');
  assert.ok(!noModeOutput.includes('ECO'), 'expected no ECO badge when no mode is active');

  // Test 2: ULTRAWORK badge when ultrawork mode is active
  writeFileSync(
    join(stateDir, 'ultrawork-state.json'),
    JSON.stringify({ active: true, started_at: new Date().toISOString() }, null, 2),
  );
  assert.match(runHud(), /ULTRAWORK/, 'expected ULTRAWORK badge when ultrawork mode is active');
  rmSync(join(stateDir, 'ultrawork-state.json'));

  // Test 3: Model label from settings
  writeFileSync(
    modelModePath,
    JSON.stringify({
      mode: 'codex',
      model: 'Codex gpt-5.4',
      updated_at: new Date().toISOString(),
    }, null, 2),
  );
  assert.match(runHud(), /Codex gpt-5\.4/, 'expected Codex model label when model mode is active');

  // Test 4: Percentage display when rate_limits in stdin
  const withPct = runHud({
    rate_limits: { five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
    model: { id: 'claude-opus-4-6[1m]', display_name: 'Opus 4.6 (1M context)' },
  });
  assert.match(withPct, /42%/, 'expected 5h percentage in output');

  // Test 5: Context window badges when context_window in stdin
  const withCtx = runHud({
    context_window: { context_window_size: 1000000, used_percentage: 15, total_output_tokens: 42600 },
    model: { id: 'claude-opus-4-6[1m]', display_name: 'Opus 4.6 (1M context)' },
  });
  assert.match(withCtx, /42\.6k out/, 'expected session output tokens badge');
  assert.match(withCtx, /ctx 15%/, 'expected context usage badge');

  // Test 6: Codex gpt-5.4 should be treated as a 1M main session even if Claude Code
  // reports the old 200k window on stdin.
  writeFileSync(
    modelModePath,
    JSON.stringify({
      mode: 'codex',
      model: 'Codex gpt-5.4',
      updated_at: new Date().toISOString(),
    }, null, 2),
  );
  const codexWithLegacyWindow = runHud({
    context_window: { context_window_size: 200000, total_input_tokens: 250000, total_output_tokens: 50000 },
    model: { id: 'gpt-5.4', display_name: 'gpt-5.4' },
  });
  assert.match(codexWithLegacyWindow, /Codex gpt-5\.4/, 'expected codex label for gpt-5.4');
  assert.match(codexWithLegacyWindow, /50\.0k out/, 'expected codex session output badge to render');
  assert.match(codexWithLegacyWindow, /ctx 25%/, 'expected codex context percent to be computed against 1M');

  console.log('statusline HUD test passed (6/6)');
} finally {
  if (hadExistingMode && existingMode != null) {
    writeFileSync(modelModePath, existingMode);
  } else if (existsSync(modelModePath)) {
    rmSync(modelModePath, { force: true });
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
