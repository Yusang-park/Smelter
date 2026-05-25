#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'smelter-statusline-'));
const cwd = join(tempRoot, 'project');
const stateDir = join(cwd, '.smt', 'state');
const smtStateDir = join(cwd, '.smt', 'state');
const smtFeaturesDir = join(cwd, '.smt', 'features');
const tempHome = join(tempRoot, 'home');
const TEST_SID = 'test-session-statusline';
const legacyModelModePath = join(tempHome, '.smt', 'state', 'model-mode.json');
const projectModelModePath = join(smtStateDir, `model-mode-${TEST_SID}.json`);
const claudeJsonPath = join(tempHome, '.claude.json');
const hadExistingMode = existsSync(legacyModelModePath);
const existingMode = hadExistingMode ? readFileSync(legacyModelModePath, 'utf8') : null;

if (hadExistingMode) {
  rmSync(legacyModelModePath, { force: true });
}

mkdirSync(stateDir, { recursive: true });
mkdirSync(smtStateDir, { recursive: true });
mkdirSync(smtFeaturesDir, { recursive: true });
mkdirSync(join(tempHome, '.smt', 'state'), { recursive: true });

function writeProjectModelMode(mode) {
  writeFileSync(
    projectModelModePath,
    JSON.stringify({
      mode,
      model: 'Codex gpt-5.4',
      updated_at: new Date().toISOString(),
    }, null, 2),
  );
}

function writeLegacyModelMode(mode) {
  writeFileSync(
    legacyModelModePath,
    JSON.stringify({
      mode,
      model: 'Codex gpt-5.4',
      updated_at: new Date().toISOString(),
    }, null, 2),
  );
}

function writeWorkflowState({ slug = 'fix-login-typo', command = 'qa', step = 'step-10', featureTitle = 'fix-login-typo' } = {}) {
  const featureStateDir = join(smtFeaturesDir, slug, 'state');
  mkdirSync(featureStateDir, { recursive: true });
  writeFileSync(join(smtStateDir, 'active-feature.json'), JSON.stringify({ slug, updated_at: Date.now() }, null, 2));
  writeFileSync(join(featureStateDir, 'workflow.json'), JSON.stringify({
    command,
    step,
    retry: 0,
    updated_at: Date.now(),
    featureTitle,
  }, null, 2));
}

writeLegacyModelMode('claude');
writeProjectModelMode('codex');

const projectsDir = join(tempHome, '.claude', 'projects', '-tmp-test');
mkdirSync(projectsDir, { recursive: true });
writeFileSync(
  join(projectsDir, 'session.jsonl'),
  [
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { model: 'claude-opus-4-6', usage: { output_tokens: 1111 } },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { model: 'gpt-5.4', usage: { output_tokens: 2222 } },
    }),
  ].join('\n') + '\n',
);

mkdirSync(join(tempHome, '.claude', 'hud', 'last-model'), { recursive: true });
writeFileSync(claudeJsonPath, JSON.stringify({
  additionalModelOptionsCache: [
    { value: 'gpt-5.4', label: 'Codex gpt-5.4', description: 'Codex balanced model' },
    { value: 'gpt-5.3-codex-spark', label: 'Codex gpt-5.3-codex-spark', description: 'Codex spark model' },
  ],
}) + '\n');

function runHud(stdinData) {
  return execFileSync(
    'node',
    ['/Users/yusang/Smelter/.smelter/smelter/scripts/statusline-hud.mjs'],
    {
      input: JSON.stringify({ cwd, ...stdinData }),
      encoding: 'utf8',
      env: { ...process.env, HUD_DRY_RUN: '1', HOME: tempHome, SMELTER_SESSION_ID: TEST_SID },
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

  // Test 3: HUD should not duplicate model labels already shown by Claude Code,
  // including alternate Codex picker labels, and stale legacy state still must not leak.
  assert.doesNotMatch(runHud(), /Codex gpt-5\.4/, 'expected Codex model label to stay hidden in HUD');
  assert.doesNotMatch(runHud({ model: { id: 'gpt-5.3-codex-spark', display_name: 'gpt-5.3-codex-spark' } }), /gpt-5\.3-codex-spark/, 'expected codex-spark model label to stay hidden in HUD');
  assert.doesNotMatch(runHud(), /Sonnet 4\.6/, 'expected stale legacy mode state not to override project codex mode');

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
  const codexWithLegacyWindow = runHud({
    context_window: { context_window_size: 200000, total_input_tokens: 250000, total_output_tokens: 50000 },
    model: { id: 'gpt-5.4', display_name: 'gpt-5.4' },
  });
  assert.doesNotMatch(codexWithLegacyWindow, /gpt-5\.4(?!-)/, 'expected raw Codex model id to stay hidden in HUD');
  assert.match(codexWithLegacyWindow, /50\.0k out/, 'expected codex session output badge to render');
  assert.match(codexWithLegacyWindow, /ctx 25%/, 'expected codex context percent to be computed against 1M');

  // Test 7: 5h usage should prefer Codex-family transcript usage when project mode is codex.
  assert.match(codexWithLegacyWindow, /5h 2\.2k/, 'expected codex 5h usage instead of claude-family usage');
  assert.doesNotMatch(codexWithLegacyWindow, /5h 1\.1k/, 'expected claude-family 5h usage not to leak into codex window');

  // Test 8: non-gpt-5.4 Codex models should still display context badges for 200k windows.
  const codexMiniWindow = runHud({
    context_window: { context_window_size: 200000, total_input_tokens: 80000, total_output_tokens: 12000 },
    model: { id: 'gpt-5.4-mini', display_name: 'gpt-5.4-mini' },
  });
  assert.doesNotMatch(codexMiniWindow, /gpt-5\.4-mini/, 'expected model label to be hidden for Codex mini too');
  assert.match(codexMiniWindow, /12\.0k out/, 'expected codex mini session output badge to render');
  assert.match(codexMiniWindow, /ctx 40%/, 'expected codex mini context badge to render for 200k windows');

  // Test 9: workflow state should appear in HUD output, but task summary should not.
  writeWorkflowState({ slug: 'fix-login-typo', command: 'qa', step: 'step-10' });
  const withWorkflow = runHud();
  assert.match(withWorkflow, /QA MODE · fix-login-typo · step-10/, 'expected workflow status in HUD');
  assert.doesNotMatch(withWorkflow, /summarize|summary/i, 'expected HUD task summary line to be removed');

  console.log('statusline HUD test passed (9/9)');
} finally {
  if (hadExistingMode && existingMode != null) {
    writeFileSync(legacyModelModePath, existingMode);
  } else if (existsSync(legacyModelModePath)) {
    rmSync(legacyModelModePath, { force: true });
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
