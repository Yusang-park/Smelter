#!/usr/bin/env node
/**
 * workflow-loader.mjs — Load the v3 three-file workflow config:
 *   modes/skills.yaml     — per-skill team defaults
 *   modes/pipelines.yaml  — reusable skill sequences
 *   modes/modes.yaml      — thin mode definitions
 *
 * Replaces the legacy `modes/<mode>.json` loader in keyword-detector.mjs.
 *
 * Public API:
 *   - loadWorkflowConfig({ root? })      → raw composite { skills, pipelines, modes, command_aliases }
 *   - getMode(name, cfg?)                → expanded mode object (back-compat with old JSON shape)
 *   - nextSkill(modeName, completed, cfg?) → next uncompleted skill in pipeline, or null
 *   - scanFeatureArtifacts(featureDir)   → { brainstorm, investigation, tasks, ...: boolean }
 *   - resolveSkipFromArtifacts(mode, artifacts, cfg?) → stages to skip (file-driven routing)
 *
 * Zero-deps rule: only js-yaml (new runtime dep) + node built-ins.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = dirname(dirname(dirname(__filename)));

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let CACHED_CONFIG = null;

export function loadWorkflowConfig({ root = PLUGIN_ROOT, fresh = false } = {}) {
  if (CACHED_CONFIG && !fresh && CACHED_CONFIG._root === root) return CACHED_CONFIG;

  const read = (name) => {
    const p = join(root, 'modes', name);
    if (!existsSync(p)) throw new Error(`workflow-loader: missing ${p}`);
    return yaml.load(readFileSync(p, 'utf-8'));
  };

  const skillsDoc = read('skills.yaml');
  const pipelinesDoc = read('pipelines.yaml');
  const modesDoc = read('modes.yaml');

  const skills = skillsDoc?.skills ?? {};
  const pipelines = pipelinesDoc?.pipelines ?? {};
  const modes = modesDoc?.modes ?? {};
  const commandAliases = modesDoc?.command_aliases ?? {};

  // Structural validation — fail loud on bad config rather than producing
  // malformed state at runtime.
  for (const [modeName, m] of Object.entries(modes)) {
    if (!m.entry_skill) throw new Error(`mode ${modeName}: missing entry_skill`);
    if (!m.pipeline) throw new Error(`mode ${modeName}: missing pipeline`);
    if (!pipelines[m.pipeline]) throw new Error(`mode ${modeName}: pipeline ${m.pipeline} not found`);
    if (!skills[m.entry_skill]) throw new Error(`mode ${modeName}: entry_skill ${m.entry_skill} not in skills`);
  }

  const cfg = { skills, pipelines, modes, command_aliases: commandAliases, _root: root };
  CACHED_CONFIG = cfg;
  return cfg;
}

// ---------------------------------------------------------------------------
// Mode expansion — emits the back-compat shape consumers expect.
// ---------------------------------------------------------------------------

/**
 * getMode — return the expanded mode configuration. Shape intentionally
 * mirrors the legacy `modes/<mode>.json` files so downstream consumers
 * (keyword-detector, skill-stage-transition) can migrate with minimal diff.
 *
 * Returned object:
 *   {
 *     mode, description, entry_skill, entry_params,
 *     pipeline,                         // name (v3 addition)
 *     allowed_skills,                   // expanded from pipeline
 *     default_team_overrides,           // composed from skills.yaml
 *     default_exempt, magic_keywords, transitions, terminal_actions,
 *     read_only,                        // v3 addition
 *   }
 */
