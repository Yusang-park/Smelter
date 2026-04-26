#!/usr/bin/env node
/**
 * workflow-state-seeder.mjs — pure, hook-free workflow state seeder.
 *
 * Extracted from keyword-detector.mjs so PreToolUse:Skill callers
 * (state-contract-injector.mjs) can seed `.state.json` for
 * agent-initiated `Skill(fix|implement|explore|verify|brainstorm)`
 * invocations — previously a silent dead-end because
 * keyword-detector only runs on UserPromptSubmit.
 *
 * Pure: no stdin/stdout side effects. Mutates the filesystem under
 * `<directory>/.smt/**` only. Logging goes through `printTag` (stderr)
 * unless `silent: true` is passed.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { printTag } from './yellow-tag.mjs';
import { writeFeatureSummary } from './feature-summary.mjs';
import {
  getMode as getV3Mode,
  loadWorkflowConfig,
  selectPipeline as v3SelectPipeline,
} from './workflow-loader.mjs';
import { parseSlashArgs, mergeSurface } from './surface-extraction.mjs';
import { sanitizeSessionId as safeSessionId } from './session-paths.mjs';
import { allowedActionsFor } from './workflow-v4-contract.mjs';
import { createInitialState, writeState } from '../state-schema.mjs';

const __filename = fileURLToPath(import.meta.url);
const LIB_DIR = dirname(__filename);
const SCRIPTS_DIR = dirname(LIB_DIR);
export const PLUGIN_ROOT = dirname(SCRIPTS_DIR);

// Defense-in-depth for the pointer filename `active-feature-<sid>.json`:
// delegated to `./session-paths.mjs` as the single source of truth so
// allow-list drift across callers is impossible.

const COMMAND_TO_MODE = Object.freeze({
  brainstorm: 'brainstorm',
  fix: 'fix',
  infra: 'infra',
  explore: 'explore',
  implement: 'implement',
  verify: 'verify',
  dobby: 'dobby',
});

// Modes that do not mutate code. Used to detect when a user/agent escalates
// from exploration to execution. Reusing a verify/explore/brainstorm state
// under Skill(fix|implement) leaves state.mode at the read-only value, and
// pre-tool-enforcer's code-file gate would then block every subsequent edit
// — the deadlock this branch fixes.
const READONLY_MODES = Object.freeze(new Set(['verify', 'explore', 'brainstorm']));
const WRITE_MODES = Object.freeze(new Set(['fix', 'implement', 'infra', 'dobby']));

const LEADING_FILLER_TOKENS = new Set([
  'a','an','the','is','are','was','were','be','been','being','do','does','did',
  'for','to','of','in','on','at','by','with','from','as','about','into','onto',
  'that','this','it','its','he','she','they','we','you','i',
  'and','or','but','if','so','then','than','because','just','please',
]);

const SYSTEM_PREAMBLE_REGEXPS = [
  /^you\s+are\s+(?:a\s+|an\s+|the\s+)?/i,
  /^(?:당신은|너는|당신이|네가)\s*/,
  /^\s*(?:skill|role|context|task|system|instruction|prompt)\s*[:：]\s*/i,
  /^(?:successfully\s+loaded\s+skill\s*[:：]?\s*)+/i,
  /^\s*\[[^\]]*magic\s+keyword[^\]]*\]\s*/i,
];

function stripSystemPreamble(text) {
  let out = text.replace(/[​-‏‪-‮⁠-⁯﻿]/g, ' ');
  let prev;
  do {
    prev = out;
    for (const re of SYSTEM_PREAMBLE_REGEXPS) out = out.replace(re, '').trimStart();
  } while (out !== prev);
  return out.trim();
}

