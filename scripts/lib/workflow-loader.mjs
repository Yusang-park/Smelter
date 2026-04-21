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
 *   - selectPipeline(mode, { target_type, file_count, surface_count }, cfg?)
 *     → v3.1 target-type dispatch for /fix mode
 *   - getVerificationRounds(skill, cfg?) → 2 or 3 per skill's `rounds` bucket
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
 * For modes with `target_type_dispatch: true` (currently only /fix), walk the
 * target_type_routing table. Simple types map to pipeline strings; complex
 * types (like bug_fix) may have scope-dependent upgrades.
 *
 * @param {string} modeName
 * @param {{target_type?: string, file_count?: number, surface_count?: number}} scope
 * @param {object} cfg
 * @returns {string|'upgrade_required'} pipeline name or escalation sentinel
 */
export function selectPipeline(modeName, scope = {}, cfg = loadWorkflowConfig()) {
  const m = cfg.modes[modeName];
  if (!m) return null;

  // Non-dispatching modes always use their declared pipeline.
  if (!m.target_type_dispatch) return m.pipeline;

  const targetType = scope.target_type;
  // No target_type yet (pre-investigate) → use mode's default.
  if (!targetType) return m.pipeline;

  const route = cfg.target_type_routing[targetType];
  if (!route) return m.pipeline;

  // Simple string mapping: typo → minimal, extend_existing → medium, etc.
  if (typeof route === 'string') return route;

  // Scope-dependent routing (e.g., bug_fix): default + upgrade rules.
  if (typeof route === 'object' && route.default) {
    const upgrade = route.upgrade_to_medium_when ?? {};
    const fileCountGt = upgrade.file_count_gt ?? Infinity;
    const surfaceCountGt = upgrade.surface_count_gt ?? Infinity;

    if ((scope.file_count ?? 0) > fileCountGt) return 'medium';
    if ((scope.surface_count ?? 0) > surfaceCountGt) return 'medium';
    return route.default;
  }

  return m.pipeline;
}

// ---------------------------------------------------------------------------
// v3.1 — Verification rounds per skill.
// ---------------------------------------------------------------------------

/**
 * getVerificationRounds — resolve the round count for a review skill.
 *
 * Skill's `rounds` field references a bucket in verification_rounds
 * (`mid_pipeline` → 2, `terminal` → 3). Default mid_pipeline when unset.
 */
export function getVerificationRounds(skill, cfg = loadWorkflowConfig()) {
  const skillDef = cfg.skills[skill];
  if (!skillDef) return cfg.verification_rounds.mid_pipeline;
  const bucket = skillDef.rounds ?? 'mid_pipeline';
  return cfg.verification_rounds[bucket] ?? cfg.verification_rounds.mid_pipeline;
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
