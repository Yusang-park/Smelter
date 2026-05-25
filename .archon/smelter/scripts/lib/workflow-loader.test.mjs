#!/usr/bin/env node
/**
 * workflow-loader.test.mjs — unit tests for v0.4 unified workflow config loader.
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
  assert.equal(cfg.schema_version, '0.55');
  assert.ok(cfg.skills, 'skills present');
  assert.ok(cfg.pipelines, 'pipelines present');
  assert.ok(cfg.modes, 'modes present');
  assert.ok(cfg.command_aliases, 'command_aliases present');
  assert.ok(cfg.target_type_routing, 'target_type_routing present');
  assert.ok(cfg.verification_rounds, 'verification_rounds present');
  assert.ok(Array.isArray(cfg.transition_adoptions), 'transition_adoptions present');

  assert.deepEqual(
    Object.keys(cfg.modes).sort(),
    ['brainstorm', 'fix', 'implement', 'infra', 'explore', 'verify'].sort(),
  );
});

test('transition_adoptions declares explore discovery reuse in workflow.yaml', () => {
  const cfg = loadWorkflowConfig();
  const policy = cfg.transition_adoptions.find(p => p.id === 'explore_discovery_to_write');
  assert.ok(policy, 'explore discovery adoption policy must be declared');
  assert.deepEqual(policy.from_modes, ['explore']);
  assert.deepEqual(policy.to_modes, ['fix', 'implement']);
  assert.deepEqual(policy.stages, ['workflow-investigate', 'workflow-investigate-review']);
  assert.equal(policy.copy_artifacts, true);
  assert.equal(policy.advance_to_next_uncompleted, true);
});

test('verification_rounds globals', () => {
  const cfg = loadWorkflowConfig();
  assert.deepEqual(Object.keys(cfg.verification_rounds).sort(), ['rounds']);
  assert.equal(cfg.verification_rounds.rounds, 2);
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

test('getMode(implement) starts with code investigation and implementation planning', () => {
  const impl = getMode('implement');
  assert.equal(impl.entry_skill, 'workflow-investigate');
  assert.equal(impl.entry_params['workflow-brainstorm'], undefined);
  assert.equal(impl.pipeline, 'full');
  assert.ok(!impl.allowed_skills.includes('workflow-brainstorm'));
  assert.ok(!impl.allowed_skills.includes('workflow-brainstorm-review'));
  assert.ok(impl.allowed_skills.includes('workflow-implementation-plan'));
  assert.ok(impl.allowed_skills.includes('workflow-implementation-plan-review'));
  assert.equal(impl.default_team_overrides['workflow-coding'].pattern, 'C');
});

test('getMode(brainstorm) read-only + planning_only pipeline', () => {
  const brainstorm = getMode('brainstorm');
  assert.equal(brainstorm.read_only, true);
  assert.equal(brainstorm.pipeline, 'planning_only');
  assert.equal(brainstorm.entry_skill, 'workflow-investigate');
  assert.deepEqual(brainstorm.allowed_skills.slice(0, 4), [
    'workflow-investigate',
    'workflow-investigate-review',
    'workflow-brainstorm',
    'workflow-brainstorm-review',
  ]);
  assert.ok(!brainstorm.allowed_skills.includes('workflow-coding'));
  assert.ok(brainstorm.allowed_skills.includes('workflow-tasker'));
});

test('getMode(explore) + getMode(verify) read-only', () => {
  assert.equal(getMode('explore').read_only, true);
  assert.equal(getMode('verify').read_only, true);
});

test('getMode(infra) uses the dedicated infrastructure workflow', () => {
  const infra = getMode('infra');
  assert.equal(infra.entry_skill, 'workflow-investigate');
  assert.equal(infra.pipeline, 'infra_ops');
  assert.equal(infra.read_only, false);
  assert.equal(infra.default_exempt.tdd, true);
  assert.equal(infra.default_exempt.e2e, false);
  assert.deepEqual(infra.allowed_skills, [
    'workflow-investigate',
    'workflow-investigate-review',
    'workflow-infra-plan',
    'workflow-infra-plan-review',
    'workflow-infra-execute',
    'workflow-verify',
    'workflow-human-check',
  ]);
});

test('pipeline set: fix / fix_simple / full exist; extend_light and medium removed', () => {
  const cfg = loadWorkflowConfig();
  assert.ok(cfg.pipelines.fix, 'fix pipeline must exist');
  assert.ok(cfg.pipelines.fix_simple, 'fix_simple pipeline must exist');
  assert.ok(cfg.pipelines.full, 'full pipeline must exist');
  assert.equal(cfg.pipelines.extend_light, undefined, 'extend_light pipeline must be removed');
  assert.equal(cfg.pipelines.medium, undefined, 'medium pipeline must be removed');
});

test('all fix/implement pipelines terminate with workflow-human-check', () => {
  const cfg = loadWorkflowConfig();
  for (const pipeline of ['fix', 'fix_simple', 'full']) {
    const steps = cfg.pipelines[pipeline];
    assert.equal(steps[steps.length - 1], 'workflow-human-check',
      `pipeline ${pipeline} must end with workflow-human-check`);
  }
});

test('fix pipeline records compact task checklist before write-test', () => {
  const cfg = loadWorkflowConfig();
  const steps = cfg.pipelines.fix;
  assert.equal(steps.length, 10);
  assert.deepEqual(steps.slice(0, 4), [
    'workflow-investigate',
    'workflow-investigate-review',
    'workflow-tasker',
    'workflow-tasker-review',
  ]);
  assert.equal(steps[4], 'workflow-write-test');
  assert.ok(!steps.includes('workflow-team-code-review'));
  assert.ok(!steps.includes('workflow-brainstorm'));
});

test('fix_simple skips tasker and goes directly from investigate to coding', () => {
  const cfg = loadWorkflowConfig();
  const steps = cfg.pipelines.fix_simple;
  assert.deepEqual(steps, [
    'workflow-investigate',
    'workflow-coding',
    'workflow-e2e',
    'workflow-human-check',
  ]);
});

test('implement full pipeline is code-based and does not include PM brainstorm or tasker stages', () => {
  const cfg = loadWorkflowConfig();
  const steps = cfg.pipelines.full;
  assert.deepEqual(steps.slice(0, 4), [
    'workflow-investigate',
    'workflow-investigate-review',
    'workflow-implementation-plan',
    'workflow-implementation-plan-review',
  ]);
  assert.ok(!steps.includes('workflow-brainstorm'));
  assert.ok(!steps.includes('workflow-brainstorm-review'));
  assert.ok(!steps.includes('workflow-tasker'));
  assert.ok(!steps.includes('workflow-tasker-review'));
  assert.ok(steps.includes('workflow-team-code-review'));
});

test('selectPipeline: fix without target_type uses default (fix)', () => {
  assert.equal(selectPipeline('fix', {}), 'fix');
});

test('selectPipeline: fix + text / design → fix_simple (v3.3: only these two surfaces)', () => {
  assert.equal(selectPipeline('fix', { target_type: 'text' }), 'fix_simple');
  assert.equal(selectPipeline('fix', { target_type: 'design' }), 'fix_simple');
});

test('selectPipeline: fix + bug_fix → fix regardless of scope', () => {
  assert.equal(selectPipeline('fix', { target_type: 'bug_fix' }), 'fix');
  assert.equal(selectPipeline('fix', { target_type: 'bug_fix', file_count: 10, surface_count: 5 }), 'fix');
});

test('selectPipeline: fix + extend_existing → upgrade_required (use /implement)', () => {
  assert.equal(selectPipeline('fix', { target_type: 'extend_existing' }), 'upgrade_required');
});

test('selectPipeline: implement + extend_existing stays on full pipeline', () => {
  assert.equal(selectPipeline('implement', { target_type: 'extend_existing' }), 'full');
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
  assert.equal(selectPipeline('brainstorm', { target_type: 'text' }), 'planning_only');
  assert.equal(selectPipeline('explore', {}), 'explore_only');
  assert.equal(selectPipeline('verify', {}), 'verify_only');
  assert.equal(selectPipeline('infra', { target_type: 'bug_fix' }), 'infra_ops');
});

test('getVerificationRounds: every skill uses the global 2-round policy', () => {
  for (const skill of [
    'workflow-brainstorm-review',
    'workflow-investigate-review',
    'workflow-implementation-plan-review',
    'workflow-tasker-review',
    'workflow-agent-review',
    'workflow-e2e-review',
    'workflow-team-code-review',
    'workflow-human-check',
  ]) {
    assert.equal(getVerificationRounds(skill), 2, `${skill} should use global rounds=2`);
  }
  assert.equal(getVerificationRounds('workflow-investigate'), 2);
  assert.equal(getVerificationRounds('workflow-coding'), 2);
  assert.equal(getVerificationRounds('workflow-unknown'), 2);
});

test('getVerificationRounds ignores mode-specific branching', () => {
  assert.equal(getVerificationRounds('workflow-investigate-review', 'fix'), 2);
  assert.equal(getVerificationRounds('workflow-agent-review', 'fix'), 2);
  assert.equal(getVerificationRounds('workflow-brainstorm-review', 'fix'), 2);
  assert.equal(getVerificationRounds('workflow-tasker-review', 'fix'), 2);
  assert.equal(getVerificationRounds('workflow-e2e-review', 'fix'), 2);
  assert.equal(getVerificationRounds('workflow-human-check', 'fix'), 2);
  assert.equal(getVerificationRounds('workflow-investigate-review', 'implement'), 2);
  assert.equal(getVerificationRounds('workflow-e2e-review', 'implement'), 2);
  assert.equal(getVerificationRounds('workflow-human-check', 'implement'), 2);
});

test('nextSkill returns first skill of pipeline when nothing completed', () => {
  assert.equal(nextSkill('fix', []), 'workflow-investigate');
  assert.equal(nextSkill('implement', []), 'workflow-investigate');
  assert.equal(nextSkill('brainstorm', []), 'workflow-investigate');
});

test('nextSkill skips completed stages', () => {
  // fix default pipeline records a compact task checklist before write-test.
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
  assert.equal(next, 'workflow-implementation-plan');
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

test('resolveCommandAlias v0.4 canonical set only', () => {
  assert.equal(resolveCommandAlias('/brainstorm'), 'brainstorm');
  assert.equal(resolveCommandAlias('/think'), null);
  assert.equal(resolveCommandAlias('/fix'), 'fix');
  assert.equal(resolveCommandAlias('/implement'), 'implement');
  assert.equal(resolveCommandAlias('/infra'), 'infra');
  assert.equal(resolveCommandAlias('/explore'), 'explore');
  assert.equal(resolveCommandAlias('/investigate'), null);
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
