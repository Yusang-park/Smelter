#!/usr/bin/env node

import { copyFileSync, existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { SKILL_ARTIFACT_BASENAME } from '../state-validator.mjs';
import { allowedActionsFor, resolveContract } from './workflow-v4-contract.mjs';
import { getMode, loadWorkflowConfig, selectPipeline } from './workflow-loader.mjs';
import { phaseForSkill } from './phase-gate.mjs';

function resolveEvidencePath(evidencePath, statePath) {
  if (!evidencePath || typeof evidencePath !== 'string') return null;
  return isAbsolute(evidencePath) ? evidencePath : resolve(dirname(statePath), evidencePath);
}

function validEvidenceForStage(state, statePath, stage) {
  const completed = Array.isArray(state?.completed_stages) ? state.completed_stages : [];
  if (!completed.includes(stage)) return null;
  const expectedBasename = SKILL_ARTIFACT_BASENAME[stage];
  if (!expectedBasename) return null;
  const events = Array.isArray(state?.events) ? state.events : [];
  for (const event of events) {
    if (event?.skill !== stage || event?.result !== 'pass') continue;
    const abs = resolveEvidencePath(event.evidence?.path, statePath);
    if (!abs || basename(abs) !== expectedBasename) continue;
    try {
      if (!existsSync(abs)) continue;
      const lst = lstatSync(abs);
      if (lst.isSymbolicLink() || !lst.isFile()) continue;
      if (statSync(abs).size <= 0) continue;
      return abs;
    } catch {
      continue;
    }
  }
  return null;
}

export function findTransitionAdoptionPolicy(fromMode, toMode, cfg = loadWorkflowConfig()) {
  const policies = Array.isArray(cfg?.transition_adoptions) ? cfg.transition_adoptions : [];
  return policies.find(policy =>
    Array.isArray(policy?.from_modes) && policy.from_modes.includes(fromMode) &&
    Array.isArray(policy?.to_modes) && policy.to_modes.includes(toMode)
  ) ?? null;
}

export function copyPolicyMetadata(sourceState, targetState, policy) {
  if (!sourceState || !targetState || !Array.isArray(policy?.metadata)) return;
  for (const key of policy.metadata) {
    if (key === 'target_type' && !targetState.target_type && typeof sourceState.target_type === 'string') {
      targetState.target_type = sourceState.target_type;
    }
    if (key === 'surface' && (!Array.isArray(targetState.surface) || targetState.surface.length === 0) && Array.isArray(sourceState.surface)) {
      targetState.surface = [...sourceState.surface];
    }
    if (key === 'file_count' && targetState.file_count === undefined && Number.isFinite(sourceState.file_count)) {
      targetState.file_count = sourceState.file_count;
    }
  }
}

export function retargetStateForMode(state, mode, cfg = loadWorkflowConfig()) {
  const contract = resolveContract(mode);
  const modeCfg = getMode(mode, cfg);
  state.mode = mode;
  state.user_mode = contract.user_mode;
  state.task_type = contract.task_type;
  state.step_flow = contract.steps;
  state.step = 'INTENT';
  state.allowed_actions = allowedActionsFor({ task_type: contract.task_type, step: 'INTENT' });
  state.exempt = { ...(modeCfg?.default_exempt ?? { tdd: false, e2e: false }) };

  let allowedSkills = modeCfg?.allowed_skills ? [...modeCfg.allowed_skills] : [];
  if (modeCfg?.target_type_dispatch && state.target_type) {
    const pipelineName = selectPipeline(mode, { target_type: state.target_type }, cfg);
    if (pipelineName && pipelineName !== 'upgrade_required' && cfg.pipelines[pipelineName]) {
      allowedSkills = [...cfg.pipelines[pipelineName]];
    }
  }
  state.allowed_skills = allowedSkills;
  state.current_stage = modeCfg?.entry_skill && allowedSkills.includes(modeCfg.entry_skill)
    ? modeCfg.entry_skill
    : null;
  return modeCfg;
}

export function advanceToNextUncompletedSkill(state) {
  const completed = new Set(Array.isArray(state?.completed_stages) ? state.completed_stages : []);
  const next = (Array.isArray(state?.allowed_skills) ? state.allowed_skills : []).find(skill => !completed.has(skill));
  if (!next) return null;
  state.current_stage = next;
  const step = phaseForSkill(next);
  if (step && Array.isArray(state.step_flow) && state.step_flow.includes(step)) {
    state.step = step;
    state.allowed_actions = allowedActionsFor({ task_type: state.task_type, step });
  }
  return next;
}

export function adoptCompletedStages({ sourceState, sourceStatePath, targetState, targetStatePath, policy }) {
  if (!sourceState || !sourceStatePath || !targetState || !targetStatePath) return [];
  const stages = Array.isArray(policy?.stages) ? policy.stages : [];
  if (stages.length === 0) return [];
  const adopted = [];
  const targetDir = dirname(targetStatePath);
  mkdirSync(targetDir, { recursive: true });
  if (!Array.isArray(targetState.events)) targetState.events = [];
  if (!Array.isArray(targetState.completed_stages)) targetState.completed_stages = [];

  for (const stage of stages) {
    const sourceArtifact = validEvidenceForStage(sourceState, sourceStatePath, stage);
    if (!sourceArtifact) break;
    const artifactName = SKILL_ARTIFACT_BASENAME[stage];
    const targetArtifact = join(targetDir, artifactName);
    if (policy.copy_artifacts !== false && resolve(sourceArtifact) !== resolve(targetArtifact)) {
      copyFileSync(sourceArtifact, targetArtifact);
    }
    if (!targetState.events.some(event => event?.skill === stage && event?.result === 'pass')) {
      targetState.events.push({
        t: new Date().toISOString(),
        skill: stage,
        result: 'pass',
        declarer: 'hook',
        evidence: { type: 'file_present', path: targetArtifact },
      });
    }
    if (!targetState.completed_stages.includes(stage)) targetState.completed_stages.push(stage);
    adopted.push(stage);
  }
  return adopted;
}

export function applyTransitionAdoption({ sourceState, sourceStatePath, targetState, targetStatePath, toMode, cfg = loadWorkflowConfig() }) {
  const policy = findTransitionAdoptionPolicy(sourceState?.mode, toMode, cfg);
  if (!policy) return [];
  copyPolicyMetadata(sourceState, targetState, policy);
  const adopted = adoptCompletedStages({ sourceState, sourceStatePath, targetState, targetStatePath, policy });
  if (adopted.length > 0 && policy.advance_to_next_uncompleted !== false) {
    advanceToNextUncompletedSkill(targetState);
  }
  return adopted;
}
