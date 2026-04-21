#!/usr/bin/env node
/**
 * workflow-loader.test.mjs — unit tests for v3.1 unified workflow config loader.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadWorkflowConfig,
  getMode,
  nextSkill,
  scanFeatureArtifacts,
  resolveSkipFromArtifacts,
  resolveCommandAlias,
  selectPipeline,
  getVerificationRounds,
} from './workflow-loader.mjs';

test('loadWorkflowConfig parses the unified workflow.yaml', () => {
  const cfg = loadWorkflowConfig();
  assert.equal(cfg.schema_version, '3.1.0');
  assert.ok(cfg.skills, 'skills present');
  assert.ok(cfg.pipelines, 'pipelines present');
  assert.ok(cfg.modes, 'modes present');
  assert.ok(cfg.command_aliases, 'command_aliases present');
  assert.ok(cfg.target_type_routing, 'target_type_routing present');
  assert.ok(cfg.verification_rounds, 'verification_rounds present');

  assert.deepEqual(
    Object.keys(cfg.modes).sort(),
    ['fix', 'implement', 'investigate', 'think', 'verify'].sort(),
  );
});

test('verification_rounds globals', () => {
  const cfg = loadWorkflowConfig();
  assert.equal(cfg.verification_rounds.mid_pipeline, 2);
  assert.equal(cfg.verification_rounds.terminal, 3);
});

test('legacy split files are removed (modes/{skills,pipelines,modes}.yaml)', () => {
  for (const f of ['skills.yaml', 'pipelines.yaml', 'modes.yaml']) {
    assert.equal(existsSync(join(process.cwd(), 'modes', f)), false, `legacy ${f} must be removed`);
  }
});

test('no legacy modes/*.json files remain', () => {
  const legacyFiles = ['fix.json', 'implement.json', 'investigate.json', 'verify.json', 'plan.json', 'simple_fix.json'];
  const modesDir = join(process.cwd(), 'modes');
  for (const f of legacyFiles) {
    assert.equal(existsSync(join(modesDir, f)), false, `legacy ${f} must be removed`);
  }
});

test('getMode(fix) has target_type_dispatch: true and default pipeline=medium', () => {
  const fix = getMode('fix');
  assert.equal(fix.target_type_dispatch, true);
  assert.equal(fix.pipeline, 'medium');
  assert.equal(fix.entry_skill, 'workflow-investigate');
  assert.ok(!fix.allowed_skills.includes('workflow-brainstorm'));
});

test('getMode(implement) uses full pipeline and light brainstorm', () => {
  const impl = getMode('implement');
  assert.equal(impl.entry_skill, 'workflow-brainstorm');
  assert.equal(impl.entry_params['workflow-brainstorm'].depth, 'light');
  assert.equal(impl.pipeline, 'full');
  assert.equal(impl.default_team_overrides['workflow-coding'].pattern, 'C');
});

test('getMode(think) read-only + planning_only pipeline', () => {
  const think = getMode('think');
  assert.equal(think.read_only, true);
  assert.equal(think.pipeline, 'planning_only');
  assert.ok(!think.allowed_skills.includes('workflow-coding'));
  assert.ok(think.allowed_skills.includes('workflow-tasker'));
});

test('getMode(investigate) + getMode(verify) read-only', () => {
  assert.equal(getMode('investigate').read_only, true);
  assert.equal(getMode('verify').read_only, true);
});

test('fix pipeline terminates with workflow-human-check across medium/light/minimal', () => {
  const cfg = loadWorkflowConfig();
  for (const pipeline of ['medium', 'light', 'minimal', 'full']) {
    const steps = cfg.pipelines[pipeline];
    assert.equal(steps[steps.length - 1], 'workflow-human-check',
      `pipeline ${pipeline} must end with workflow-human-check`);
  }
});

test('selectPipeline: fix without target_type uses default (medium)', () => {
  assert.equal(selectPipeline('fix', {}), 'medium');
});

test('selectPipeline: fix + typo → minimal', () => {
  assert.equal(selectPipeline('fix', { target_type: 'typo' }), 'minimal');
  assert.equal(selectPipeline('fix', { target_type: 'dialogue' }), 'minimal');
});

test('selectPipeline: fix + extend_existing → medium (user direction)', () => {
  assert.equal(selectPipeline('fix', { target_type: 'extend_existing' }), 'medium');
});

test('selectPipeline: fix + bug_fix simple → light', () => {
  assert.equal(selectPipeline('fix', { target_type: 'bug_fix', file_count: 2, surface_count: 1 }), 'light');
});

test('selectPipeline: fix + bug_fix with >3 files → medium (scope upgrade)', () => {
  assert.equal(selectPipeline('fix', { target_type: 'bug_fix', file_count: 4, surface_count: 1 }), 'medium');
});

test('selectPipeline: fix + bug_fix with multi-surface → medium', () => {
  assert.equal(selectPipeline('fix', { target_type: 'bug_fix', file_count: 2, surface_count: 2 }), 'medium');
});

test('selectPipeline: fix + new_feature → upgrade_required', () => {
  assert.equal(selectPipeline('fix', { target_type: 'new_feature' }), 'upgrade_required');
  assert.equal(selectPipeline('fix', { target_type: 'refactor' }), 'upgrade_required');
  assert.equal(selectPipeline('fix', { target_type: 'migration' }), 'upgrade_required');
});

test('selectPipeline: non-dispatching modes always return declared pipeline', () => {
  assert.equal(selectPipeline('think', { target_type: 'typo' }), 'planning_only');
  assert.equal(selectPipeline('implement', { target_type: 'typo' }), 'full');
  assert.equal(selectPipeline('investigate', {}), 'investigate_only');
  assert.equal(selectPipeline('verify', {}), 'verify_only');
});

test('getVerificationRounds: mid reviews = 2', () => {
  for (const skill of ['workflow-brainstorm-review', 'workflow-investigate-review', 'workflow-tasker-review', 'workflow-agent-review']) {
    assert.equal(getVerificationRounds(skill), 2, `${skill} should be mid_pipeline=2`);
  }
});

test('getVerificationRounds: terminal reviews = 3', () => {
  for (const skill of ['workflow-e2e-review', 'workflow-team-code-review', 'workflow-human-check']) {
    assert.equal(getVerificationRounds(skill), 3, `${skill} should be terminal=3`);
  }
});

test('getVerificationRounds: non-review skills default to mid_pipeline', () => {
  assert.equal(getVerificationRounds('workflow-investigate'), 2);
  assert.equal(getVerificationRounds('workflow-coding'), 2);
  assert.equal(getVerificationRounds('workflow-unknown'), 2);
});

test('nextSkill returns first skill of pipeline when nothing completed', () => {
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
  const artifacts = {
    'brainstorm.md': true,
    'brainstorm-review.md': true,
    'investigation.md': true,
    'investigation-review.md': true,
    'tasks.md': true,
    'tasks-review.md': true,
  };
  const skip = resolveSkipFromArtifacts('implement', artifacts);
  const next = nextSkill('implement', [], loadWorkflowConfig(), skip);
  assert.equal(next, 'workflow-write-test');
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

test('resolveCommandAlias v3 canonical set only', () => {
  assert.equal(resolveCommandAlias('/think'), 'think');
  assert.equal(resolveCommandAlias('/fix'), 'fix');
  assert.equal(resolveCommandAlias('/implement'), 'implement');
  assert.equal(resolveCommandAlias('/investigate'), 'investigate');
  assert.equal(resolveCommandAlias('/verify'), 'verify');
  assert.equal(resolveCommandAlias('/plan'), null);
  assert.equal(resolveCommandAlias('/simple-fix'), null);
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
