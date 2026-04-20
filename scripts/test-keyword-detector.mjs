#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'keyword-detector.mjs');

function runDetector({ cwd, prompt, sessionId = 'test-session' }) {
  const input = JSON.stringify({
    cwd,
    session_id: sessionId,
    prompt,
  });

  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    input,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readdirSyncSafe(path) {
  try { return readdirSync(path); } catch { return []; }
}

test('natural language planning phrase routes to /plan', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-'));

  try {
    const result = runDetector({ cwd, prompt: 'plan this feature for me' });

    assert.equal(result.continue, true);
    assert.match(result.hookSpecificOutput.additionalContext, /Skill: plan/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('explicit /investigate command routes to investigate skill', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-'));

  try {
    const result = runDetector({ cwd, prompt: '/investigate the auth regression' });

    assert.equal(result.continue, true);
    assert.match(result.hookSpecificOutput.additionalContext, /Skill: investigate/);
    assert.match(result.hookSpecificOutput.additionalContext, /MAGIC KEYWORD: INVESTIGATE/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('keyword-detector bails out when invoked inside a classifier subprocess', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-'));

  try {
    const classifierPrompt = 'You are a command classifier for a CLI tool called "smelter". Classify the user\'s prompt...';
    const input = JSON.stringify({ cwd, session_id: 'test', prompt: classifierPrompt });
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      input,
      encoding: 'utf8',
      env: { ...process.env, SMELTER_CLASSIFIER_SUBPROCESS: '1' },
    });

    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.deepEqual(out, { continue: true }, 'classifier subprocess must not seed state or inject skill payload');
    // And no .smt state should be written when the subprocess flag is set.
    assert.equal(existsSync(join(cwd, '.smt', 'features')), false, '.smt/features must not be created inside classifier subprocess');
    assert.equal(existsSync(join(cwd, '.smt', 'state', 'active-feature.json')), false, 'active-feature.json must not be written inside classifier subprocess');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('/fix seeds .state.json with mode=fix and allowed_skills from modes/fix.json', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-'));

  try {
    runDetector({ cwd, prompt: '/fix login validation bug' });

    const taskDirs = readdirSyncSafe(join(cwd, '.smt', 'features'));
    assert.ok(taskDirs.length > 0, 'expected .smt/features/<slug>/ to be created');
    const taskDir = join(cwd, '.smt', 'features', taskDirs[0], 'task');
    const stateFiles = readdirSyncSafe(taskDir).filter((f) => f.endsWith('.state.json'));
    assert.equal(stateFiles.length, 1, 'expected exactly one *.state.json to be seeded');

    const state = readJson(join(taskDir, stateFiles[0]));
    assert.equal(state.mode, 'fix');
    assert.equal(state.current_stage, 'workflow-investigate');
    assert.ok(state.allowed_skills.includes('workflow-investigate'),
      'allowed_skills must include workflow-investigate (the /fix entry skill)');
    assert.ok(state.allowed_skills.includes('workflow-human-check'),
      'allowed_skills must include workflow-human-check (the /fix exit gate)');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('natural-language "investigate" routes to /investigate, not /plan', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-'));

  try {
    const result = runDetector({
      cwd,
      prompt: 'Assign agent teams to investigate at least three security vulnerabilities each in the backend and frontend',
    });

    assert.equal(result.continue, true);
    assert.match(result.hookSpecificOutput.additionalContext, /Skill: investigate/);
    assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /Skill: plan\b/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('explicit /investigate reseeds mode instead of reusing in-flight fix state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'keyword-detector-'));

  try {
    runDetector({ cwd, prompt: '/fix login validation bug' });
    const firstSlug = readdirSyncSafe(join(cwd, '.smt', 'features'))[0];
    const firstStatePath = join(cwd, '.smt', 'features', firstSlug, 'task', `${firstSlug}.state.json`);
    const firstState = readJson(firstStatePath);
    assert.equal(firstState.mode, 'fix');

    const result = runDetector({ cwd, prompt: '/investigate why auto-confirm advances incorrectly' });
    assert.match(result.hookSpecificOutput.additionalContext, /Skill: investigate/);

    const taskDirs = readdirSyncSafe(join(cwd, '.smt', 'features'));
    assert.ok(taskDirs.length >= 2, 'expected investigate to create a fresh feature state');
    const investigateSlug = taskDirs.find((slug) => slug !== firstSlug);
    assert.ok(investigateSlug, 'expected a distinct investigate slug');
    const investigateState = readJson(join(cwd, '.smt', 'features', investigateSlug, 'task', `${investigateSlug}.state.json`));
    assert.equal(investigateState.mode, 'investigate');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