export function getMode(name, cfg = loadWorkflowConfig()) {
  const m = cfg.modes[name];
  if (!m) return null;

  const pipeline = cfg.pipelines[m.pipeline];
  if (!pipeline) throw new Error(`getMode(${name}): pipeline ${m.pipeline} missing`);

  const allowedSkills = [...pipeline];

  // Compose default_team_overrides from skills.yaml.
  // Each skill may define a single `team` or multiple named `teams`. When
  // `teams` is present, pick the one matching the mode's context hint:
  //   - mode `think` → deep
  //   - mode `implement` with entry_params.depth → that depth
  //   - mode `fix` → fix team (for workflow-coding)
  //   - fallback: first key.
  const teamHint = resolveTeamHint(name, m);
  const overrides = {};
  for (const skill of allowedSkills) {
    const skillDef = cfg.skills[skill];
    if (!skillDef) continue;
    if (skillDef.team) {
      overrides[skill] = { ...skillDef.team };
    } else if (skillDef.teams) {
      const key = skillDef.teams[teamHint] ? teamHint : Object.keys(skillDef.teams)[0];
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
  };
}

function resolveTeamHint(modeName, modeDef) {
  if (modeName === 'think') return 'deep';
  if (modeName === 'fix') return 'fix';
  if (modeName === 'implement') {
    const depth = modeDef?.entry_params?.['workflow-brainstorm']?.depth;
    if (depth === 'light' || depth === 'deep') return depth;
    return 'implement';
  }
  return 'default';
}

// ---------------------------------------------------------------------------
// File-driven routing — the superpowers-style skip logic.
// ---------------------------------------------------------------------------

// Map from produced-artifact → the workflow skill that produces it.
// Used by resolveSkipFromArtifacts to infer which stages can be skipped
// when their outputs already exist on disk.
const ARTIFACT_TO_SKILL = Object.freeze({
  'brainstorm.md': 'workflow-brainstorm',
  'brainstorm-review.md': 'workflow-brainstorm-review',
  'investigation.md': 'workflow-investigate',
  'investigation-review.md': 'workflow-investigate-review',
  'tasks.md': 'workflow-tasker',
  'tasks-review.md': 'workflow-tasker-review',
});

/**
 * scanFeatureArtifacts — inspect a feature's task/ directory and return a
 * map of { artifactFilename: boolean } for the known phase outputs.
 */
export function scanFeatureArtifacts(featureDir) {
  const taskDir = join(featureDir, 'task');
  const result = {};
  for (const filename of Object.keys(ARTIFACT_TO_SKILL)) {
    result[filename] = existsSync(join(taskDir, filename));
  }
  return result;
}

/**
 * resolveSkipFromArtifacts — given a mode and artifact scan, return the list
 * of pipeline skills that can be safely skipped because their produced file
 * already exists. Skills are returned in pipeline order.
 *
 * NOTE: this is *advisory*. The actual skip decision is taken by the skill
 * itself at entry (it reads its `produces` path and short-circuits). This
 * function is used by nextSkill() to project "where should we resume?".
 */
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

/**
 * nextSkill — return the next skill to run in the mode's pipeline, given the
 * current `completed_stages` array. Returns null when the pipeline is
 * exhausted (terminal — mode should transition or stop).
 *
 * Optionally accepts `skipFromArtifacts` (produced by resolveSkipFromArtifacts)
 * to additionally skip stages whose outputs already exist on disk — this is
 * the file-driven routing from superpowers. Stages appearing in either
 * `completed` or `skipFromArtifacts` are consumed from the pipeline head.
 */
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
// Command alias resolution — supports `/plan` → `think`, `/simple-fix` → `fix` etc.
// ---------------------------------------------------------------------------

/**
 * resolveCommandAlias — map `/plan` → `think` etc. via modes.yaml
 * `command_aliases` map. Returns the mode name on match, null otherwise.
 */
export function resolveCommandAlias(slash, cfg = loadWorkflowConfig()) {
  if (!slash) return null;
  const key = slash.startsWith('/') ? slash : `/${slash}`;
  return cfg.command_aliases[key] ?? null;
}

// ---------------------------------------------------------------------------
// CLI entry — quick sanity / smoke dump
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadWorkflowConfig();
  const summary = {
    modes: Object.keys(cfg.modes),
    pipelines: Object.keys(cfg.pipelines),
    skills: Object.keys(cfg.skills),
    command_aliases: cfg.command_aliases,
  };
  if (process.argv[2]) {
    const m = getMode(process.argv[2], cfg);
    console.log(JSON.stringify(m, null, 2));
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
}