export function deriveSlug(_prompt) {
  // UUID-fixed slug: always return `feature-<uuid>`. Previously this function
  // derived a descriptive slug from the prompt text, but that caused a
  // state↔artifact divergence bug: the seeder would create a state.json under
  // the prompt-derived slug, while the agent would naturally work under a
  // different descriptive slug (created via mkdir), leaving the state machine
  // tracking a path that had no artifacts. See
  // `.smt/features/fix-investigate-stage-completion-loop/task/investigation.md`
  // for the full divergence analysis.
  //
  // Fixing the slug to a UUID means:
  //   - the seeder's slug is non-meaningful (so agents have no incentive to
  //     invent their own descriptive alternative)
  //   - the active-feature pointer always points at a real state+artifact dir
  //   - no surprising re-slug when a different prompt carries the same
  //     descriptive intent
  //
  // Prompt is intentionally unused; kept as a parameter for API compatibility.
  return `feature-${randomUUID()}`;
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export function shouldCreateNewFeature(directory, sessionIdRaw, prompt, source, commandName = '') {
  const sessionId = safeSessionId(sessionIdRaw);
  if (source === 'slash') return { create: true, reason: 'slash-command' };
  if (commandName === 'explore' && source !== 'magic') return { create: true, reason: 'explore-command-reseed' };
  const text = String(prompt || '');
  if (/새\s*(?:feature|기능|피처)|\bnew\s+feature\b|다른\s*작업|새로\s*시작/i.test(text)) {
    return { create: true, reason: 'explicit-new-intent' };
  }
  if (!sessionId) return { create: true, reason: 'no-session' };
  const sessionPointer = join(directory, '.smt', 'state', `active-feature-${sessionId}.json`);
  if (!existsSync(sessionPointer)) return { create: true, reason: 'no-active-pointer' };
  try {
    const ptr = JSON.parse(readFileSync(sessionPointer, 'utf-8'));
    if (!ptr?.slug) return { create: true, reason: 'pointer-missing-slug' };
    const statePath = join(directory, '.smt', 'features', ptr.slug, 'task', `${ptr.slug}.state.json`);
    if (!existsSync(statePath)) return { create: true, reason: 'state-missing' };
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (Array.isArray(state.completed_stages) && state.completed_stages.includes('workflow-human-check')) {
      return { create: true, reason: 'prior-completed' };
    }
    // Mode-upgrade: the agent escalated from a read-only exploration mode
    // (verify/explore/brainstorm) to a write mode (fix/implement). Reusing
    // would leave state.mode at the read-only value, and pre-tool-enforcer
    // would then block every code Edit/Write. Create a fresh feature so the
    // new state.mode matches the command.
    //
    // Gated on source==='skill-tool' only. Natural-language follow-ups
    // (source==='magic') must stay reuse: a user sending a second Korean
    // prompt after a Korean exploration prompt still intends the same
    // feature even if the mode classifier routes the follow-up to a
    // different mode. Slash commands never reach this line — the earlier
    // slash-command branch returns create:true unconditionally.
    const requestedMode = COMMAND_TO_MODE[commandName];
    if (source === 'skill-tool' && requestedMode && WRITE_MODES.has(requestedMode) && READONLY_MODES.has(state.mode)) {
      return { create: true, reason: 'mode-upgrade' };
    }
    return { create: false, reuseSlug: ptr.slug, reuseStatePath: statePath, state };
  } catch {
    return { create: true, reason: 'pointer-parse-error' };
  }
}

function loadModeConfig(mode, log) {
  try {
    const cfg = loadWorkflowConfig({ root: PLUGIN_ROOT });
    return getV3Mode(mode, cfg);
  } catch (err) {
    log(`workflow-loader failed for ${mode}: ${err.message}`);
    return null;
  }
}

export function clearActiveFeature(directory, sessionIdRaw) {
  const sessionId = safeSessionId(sessionIdRaw);
  const tryUnlink = (p) => { try { if (existsSync(p)) unlinkSync(p); } catch {} };
  tryUnlink(join(directory, '.smt', 'state', 'active-feature.json'));
  if (sessionId) tryUnlink(join(directory, '.smt', 'state', `active-feature-${sessionId}.json`));
  tryUnlink(join(directory, '.smt', 'active_task'));
}

/**
 * Seed or reuse workflow state for a task.
 *
 * Returns `{ slug, statePath, pointerPath, reused }` on success.
 * Returns `null` when `commandName` is not a recognized mode (e.g. 'cancel',
 * 'queue', or an unknown string) so callers can no-op cleanly.
 *
 * `source`:
 *   - 'slash'      — user typed `/cmd ...`. Always create new feature.
 *   - 'magic'      — natural-language keyword. Reuse if in-flight.
 *   - 'skill-tool' — agent invoked `Skill(cmd, args: ...)`. Reuse if in-flight;
 *                    treat args like slash-args for deterministic surface extraction
 *                    (no LLM fallback — keeps hook inside 3s timeout).
 */
export function seedWorkflowState({
  directory,
  commandName,
  prompt = '',
  sessionId: sessionIdRaw = '',
  args = '',
  chainedModes = null,
  source = 'magic',
  preClassification = null,
  silent = false,
} = {}) {
  const mode = COMMAND_TO_MODE[commandName];
  if (!mode) return null;
  const sessionId = safeSessionId(sessionIdRaw);
  const log = silent ? () => {} : printTag;

  const decision = shouldCreateNewFeature(directory, sessionId, prompt, source, commandName);
  const smtStateDir = join(directory, '.smt', 'state');

  if (!decision.create) {
    try {
      if (!existsSync(smtStateDir)) mkdirSync(smtStateDir, { recursive: true });
      const pointerPath = sessionId
        ? join(smtStateDir, `active-feature-${sessionId}.json`)
        : join(smtStateDir, 'active-feature.json');
      writeAtomic(pointerPath, JSON.stringify({
        slug: decision.reuseSlug, session_id: sessionId, updated_at: Date.now(),
      }, null, 2));
      log(`Reuse active feature: ${decision.reuseSlug} (session=${sessionId || 'none'})`);
      const statePath = decision.reuseStatePath
        || join(directory, '.smt', 'features', decision.reuseSlug, 'task', `${decision.reuseSlug}.state.json`);
      return { slug: decision.reuseSlug, statePath, pointerPath, reused: true };
    } catch {
      return null;
    }
  }

  const cleanedPrompt = String(prompt || '').replace(/^\/\w+\b[:\s-]*/, '');
  const slugSource = args && args.trim() ? args : cleanedPrompt;
  const slug = deriveSlug(slugSource);
  const featuresDir = join(directory, '.smt', 'features');
  const featureDir = join(featuresDir, slug);
  const taskDir = join(featureDir, 'task');
  const stateDir = join(featureDir, 'state');
  const nonScopedPointerPath = join(smtStateDir, 'active-feature.json');

  try {
    if (existsSync(nonScopedPointerPath)) {
      const prev = JSON.parse(readFileSync(nonScopedPointerPath, 'utf-8'));
      if (prev?.slug && prev.slug !== slug) {
        if (!existsSync(smtStateDir)) mkdirSync(smtStateDir, { recursive: true });
        writeAtomic(join(smtStateDir, 'previous-feature.json'), JSON.stringify({
          slug: prev.slug, switched_at: Date.now(), new_slug: slug,
        }, null, 2));
      }
    }
  } catch {}

  const pointerPath = sessionId
    ? join(smtStateDir, `active-feature-${sessionId}.json`)
    : nonScopedPointerPath;
  let statePath = null;

  try {
    if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    if (!existsSync(smtStateDir)) mkdirSync(smtStateDir, { recursive: true });

    const planPath = join(taskDir, 'plan.md');
    if (!existsSync(planPath)) {
      const now = new Date().toISOString();
      const cleanPrompt = String(prompt || '')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        .slice(0, 2000);
      const body = cleanPrompt || (args ? `[args] ${args}` : '');
      const planContent = `---\nstatus: open\ncreated: ${now}\n---\n\n# ${slug}\n\n${body}\n\n## Plan\n\n## Wiki Links\n\n## Risks\n`;
      writeAtomic(planPath, planContent);
    }

    const workflowPath = join(stateDir, 'workflow.json');
    if (!existsSync(workflowPath)) {
      const legacy = {
        command: commandName,
        step: 'step-1',
        retry: 0,
        signals: {},
        version: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        prompt: String(prompt || '').slice(0, 500),
        session_id: sessionId || '',
      };
      writeAtomic(workflowPath, JSON.stringify(legacy, null, 2));
    }

    statePath = join(taskDir, `${slug}.state.json`);
    if (!existsSync(statePath)) {
      try {
        const modeCfg = loadModeConfig(mode, log);
        const chain = Array.isArray(chainedModes) && chainedModes.length >= 2 ? chainedModes : [];
        const machineState = createInitialState({ taskId: slug, mode, chainedModes: chain });
        if (mode === 'dobby') {
          machineState.step = 'EXECUTE';
          machineState.allowed_actions = allowedActionsFor({ task_type: machineState.task_type, step: 'EXECUTE' });
        }
        if (modeCfg?.default_exempt) {
          machineState.exempt = { ...machineState.exempt, ...modeCfg.default_exempt };
        }

        let rawSurface = null;
        if (source === 'slash' || source === 'skill-tool') {
          rawSurface = parseSlashArgs(commandName, args);
        } else if (source === 'magic') {
          if (preClassification && preClassification.passthrough !== true) {
            rawSurface = {
              schema_version: preClassification.schema_version,
              target_type: preClassification.target_type ?? null,
              exempt: preClassification.exempt ?? null,
              skip_brainstorm: preClassification.skip_brainstorm === true,
            };
          }
        }

        const merged = mergeSurface(rawSurface, modeCfg);
        machineState.target_type = merged.target_type;
        machineState.exempt = merged.exempt;
        machineState.skip_brainstorm = merged.skip_brainstorm;

        let resolvedAllowedSkills = modeCfg?.allowed_skills ?? [];
        if (modeCfg?.target_type_dispatch && merged.target_type) {
          try {
            const cfg = loadWorkflowConfig({ root: PLUGIN_ROOT });
            const pipelineName = v3SelectPipeline(mode, { target_type: merged.target_type }, cfg);
            if (pipelineName && pipelineName !== 'upgrade_required' && cfg.pipelines[pipelineName]) {
              resolvedAllowedSkills = [...cfg.pipelines[pipelineName]];
              log(`Pipeline: ${pipelineName} (target_type=${merged.target_type})`);
            }
          } catch (err) {
            log(`Pipeline resolution failed: ${err.message}`);
          }
        }
        if (resolvedAllowedSkills.length) machineState.allowed_skills = resolvedAllowedSkills;
        if (typeof modeCfg?.entry_skill === 'string' && machineState.allowed_skills.includes(modeCfg.entry_skill)) {
          machineState.current_stage = modeCfg.entry_skill;
        }
        writeState(statePath, machineState);
      } catch (err) {
        log(`State seed failed: ${err.message}`);
        return null;
      }
    }

    writeFeatureSummary(directory, slug, {
      status: 'in_progress',
      current_step: 'step-1',
      e2e_required: commandName === 'fix' || commandName === 'implement',
      e2e_done: false,
      tests_required: commandName === 'fix' || commandName === 'implement',
      tests_pass: false,
      review_required: commandName === 'fix' || commandName === 'implement' || commandName === 'infra',
      review_done: false,
      surface: [],
      updated_at: new Date().toISOString(),
    });

    writeAtomic(pointerPath, JSON.stringify({
      slug, session_id: sessionId, updated_at: Date.now(),
    }, null, 2));

    return { slug, statePath, pointerPath, reused: false };
  } catch (err) {
    // Previously a bare `catch { return null; }` silently swallowed every
    // mkdir/writeAtomic/writeState failure. Downstream guards (pre-tool-enforcer
    // code-file gate) then blocked every Edit/Write for the rest of the session
    // with no upstream cause to diagnose. Emit a single-line diagnostic via the
    // existing log helper; control flow (return null) is unchanged.
    log(`State seed failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
