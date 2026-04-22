#!/usr/bin/env node
/**
 * workflow-loader.mjs — Load the v3.1 unified workflow config:
 *   modes/workflow.yaml  — skills + pipelines + modes + target-type routing
 *                          + verification_rounds in a single file.
 *
 * Replaces the legacy `modes/<mode>.json` loader AND the v3.0 split-file variant.
 *
 * Public API:
 *   - loadWorkflowConfig({ root? })      → full composite
 *   - getMode(name, cfg?)                → expanded mode (back-compat shape)
 *   - nextSkill(mode, completed, cfg?, skipFromArtifacts?)
 *   - scanFeatureArtifacts(featureDir)
 *   - resolveSkipFromArtifacts(mode, artifacts, cfg?)
 *   - resolveCommandAlias(slash, cfg?)
 *   - selectPipeline(mode, { target_type }, cfg?)
 *     → v3.2 target-type dispatch for /fix and /implement
 *   - getVerificationRounds(skill, modeName?, cfg?) → round count with mode overrides
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = dirname(dirname(dirname(__filename)));

let CACHED_CONFIG = null;

export function loadWorkflowConfig({ root = PLUGIN_ROOT, fresh = false } = {}) {
  if (CACHED_CONFIG && !fresh && CACHED_CONFIG._root === root) return CACHED_CONFIG;

  const workflowPath = join(root, 'modes', 'workflow.yaml');
  if (!existsSync(workflowPath)) throw new Error(`workflow-loader: missing ${workflowPath}`);
  const doc = yaml.load(readFileSync(workflowPath, 'utf-8')) ?? {};

  const skills = doc.skills ?? {};
  const pipelines = doc.pipelines ?? {};
  const modes = doc.modes ?? {};
  const commandAliases = doc.command_aliases ?? {};
  const targetTypeRouting = doc.target_type_routing ?? {};
  const verificationRounds = doc.verification_rounds ?? { mid_pipeline: 2, terminal: 3 };
  const schemaVersion = doc.schema_version ?? 'unknown';

  // Structural validation.
  for (const [modeName, m] of Object.entries(modes)) {
    if (!m.entry_skill) throw new Error(`mode ${modeName}: missing entry_skill`);
    if (!m.pipeline) throw new Error(`mode ${modeName}: missing pipeline`);
    if (!pipelines[m.pipeline]) throw new Error(`mode ${modeName}: pipeline ${m.pipeline} not found`);
    if (!skills[m.entry_skill]) throw new Error(`mode ${modeName}: entry_skill ${m.entry_skill} not in skills`);
  }

  const cfg = {
    schema_version: schemaVersion,
    skills,
    pipelines,
    modes,
    command_aliases: commandAliases,
    target_type_routing: targetTypeRouting,
    verification_rounds: verificationRounds,
    _root: root,
  };
  CACHED_CONFIG = cfg;
  return cfg;
}

// ---------------------------------------------------------------------------
// Mode expansion — back-compat JSON shape for downstream consumers.
// ---------------------------------------------------------------------------

export function getMode(name, cfg = loadWorkflowConfig()) {
  const m = cfg.modes[name];
  if (!m) return null;

  const pipeline = cfg.pipelines[m.pipeline];
  if (!pipeline) throw new Error(`getMode(${name}): pipeline ${m.pipeline} missing`);

  const allowedSkills = [...pipeline];

  const teamHints = m.team_hints ?? {};
  const overrides = {};
  for (const skill of allowedSkills) {
    const skillDef = cfg.skills[skill];
    if (!skillDef) continue;
    if (skillDef.team) {
      overrides[skill] = { ...skillDef.team };
    } else if (skillDef.teams) {
      const hint = teamHints[skill];
      const key = hint && skillDef.teams[hint] ? hint : Object.keys(skillDef.teams)[0];
      overrides[skill] = { ...skillDef.teams[key] };
    }
  }

  return {
    mode: name,
    description: m.description ?? '',
    entry_skill: m.entry_skill,
    entry_params: m.entry_params ?? {},
    pipeline: m.pipeline,
    allowed_skills: allowedSkills,
    default_team_overrides: overrides,
    default_exempt: m.default_exempt ?? { tdd: false, e2e: false },
    magic_keywords: m.magic_keywords ?? {},
    transitions: m.transitions ?? { upgrade_to: [], downgrade_to: [] },
    terminal_actions: m.terminal_actions ?? [],
    read_only: Boolean(m.read_only),
    target_type_dispatch: Boolean(m.target_type_dispatch),
  };
}

// ---------------------------------------------------------------------------
// v3.1 — Target-type dispatch for /fix mode.
// ---------------------------------------------------------------------------

/**
 * selectPipeline — resolve a pipeline name for a mode at runtime.
 *
 * Walks the target_type_routing table for modes with `target_type_dispatch: true`
 * (/fix and /implement as of v3.2). The table is a simple string map; mode-specific
 * gates apply on top:
 *   - /fix + extend_existing → upgrade_required (route user to /implement)
 *   - /implement + no target_type → declared pipeline (full)
 *   - /implement + extend_existing → extend_light
 *
 * @param {string} modeName
 * @param {{target_type?: string}} scope — file_count/surface_count ignored in v3.2
 *                                          (scope-based upgrades removed with medium).
 * @param {object} cfg
 * @returns {string|'upgrade_required'} pipeline name or escalation sentinel
 */
