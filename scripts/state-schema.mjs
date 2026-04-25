#!/usr/bin/env node
/**
 * state-schema.mjs — Workflow v2 state.json schema + validator + initializer.
 *
 * Single source of truth for the per-task machine state.
 * Path: .smt/features/<slug>/task/<task>.state.json
 *
 * See document/workflow-v2.md section 2-2.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateEvidenceIntegrity } from './state-validator.mjs';
import { allowedActionsFor, resolveContract, STEPS, TASK_TYPES, USER_MODES } from './lib/workflow-v4-contract.mjs';

export const SCHEMA_VERSION = '2.4.1';

export const WORKFLOW_SKILLS = Object.freeze([
  'workflow-brainstorm',
  'workflow-brainstorm-review',
  'workflow-investigate',
  'workflow-investigate-review',
  'workflow-implementation-plan',
  'workflow-implementation-plan-review',
  'workflow-tasker',
  'workflow-tasker-review',
  'workflow-write-test',
  'workflow-coding',
  'workflow-agent-review',
  'workflow-e2e',
  'workflow-e2e-review',
  'workflow-team-code-review',
  'workflow-verify',
  'workflow-human-check',
]);

// v0.4 canonical modes — legacy `plan`, `simple_fix`, `think`, and `investigate` commands fully removed.
// `dobby` (v3.4) is a no-pipeline escape hatch: only workflow-human-check runs
// as the terminal gate; code edits are permitted like fix/implement.
export const MODES = Object.freeze([
  'brainstorm', 'fix', 'implement', 'explore', 'verify', 'dobby',
]);

export const CAUSE_ENUM = Object.freeze([
  'typecheck', 'lint', 'test_run', 'build', 'assertion',
  'file_absent', 'tdd_cycle', 'review_reject',
  'scope_mismatch', 'side_effect', 'security', 'insufficient_scenario',
  'stall_cascade', 'conflict_merge_failed',
  'verification_failed', // Multi-Pass Verification round fail (workflow-v2.md §9-3)
  'artifact_missing',    // E2E pass claim with no real-interface artifact (§8)
  'mocked_interface',    // E2E run mocked the interface under test (§8)
  'effect_unverified',   // E2E run asserted only ack, not the target effect (§8)
  'visual_mismatch',     // v3: e2e-review vision inspection found screenshot/video does not match expected state
  'e2e_infra_missing',   // v3: e2e harness absent (playwright, test-runner, etc.) — needs install before scenarios run
]);

export const VERIFICATION_FOCUS_ENUM = Object.freeze([
  'omission', 'contradiction',
]);

export const EVIDENCE_TYPE_ENUM = Object.freeze([
  'exit_code', 'file_absent', 'parse', 'user_input', 'diff', 'file_present',
]);

export const EFFECT_EVIDENCE_TYPE_ENUM = Object.freeze([
  'dom_diff', 'dom_state_query', 'http_get_after', 'fs_diff', 'followup_cmd', 'db_select', 'stdout_parse', 'local_ui_toggle',
]);

export const TARGET_TYPE_ENUM = Object.freeze([
  'new_feature', 'refactor', 'extend_existing', 'migration', 'bug_fix',
  'text', 'design',   // v3.3 — surface-based types; route to `fix_simple` pipeline (텍스트 수정 / 디자인 수정)
]);

export const PATTERNS = Object.freeze(['A', 'B', 'C', 'D', 'E']);

export function createInitialState({ taskId, mode, chainedModes = [] }) {
  if (!MODES.includes(mode)) throw new Error(`invalid mode: ${mode}`);
  if (!Array.isArray(chainedModes)) throw new Error('chainedModes must be array');
  for (const m of chainedModes) {
    if (!MODES.includes(m)) throw new Error(`invalid chained mode: ${m}`);
  }
  const now = new Date().toISOString();
  const contract = resolveContract(mode);
  return {
    schema_version: SCHEMA_VERSION,
    task_id: taskId,
    mode,
    user_mode: contract.user_mode,
    task_type: contract.task_type,
    step: 'INTENT',
    step_flow: contract.steps,
    allowed_actions: allowedActionsFor({ task_type: contract.task_type, step: 'INTENT' }),
    // Ordered auto-transition path. Empty when input was not a chained intent.
    // First element is the entry mode; subsequent elements are auto-selected
    // at mode_transition gates by the Stop hook. Additive-only field;
    // schema stays 2.3.0.
    chained_modes: chainedModes,
    allowed_skills: [],
    current_stage: null,
    completed_stages: [],
    created_at: now,
    updated_at: now,
    target_type: null,
    surface: [],
    exempt: { tdd: false, e2e: false },
    skip_brainstorm: false,
    team_runtime: {},
    events: [],
    scenarios: [],
    test_cycles: [],
    active_feedback: [],
    sub_tasks: [],
  };
}

export function validate(state) {
  const errors = [];
  const push = (p, msg) => errors.push(`${p}: ${msg}`);

  if (!state || typeof state !== 'object') return ['root: must be object'];
  if (state.schema_version !== SCHEMA_VERSION) push('schema_version', `expected ${SCHEMA_VERSION}, got ${state.schema_version}`);
  if (typeof state.task_id !== 'string' || !state.task_id) push('task_id', 'required string');
  if (!MODES.includes(state.mode)) push('mode', `invalid: ${state.mode}`);
  if (state.user_mode !== undefined && !USER_MODES.includes(state.user_mode)) push('user_mode', `invalid: ${state.user_mode}`);
  if (state.task_type !== undefined && !TASK_TYPES.includes(state.task_type)) push('task_type', `invalid: ${state.task_type}`);
  if (state.step !== undefined && !STEPS.includes(state.step)) push('step', `invalid: ${state.step}`);
  if (state.step_flow !== undefined && !Array.isArray(state.step_flow)) push('step_flow', 'must be array when present');
  if (state.allowed_actions !== undefined && !Array.isArray(state.allowed_actions)) push('allowed_actions', 'must be array when present');

  // chained_modes — additive optional field. When present must be a MODES[] array.
  // Absence is allowed for back-compat with states created before this field existed.
  if (state.chained_modes !== undefined) {
    if (!Array.isArray(state.chained_modes)) {
      push('chained_modes', 'must be array when present');
    } else {
      for (const m of state.chained_modes) {
        if (!MODES.includes(m)) push('chained_modes', `invalid mode: ${m}`);
      }
    }
  }

  if (!Array.isArray(state.allowed_skills)) push('allowed_skills', 'must be array');
  else for (const s of state.allowed_skills) {
    if (!WORKFLOW_SKILLS.includes(s)) push('allowed_skills', `unknown skill: ${s}`);
  }

  if (state.current_stage !== null && !WORKFLOW_SKILLS.includes(state.current_stage)) {
    push('current_stage', `invalid: ${state.current_stage}`);
  }

  if (!Array.isArray(state.completed_stages)) push('completed_stages', 'must be array');
  if (typeof state.created_at !== 'string') push('created_at', 'required ISO8601 string');
  if (typeof state.updated_at !== 'string') push('updated_at', 'required ISO8601 string');

  if (state.target_type !== null && !TARGET_TYPE_ENUM.includes(state.target_type)) {
    push('target_type', `invalid: ${state.target_type}`);
  }

  if (!Array.isArray(state.surface)) push('surface', 'must be array');
  if (!state.exempt || typeof state.exempt !== 'object') push('exempt', 'must be object');

  // skip_brainstorm — additive-optional (Smelter v3.2+). Absence allowed for back-compat.
  if (state.skip_brainstorm !== undefined && typeof state.skip_brainstorm !== 'boolean') {
    push('skip_brainstorm', 'must be boolean when present');
  }

  if (!state.team_runtime || typeof state.team_runtime !== 'object') push('team_runtime', 'must be object');
  else for (const [skill, cfg] of Object.entries(state.team_runtime)) {
    if (!WORKFLOW_SKILLS.includes(skill)) push(`team_runtime.${skill}`, 'unknown skill');
    if (!cfg || typeof cfg !== 'object') { push(`team_runtime.${skill}`, 'must be object'); continue; }
    if (cfg.pattern && !PATTERNS.includes(cfg.pattern)) push(`team_runtime.${skill}.pattern`, `invalid: ${cfg.pattern}`);
    if (!Array.isArray(cfg.assigned_agents)) push(`team_runtime.${skill}.assigned_agents`, 'must be array');

    // Multi-Pass Verification (§9-3) — only applies to review skills
    if (cfg.rounds !== undefined) {
      if (!Array.isArray(cfg.rounds)) {
        push(`team_runtime.${skill}.rounds`, 'must be array');
      } else {
        for (let i = 0; i < cfg.rounds.length; i++) {
          const r = cfg.rounds[i];
          if (!r || typeof r !== 'object') { push(`team_runtime.${skill}.rounds[${i}]`, 'must be object'); continue; }
          if (typeof r.n !== 'number') push(`team_runtime.${skill}.rounds[${i}].n`, 'must be number');
          if (!VERIFICATION_FOCUS_ENUM.includes(r.focus)) push(`team_runtime.${skill}.rounds[${i}].focus`, `invalid: ${r.focus}`);
          // null = pending/in-progress, pass|fail = terminal
          if (r.result !== undefined && r.result !== null && !['pass', 'fail'].includes(r.result)) {
            push(`team_runtime.${skill}.rounds[${i}].result`, 'must be null|pass|fail');
          }
        }
      }
    }
    if (cfg.min_verification_rounds !== undefined && (typeof cfg.min_verification_rounds !== 'number' || cfg.min_verification_rounds < 1)) {
      push(`team_runtime.${skill}.min_verification_rounds`, 'must be positive integer');
    }
    if (cfg.completed_rounds !== undefined && typeof cfg.completed_rounds !== 'number') {
      push(`team_runtime.${skill}.completed_rounds`, 'must be number');
    }
  }

  if (!Array.isArray(state.events)) push('events', 'must be array');
  else for (let i = 0; i < state.events.length; i++) {
    const e = state.events[i];
    if (!e || typeof e !== 'object') { push(`events[${i}]`, 'must be object'); continue; }
    if (typeof e.t !== 'string') push(`events[${i}].t`, 'required');
    if (!WORKFLOW_SKILLS.includes(e.skill) && !['critic-watchdog', 'stall-cascade'].includes(e.skill)) {
      push(`events[${i}].skill`, `unknown: ${e.skill}`);
    }
    if (!['pass', 'fail'].includes(e.result)) push(`events[${i}].result`, 'must be pass|fail');
    if (!['hook', 'user'].includes(e.declarer)) push(`events[${i}].declarer`, 'must be hook|user (skill declarer forbidden, principle 3)');
    if (e.result === 'fail' && !CAUSE_ENUM.includes(e.cause)) push(`events[${i}].cause`, `invalid: ${e.cause}`);
    if (e.evidence && !EVIDENCE_TYPE_ENUM.includes(e.evidence.type)) push(`events[${i}].evidence.type`, `invalid: ${e.evidence.type}`);
  }

  if (state.scenarios !== undefined) {
    if (!Array.isArray(state.scenarios)) push('scenarios', 'must be array');
    else for (let i = 0; i < state.scenarios.length; i++) {
      const s = state.scenarios[i];
      if (!s || typeof s !== 'object') { push(`scenarios[${i}]`, 'must be object'); continue; }
      if (typeof s.name !== 'string' || !s.name) push(`scenarios[${i}].name`, 'required string');
      if (typeof s.surface !== 'string' || !s.surface) push(`scenarios[${i}].surface`, 'required string');
      if (!s.ack_evidence || typeof s.ack_evidence !== 'object') {
        push(`scenarios[${i}].ack_evidence`, 'required object');
      } else {
        if (typeof s.ack_evidence.reference !== 'string' || !s.ack_evidence.reference) {
          push(`scenarios[${i}].ack_evidence.reference`, 'required string');
        }
      }
      if (!s.effect_evidence || typeof s.effect_evidence !== 'object') {
        push(`scenarios[${i}].effect_evidence`, 'required object');
      } else {
        if (!EFFECT_EVIDENCE_TYPE_ENUM.includes(s.effect_evidence.type)) {
          push(`scenarios[${i}].effect_evidence.type`, `invalid: ${s.effect_evidence.type}`);
        }
        if (typeof s.effect_evidence.reference !== 'string' || !s.effect_evidence.reference) {
          push(`scenarios[${i}].effect_evidence.reference`, 'required string');
        }
      }
    }
  }

  if (state.scenarios === undefined && Array.isArray(state.events)) {
    const hasE2ePass = state.events.some(e =>
      e && typeof e === 'object' &&
      ['workflow-e2e', 'workflow-verify'].includes(e.skill) &&
      e.result === 'pass'
    );
    if (hasE2ePass) push('scenarios', 'required for workflow-e2e/workflow-verify pass events');
  }

  if (!Array.isArray(state.test_cycles)) push('test_cycles', 'must be array');
  if (!Array.isArray(state.active_feedback)) push('active_feedback', 'must be array');
  else for (let i = 0; i < state.active_feedback.length; i++) {
    const f = state.active_feedback[i];
    if (!f || typeof f !== 'object') { push(`active_feedback[${i}]`, 'must be object'); continue; }
    if (typeof f.id !== 'string') push(`active_feedback[${i}].id`, 'required');
    if (!WORKFLOW_SKILLS.includes(f.target_skill)) push(`active_feedback[${i}].target_skill`, `invalid: ${f.target_skill}`);
    if (typeof f.resolved !== 'boolean') push(`active_feedback[${i}].resolved`, 'must be boolean');
  }

  if (!Array.isArray(state.sub_tasks)) push('sub_tasks', 'must be array');

  return errors;
}

export function readState(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

export function writeState(path, state) {
  state.updated_at = new Date().toISOString();
  const errs = validate(state);
  if (errs.length) throw new Error(`state validation failed:\n  ${errs.join('\n  ')}`);
  const evidenceErrs = validateEvidenceIntegrity(state, path);
  if (evidenceErrs.length) throw new Error(`state validation failed:\n  ${evidenceErrs.join('\n  ')}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export function appendEvent(state, event) {
  if (!event.t) event.t = new Date().toISOString();
  state.events.push(event);
  return state;
}

export function markComplete(state, skill) {
  if (!WORKFLOW_SKILLS.includes(skill)) throw new Error(`unknown skill: ${skill}`);
  if (!state.completed_stages.includes(skill)) state.completed_stages.push(skill);
  return state;
}

// CLI entry: validate a state.json file.
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) { console.error('usage: state-schema.mjs <path>'); process.exit(2); }
  const state = readState(target);
  if (!state) { console.error(`cannot read: ${target}`); process.exit(1); }
  const errs = validate(state);
  if (errs.length) { console.error('INVALID:\n  ' + errs.join('\n  ')); process.exit(1); }
  console.log(`OK: ${target} (schema ${SCHEMA_VERSION})`);
}
