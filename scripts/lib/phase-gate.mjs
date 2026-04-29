#!/usr/bin/env node

import { allowedActionsFor } from './workflow-v4-contract.mjs';

export const PHASES = Object.freeze([
  'INTENT',
  'DISCOVERY',
  'PLAN',
  'TEST_DESIGN',
  'EXECUTE',
  'VERIFY',
  'RECOVER',
  'HUMAN_CHECK',
  'DONE',
]);

const SKILL_PHASE = Object.freeze({
  'workflow-brainstorm': 'PLAN',
  'workflow-brainstorm-review': 'PLAN',
  'workflow-investigate': 'DISCOVERY',
  'workflow-investigate-review': 'DISCOVERY',
  'workflow-implementation-plan': 'PLAN',
  'workflow-implementation-plan-review': 'PLAN',
  'workflow-infra-plan': 'PLAN',
  'workflow-infra-plan-review': 'PLAN',
  'workflow-infra-execute': 'EXECUTE',
  'workflow-tasker': 'PLAN',
  'workflow-tasker-review': 'PLAN',
  'workflow-write-test': 'TEST_DESIGN',
  'workflow-coding': 'EXECUTE',
  'workflow-agent-review': 'VERIFY',
  'workflow-e2e': 'VERIFY',
  'workflow-e2e-review': 'VERIFY',
  'workflow-team-code-review': 'VERIFY',
  'workflow-verify': 'VERIFY',
  'workflow-human-check': 'HUMAN_CHECK',
});

const ARTIFACT_PHASE = Object.freeze({
  'brainstorm.md': 'PLAN',
  'brainstorm-review.md': 'PLAN',
  'investigation.md': 'DISCOVERY',
  'investigation-review.md': 'DISCOVERY',
  'implementation-plan.md': 'PLAN',
  'implementation-plan-review.md': 'PLAN',
  'infra-plan.md': 'PLAN',
  'infra-plan-review.md': 'PLAN',
  'infra-execute.md': 'EXECUTE',
  'tasks.md': 'PLAN',
  'tasks-review.md': 'PLAN',
  'agent-review.md': 'VERIFY',
  'e2e-review.md': 'VERIFY',
  'results.md': 'HUMAN_CHECK',
});

function allow(reason = 'allowed') {
  return { decision: 'allow', reason };
}

function block(reason) {
  return { decision: 'block', reason };
}

export function phaseForSkill(skill) {
  return SKILL_PHASE[String(skill || '').replace(/^\/+/, '')] ?? null;
}

export function phaseForArtifactPath(filePath) {
  const base = String(filePath || '').split(/[\/\\]/).pop() || '';
  return ARTIFACT_PHASE[base] ?? null;
}

export function currentPhase(state) {
  return state?.phase || state?.step || phaseForSkill(state?.current_stage) || null;
}

export function nextRequiredPhase(state) {
  const flow = Array.isArray(state?.phase_flow) ? state.phase_flow : state?.step_flow;
  const cur = currentPhase(state);
  if (!Array.isArray(flow) || !cur) return null;
  const idx = flow.indexOf(cur);
  if (idx < 0 || idx >= flow.length - 1) return null;
  return flow[idx + 1];
}

export function isTestPath(filePath) {
  const path = String(filePath || '');
  return /(?:^|[\/\\])(?:test|tests|spec|e2e)[\/\\]/i.test(path) ||
    /(?:^|[\/\\])[^\/\\]+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|sh)$/i.test(path);
}

export function isSourcePath(filePath) {
  if (!filePath) return false;
  if (/[\/\\]\.smt[\/\\]/.test(filePath)) return false;
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|pl|java|kt|kts|scala|groovy|c|cc|cpp|cxx|h|hh|hpp|hxx|swift|m|mm|sh|bash|zsh|fish|sql|prisma|graphql|gql|toml|vue|svelte|astro|css|scss|sass|less|html|htm|xml|tf|tfvars|lua|r|jl|dart|ex|exs|erl|clj|cljs)$/i.test(filePath);
}

export function isArtifactPath(filePath) {
  return /[\/\\]\.smt[\/\\]features[\/\\][^\/\\]+[\/\\](?:task|artifacts)[\/\\]/.test(String(filePath || ''));
}

export function isWriteTool(toolName) {
  return ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName);
}

export function looksLikeGitCommit(command) {
  return /(^|[\s;&|])(?:[\w/.-]*\/)?git(?:\s+-C\s+\S+)?\s+commit\b/i.test(String(command || ''));
}

export function tddExemptionReason(state) {
  if (state?.exempt?.tdd === true) return 'state_exempt_tdd';
  if (state?.target_type === 'design') return 'design_change';
  if (state?.target_type === 'text') return 'text_change';
  if (state?.target_type === 'style' || state?.target_type === 'css') return 'style_change';
  const surfaces = Array.isArray(state?.surface) ? state.surface : [];
  if (surfaces.some((s) => /(?:^|[\/\\])[^\/\\]+\.(?:css|scss|sass|less)$/i.test(String(s || '')))) {
    return 'style_surface_css';
  }
  return null;
}

