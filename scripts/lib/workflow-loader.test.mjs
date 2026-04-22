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

test('getMode(fix) has target_type_dispatch: true and default pipeline=fix', () => {
  const fix = getMode('fix');
  assert.equal(fix.target_type_dispatch, true);
  assert.equal(fix.pipeline, 'fix');
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

test('pipeline set: fix / extend_light / fix_simple / full exist; medium removed', () => {
  const cfg = loadWorkflowConfig();
  assert.ok(cfg.pipelines.fix, 'fix pipeline must exist');
  assert.ok(cfg.pipelines.extend_light, 'extend_light pipeline must exist');
  assert.ok(cfg.pipelines.fix_simple, 'fix_simple pipeline must exist');
  assert.ok(cfg.pipelines.full, 'full pipeline must exist');
  assert.equal(cfg.pipelines.medium, undefined, 'medium pipeline must be removed');
});

test('all fix/implement pipelines terminate with workflow-human-check', () => {
  const cfg = loadWorkflowConfig();
  for (const pipeline of ['fix', 'extend_light', 'fix_simple', 'full']) {
    const steps = cfg.pipelines[pipeline];
    assert.equal(steps[steps.length - 1], 'workflow-human-check',
      `pipeline ${pipeline} must end with workflow-human-check`);
  }
});

test('fix pipeline is 8 skills including investigate-review, no tasker, no team-code-review', () => {
  const cfg = loadWorkflowConfig();
  const steps = cfg.pipelines.fix;
  assert.equal(steps.length, 8);
  assert.ok(steps.includes('workflow-investigate-review'));
  assert.ok(!steps.includes('workflow-tasker'));
  assert.ok(!steps.includes('workflow-tasker-review'));
  assert.ok(!steps.includes('workflow-team-code-review'));
  assert.ok(!steps.includes('workflow-brainstorm'));
});

test('extend_light pipeline is 9 skills with tasker but no tasker-review / no team-code-review / no brainstorm', () => {
  const cfg = loadWorkflowConfig();
  const steps = cfg.pipelines.extend_light;
  assert.equal(steps.length, 9);
  assert.ok(steps.includes('workflow-tasker'));
  assert.ok(!steps.includes('workflow-tasker-review'));
  assert.ok(!steps.includes('workflow-team-code-review'));
  assert.ok(!steps.includes('workflow-brainstorm'));
  assert.ok(!steps.includes('workflow-brainstorm-review'));
});

test('selectPipeline: fix without target_type uses default (fix)', () => {
  assert.equal(selectPipeline('fix', {}), 'fix');
});

test('selectPipeline: fix + typo / dialogue → fix_simple', () => {
  assert.equal(selectPipeline('fix', { target_type: 'typo' }), 'fix_simple');
  assert.equal(selectPipeline('fix', { target_type: 'dialogue' }), 'fix_simple');
});

test('selectPipeline: fix + bug_fix → fix regardless of scope', () => {
  assert.equal(selectPipeline('fix', { target_type: 'bug_fix' }), 'fix');
  assert.equal(selectPipeline('fix', { target_type: 'bug_fix', file_count: 10, surface_count: 5 }), 'fix');
});

test('selectPipeline: fix + extend_existing → upgrade_required (use /implement)', () => {
  assert.equal(selectPipeline('fix', { target_type: 'extend_existing' }), 'upgrade_required');
});

test('selectPipeline: implement + extend_existing → extend_light', () => {
  assert.equal(selectPipeline('implement', { target_type: 'extend_existing' }), 'extend_light');
});

test('selectPipeline: implement without target_type → full (default)', () => {
  assert.equal(selectPipeline('implement', {}), 'full');
  assert.equal(selectPipeline('implement', { target_type: 'new_feature' }), 'full');
});

test('selectPipeline: fix + new_feature / refactor / migration → upgrade_required', () => {
  assert.equal(selectPipeline('fix', { target_type: 'new_feature' }), 'upgrade_required');
  assert.equal(selectPipeline('fix', { target_type: 'refactor' }), 'upgrade_required');
  assert.equal(selectPipeline('fix', { target_type: 'migration' }), 'upgrade_required');
});

test('selectPipeline: non-dispatching modes always return declared pipeline', () => {
  assert.equal(selectPipeline('think', { target_type: 'typo' }), 'planning_only');
  assert.equal(selectPipeline('investigate', {}), 'investigate_only');
  assert.equal(selectPipeline('verify', {}), 'verify_only');
});

test('getVerificationRounds: mid reviews = 2 (no mode)', () => {
  for (const skill of ['workflow-brainstorm-review', 'workflow-investigate-review', 'workflow-tasker-review', 'workflow-agent-review']) {
    assert.equal(getVerificationRounds(skill), 2, `${skill} should be mid_pipeline=2`);
  }
});

test('getVerificationRounds: terminal reviews = 3 (no mode)', () => {
  for (const skill of ['workflow-e2e-review', 'workflow-team-code-review', 'workflow-human-check']) {
    assert.equal(getVerificationRounds(skill), 3, `${skill} should be terminal=3`);
  }
});

test('getVerificationRounds: non-review skills default to mid_pipeline', () => {
  assert.equal(getVerificationRounds('workflow-investigate'), 2);
  assert.equal(getVerificationRounds('workflow-coding'), 2);
  assert.equal(getVerificationRounds('workflow-unknown'), 2);
});

test('getVerificationRounds with mode=fix: all mid reviews → 1, e2e-review → 2, human-check → 3', () => {
  assert.equal(getVerificationRounds('workflow-investigate-review', 'fix'), 1);
  assert.equal(getVerificationRounds('workflow-agent-review', 'fix'), 1);
  assert.equal(getVerificationRounds('workflow-brainstorm-review', 'fix'), 1);
  assert.equal(getVerificationRounds('workflow-tasker-review', 'fix'), 1);
  assert.equal(getVerificationRounds('workflow-e2e-review', 'fix'), 2);
  assert.equal(getVerificationRounds('workflow-human-check', 'fix'), 3);
});

test('getVerificationRounds with mode=implement: rounds unchanged (2/3)', () => {
  assert.equal(getVerificationRounds('workflow-investigate-review', 'implement'), 2);
  assert.equal(getVerificationRounds('workflow-e2e-review', 'implement'), 3);
  assert.equal(getVerificationRounds('workflow-human-check', 'implement'), 3);
});

test('nextSkill returns first skill of pipeline when nothing completed', () => {
  assert.equal(nextSkill('fix', []), 'workflow-investigate');
  assert.equal(nextSkill('implement', []), 'workflow-brainstorm');
  assert.equal(nextSkill('think', []), 'workflow-brainstorm');
});

test('nextSkill skips completed stages', () => {
  // fix default pipeline = fix (no tasker); next after investigate + investigate-review is write-test.
  const completed = ['workflow-investigate', 'workflow-investigate-review'];
  assert.equal(nextSkill('fix', completed), 'workflow-write-test');
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