export function selectPipeline(modeName, scope = {}, cfg = loadWorkflowConfig()) {
  const m = cfg.modes[modeName];
  if (!m) return null;

  // Non-dispatching modes always use their declared pipeline.
  if (!m.target_type_dispatch) return m.pipeline;

  const targetType = scope.target_type;
  // No target_type yet (pre-investigate) → use mode's default pipeline.
  if (!targetType) return m.pipeline;

  // Mode-specific gate: /fix forwards extend_existing to /implement.
  if (modeName === 'fix' && targetType === 'extend_existing') return 'upgrade_required';

  // Mode-specific gate: /implement only honors extend_existing → extend_light.
  // The other target_types (new_feature/refactor/migration/bug_fix) are what
  // /implement is built for — stay on the declared pipeline (full).
  if (modeName === 'implement') {
    if (targetType === 'extend_existing') return 'extend_light';
    return m.pipeline;
  }

  const route = cfg.target_type_routing[targetType];
  if (!route) return m.pipeline;

  // v3.2: routing table is a string map. Scope-dependent upgrades removed when
  // `medium` was retired.
  if (typeof route === 'string') return route;

  return m.pipeline;
}

// ---------------------------------------------------------------------------
// v3.1 — Verification rounds per skill.
// ---------------------------------------------------------------------------

/**
 * getVerificationRounds — resolve the round count for a review skill.
 *
 * Resolution order (highest precedence first):
 *   1. mode_overrides[mode][skill] — per-skill override for the current mode
 *   2. mode_overrides[mode].default — mode-wide default override
 *   3. skills[skill].rounds bucket → verification_rounds[bucket] (global default)
 *   4. verification_rounds.mid_pipeline (final fallback)
 *
 * The `modeName` parameter is optional; when omitted, mode overrides are skipped
 * and the global bucket is used (legacy behavior).
 *
 * @param {string} skill
 * @param {string|null} [modeName] — current workflow mode, e.g. 'fix', 'implement'
 * @param {object} [cfg] — loaded workflow config
 * @returns {number} round count (≥1)
 */
export function getVerificationRounds(skill, modeName = null, cfg = loadWorkflowConfig()) {
  const vr = cfg.verification_rounds ?? {};
  const modeOverrides = vr.mode_overrides?.[modeName] ?? null;

  if (modeOverrides) {
    if (Object.prototype.hasOwnProperty.call(modeOverrides, skill)) return modeOverrides[skill];
    if (Object.prototype.hasOwnProperty.call(modeOverrides, 'default')) return modeOverrides.default;
  }

  const skillDef = cfg.skills[skill];
  if (!skillDef) return vr.mid_pipeline ?? 2;
  const bucket = skillDef.rounds ?? 'mid_pipeline';
  return vr[bucket] ?? vr.mid_pipeline ?? 2;
}

// ---------------------------------------------------------------------------
// File-driven routing.
// ---------------------------------------------------------------------------

const ARTIFACT_TO_SKILL = Object.freeze({
  'brainstorm.md': 'workflow-brainstorm',
  'brainstorm-review.md': 'workflow-brainstorm-review',
  'investigation.md': 'workflow-investigate',
  'investigation-review.md': 'workflow-investigate-review',
  'tasks.md': 'workflow-tasker',
  'tasks-review.md': 'workflow-tasker-review',
});

export function scanFeatureArtifacts(featureDir) {
  const taskDir = join(featureDir, 'task');
  const result = {};
  for (const filename of Object.keys(ARTIFACT_TO_SKILL)) {
    result[filename] = existsSync(join(taskDir, filename));
  }
  return result;
}

export function resolveSkipFromArtifacts(modeName, artifacts, cfg = loadWorkflowConfig()) {
  const mode = getMode(modeName, cfg);
  if (!mode) return [];
  const skip = [];
  for (const skill of mode.allowed_skills) {
    const producedFile = Object.entries(ARTIFACT_TO_SKILL).find(([, s]) => s === skill)?.[0];
    if (producedFile && artifacts[producedFile]) skip.push(skill);
  }
  return skip;
}

export function nextSkill(modeName, completed = [], cfg = loadWorkflowConfig(), skipFromArtifacts = []) {
  const mode = getMode(modeName, cfg);
  if (!mode) return null;

  const consumed = new Set([...completed, ...skipFromArtifacts]);
  for (const skill of mode.allowed_skills) {
    if (!consumed.has(skill)) return skill;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command alias.
// ---------------------------------------------------------------------------

export function resolveCommandAlias(slash, cfg = loadWorkflowConfig()) {
  if (!slash) return null;
  const key = slash.startsWith('/') ? slash : `/${slash}`;
  return cfg.command_aliases[key] ?? null;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadWorkflowConfig();
  if (process.argv[2]) {
    const m = getMode(process.argv[2], cfg);
    console.log(JSON.stringify(m, null, 2));
  } else {
    console.log(JSON.stringify({
      schema_version: cfg.schema_version,
      modes: Object.keys(cfg.modes),
      pipelines: Object.keys(cfg.pipelines),
      skills: Object.keys(cfg.skills),
      target_type_routing: Object.keys(cfg.target_type_routing),
      verification_rounds: cfg.verification_rounds,
      command_aliases: cfg.command_aliases,
    }, null, 2));
  }
}