export function hasTddEntryEvidence(state) {
  if (tddExemptionReason(state)) return true;
  const hasEvent = Array.isArray(state?.events) && state.events.some((e) =>
    e?.type === 'test_red' || e?.type === 'tdd_adopted' || e?.type === 'tdd_exempt'
  );
  const hasLegacyRedCycle = Array.isArray(state?.test_cycles) && state.test_cycles.some((c) =>
    c?.run_result === 'fail' && ['added_case', 'modified_case'].includes(c?.action)
  );
  return hasEvent || hasLegacyRedCycle;
}

export function canEnterPhase(state, targetPhase) {
  if (!PHASES.includes(targetPhase)) return block(`unknown phase ${targetPhase}`);
  const taskType = state?.task_type;

  if (targetPhase === 'EXECUTE') {
    if (taskType === 'read' || taskType === 'design' || taskType === 'verify') {
      return block(`EXECUTE forbidden for task_type=${taskType}`);
    }
    if (taskType === 'write' && !hasTddEntryEvidence(state)) {
      return block('EXECUTE requires executable specification RED evidence: test_red, tdd_adopted, tdd_exempt, or legacy RED test_cycles');
    }
  }

  return allow(`phase ${targetPhase} allowed`);
}

export function transitionPhase(state, targetPhase) {
  const expected = nextRequiredPhase(state);
  if (expected && targetPhase !== expected) {
    throw new Error(`phase skip blocked: expected ${expected}, got ${targetPhase}`);
  }
  const verdict = canEnterPhase(state, targetPhase);
  if (verdict.decision === 'block') throw new Error(verdict.reason);
  state.phase = targetPhase;
  state.step = targetPhase;
  if (state.task_type) state.allowed_actions = allowedActionsFor({ task_type: state.task_type, step: targetPhase });
  state.updated_at = new Date().toISOString();
  return state;
}

export function evaluatePhaseToolUse(state, { toolName, skill = '', filePath = '', command = '' } = {}) {
  if (!state) return allow('no state');
  const phase = currentPhase(state);

  if (toolName === 'Skill') {
    const targetPhase = phaseForSkill(skill);
    if (!targetPhase) return allow('non-workflow skill');
    if (targetPhase === phase) return allow(`skill allowed in phase ${phase}`);
    const expected = nextRequiredPhase(state);
    if (targetPhase === expected) return canEnterPhase(state, targetPhase);
    return block(`Skill ${skill} requires phase ${targetPhase}, current phase ${phase}`);
  }

  if (toolName === 'Bash' && looksLikeGitCommit(command)) {
    if (['write', 'infra', 'freeform'].includes(state.task_type) && phase !== 'DONE') {
      return block(`git commit blocked until HUMAN_CHECK/DONE passes (task_type=${state.task_type}, phase=${phase})`);
    }
    return allow('commit allowed');
  }

  if (!isWriteTool(toolName)) return allow('non-write tool');

  if (isArtifactPath(filePath)) {
    const artifactPhase = phaseForArtifactPath(filePath);
    if (artifactPhase && artifactPhase !== phase) {
      return block(`artifact requires phase ${artifactPhase}, current phase ${phase}`);
    }
    if (state.allowed_actions?.includes('write_artifact')) return allow('artifact write allowed');
    return block(`artifact write not allowed at phase=${phase}`);
  }

  if (!isSourcePath(filePath)) return allow('ungated write surface');

  if (state.task_type === 'read') return block('source write blocked for task_type=read');
  if (state.task_type === 'design') return block('source write blocked for task_type=design');
  if (state.task_type === 'verify') return block('source write blocked for task_type=verify');

  if (state.task_type === 'infra') {
    if (phase === 'EXECUTE' && state.allowed_actions?.includes('write_source')) return allow('infra EXECUTE write allowed');
    return block(`infra source write blocked at phase=${phase}`);
  }

  if (state.task_type === 'write') {
    if (isTestPath(filePath)) {
      if (phase === 'TEST_DESIGN' && state.allowed_actions?.includes('write_test')) return allow('test write allowed during TEST_DESIGN');
      return block(`test write blocked at phase=${phase}`);
    }
    if (phase !== 'EXECUTE') return block(`source edit requires EXECUTE phase, current phase=${phase}`);
    const verdict = canEnterPhase(state, 'EXECUTE');
    if (verdict.decision === 'block') return verdict;
    return allow('write EXECUTE with executable specification RED evidence');
  }

  if (state.task_type === 'freeform') {
    if (phase === 'EXECUTE') return allow('freeform execute write allowed');
    return block(`freeform write blocked at phase=${phase}`);
  }

  return allow('ungated write surface');
}
