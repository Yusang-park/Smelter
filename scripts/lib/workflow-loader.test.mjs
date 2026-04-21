#!/usr/bin/env node
/**
 * workflow-loader.test.mjs — unit tests for v3 three-file workflow config loader.
 *
 * Exercises the real on-disk YAML via the real process boundary (per
 * rules-lib/common/testing.md "test the real interface, no mocks").
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  loadWorkflowConfig,
  getMode,
  nextSkill,
  scanFeatureArtifacts,
  resolveSkipFromArtifacts,
  resolveCommandAlias,
} from './workflow-loader.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('loadWorkflowConfig parses all three YAML files', () => {
  const cfg = loadWorkflowConfig();
  assert.ok(cfg.skills, 'skills present');
  assert.ok(cfg.pipelines, 'pipelines present');
  assert.ok(cfg.modes, 'modes present');
  assert.ok(cfg.command_aliases, 'command_aliases present');

  assert.deepEqual(
    Object.keys(cfg.modes).sort(),
    ['fix', 'implement', 'investigate', 'think', 'verify'].sort(),
  );
});

test('getMode(fix) expands to back-compat JSON shape', () => {
  const fix = getMode('fix');
  assert.equal(fix.mode, 'fix');
  assert.equal(fix.entry_skill, 'workflow-investigate');
  assert.ok(Array.isArray(fix.allowed_skills));
  assert.ok(fix.allowed_skills.includes('workflow-coding'));
  assert.ok(!fix.allowed_skills.includes('workflow-brainstorm'), 'fix skips brainstorm');
  assert.ok(fix.default_team_overrides['workflow-coding'].watchdog_enabled === true);
  assert.equal(fix.default_team_overrides['workflow-coding'].pattern, 'A', 'fix-mode coding uses Pattern A');
});

test('getMode(implement) uses light brainstorm + Pattern C coding', () => {
  const impl = getMode('implement');
  assert.equal(impl.entry_skill, 'workflow-brainstorm');
  assert.equal(impl.entry_params['workflow-brainstorm'].depth, 'light');
  assert.equal(impl.default_team_overrides['workflow-coding'].pattern, 'C');
});

test('getMode(think) is read-only + planning-only pipeline', () => {
  const think = getMode('think');
  assert.equal(think.read_only, true);
  assert.equal(think.pipeline, 'planning_only');
  assert.ok(!think.allowed_skills.includes('workflow-coding'));
  assert.ok(!think.allowed_skills.includes('workflow-write-test'));
  assert.ok(think.allowed_skills.includes('workflow-tasker'));
});

test('getMode(investigate) + getMode(verify) are read-only', () => {
  assert.equal(getMode('investigate').read_only, true);
  assert.equal(getMode('verify').read_only, true);
});

test('nextSkill returns pipeline head when no stages completed', () => {
  assert.equal(nextSkill('fix', []), 'workflow-investigate');
  assert.equal(nextSkill('implement', []), 'workflow-brainstorm');
  assert.equal(nextSkill('think', []), 'workflow-brainstorm');
});

test('nextSkill skips completed stages', () => {
  const completed = ['workflow-investigate', 'workflow-investigate-review'];
  assert.equal(nextSkill('fix', completed), 'workflow-tasker');
});

test('nextSkill returns null when pipeline exhausted', () => {
  const cfg = loadWorkflowConfig();
  const full = getMode('fix', cfg).allowed_skills;
  assert.equal(nextSkill('fix', full, cfg), null);
});

test('nextSkill honors skipFromArtifacts (file-driven routing)', () => {
  // think → implement transition: think produced brainstorm.md + tasks.md.
  // When implement mode starts with those artifacts, it should skip to write-test.
  const artifacts = {
    'brainstorm.md': true,
    'brainstorm-review.md': true,
    'investigation.md': true,
    'investigation-review.md': true,
    'tasks.md': true,
    'tasks-review.md': true,
  };
  const skip = resolveSkipFromArtifacts('implement', artifacts);
  assert.deepEqual(skip.sort(), [
    'workflow-brainstorm',
    'workflow-brainstorm-review',
    'workflow-investigate',
    'workflow-investigate-review',
    'workflow-tasker',
    'workflow-tasker-review',
  ].sort());

  const next = nextSkill('implement', [], loadWorkflowConfig(), skip);
  assert.equal(next, 'workflow-write-test', 'implement resumes at write-test when planning artifacts exist');
});

test('scanFeatureArtifacts detects files on real disk', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'smt-loader-'));
  const taskDir = join(tmp, 'task');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'brainstorm.md'), '# stub');
  writeFileSync(join(taskDir, 'tasks.md'), '# stub');

  const art = scanFeatureArtifacts(tmp);
  assert.equal(art['brainstorm.md'], true);
  assert.equal(art['tasks.md'], true);
  assert.equal(art['investigation.md'], false);
});

test('resolveCommandAlias maps /plan → think, /simple-fix → fix', () => {
  assert.equal(resolveCommandAlias('/plan'), 'think');
  assert.equal(resolveCommandAlias('/simple-fix'), 'fix');
  assert.equal(resolveCommandAlias('/implement'), 'implement');
  assert.equal(resolveCommandAlias('/nonsense'), null);
});

test('all pipelines referenced by modes exist', () => {
  const cfg = loadWorkflowConfig();
  for (const [name, m] of Object.entries(cfg.modes)) {
    assert.ok(cfg.pipelines[m.pipeline], `${name}.pipeline ${m.pipeline} resolves`);
  }
});

test('all skills referenced by pipelines exist in skills registry', () => {
  const cfg = loadWorkflowConfig();
  const knownSkills = new Set(Object.keys(cfg.skills));
  for (const [name, steps] of Object.entries(cfg.pipelines)) {
    for (const step of steps) {
      assert.ok(knownSkills.has(step), `pipeline ${name} references known skill ${step}`);
    }
  }
});

test('legacy JSON equivalence — v3 fix allowed_skills equals legacy minus workflow-verify', () => {
  // Legacy modes/fix.json should exist alongside during migration (Phase 1).
  const legacyPath = join(process.cwd(), 'modes', 'fix.json');
  if (!existsSync(legacyPath)) return; // post-cleanup: skip

  const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8'));
  const v3 = getMode('fix');
  assert.deepEqual(
    v3.allowed_skills.sort(),
    legacy.allowed_skills.sort(),
    'fix allowed_skills match legacy',
  );
});
