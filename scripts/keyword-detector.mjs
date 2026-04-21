#!/usr/bin/env node

/**
 * Smelter command detector hook (Node.js)
 * Detects documented explicit slash commands AND natural-language magic keywords,
 * then activates harness state + injects a skill invocation payload.
 * Cross-platform: Windows, macOS, Linux.
 *
 * Priority: (1) explicit slash command → (2) magic keyword (natural language).
 *
 * Supported slash commands:
 *   plan, simple-fix, fix, investigate, verify, implement, cancel, queue.
 *
 * Supported magic-keyword (natural-language) mapping:
 *   plan / deep interview / 설계해줘 / 계획부터      -> plan
 *   new feature / 새 기능 / design first             -> plan (planning-first)
 *   extend / add to / 덧붙여                         -> implement (brainstorm skipped)
 *   fix / bug / 버그                                 -> fix (E2E forced for interface surface)
 *   style / typo / 텍스트 / 색상 / i18n              -> simple-fix (TDD exemption hint)
 *   verify / validate / 검증 / 점검                  -> verify
 *   analyze / investigate / 파악 / 분석              -> investigate
 *   cancel / stop                                    -> cancel
 *   queue                                            -> queue (explicit only)
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { clearCancel } from './lib/cancel-signal.mjs';
import { propagateHardCancel, propagateQueueCancel } from './cancel-propagator.mjs';
import { classifyPrompt } from './lib/subagent-classifier.mjs';
import { classify as ruleClassify } from './mode-classifier.mjs';
import { printTag } from './lib/yellow-tag.mjs';
import { writeFeatureSummary } from './lib/feature-summary.mjs';
import { createInitialState, writeState } from './state-schema.mjs';
import { getMode as getV3Mode, loadWorkflowConfig, selectPipeline as v3SelectPipeline } from './lib/workflow-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = dirname(__dirname);

// Command name (on disk) → v3 mode id. v3 canonical modes only; legacy
// /plan and /simple-fix commands are removed entirely.
const COMMAND_TO_MODE = {
  think: 'think',
  fix: 'fix',
  investigate: 'investigate',
  implement: 'implement',
  verify: 'verify',
};

// v3 loader: reads modes/{skills,pipelines,modes}.yaml via workflow-loader.mjs.
// No legacy JSON fallback — modes/*.json has been removed.
function loadModeConfig(mode) {
  try {
    const cfg = loadWorkflowConfig({ root: PLUGIN_ROOT });
    return getV3Mode(mode, cfg);
  } catch (err) {
    printTag(`workflow-loader failed for ${mode}: ${err.message}`);
    return null;
  }
}

// Read stdin synchronously
function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

// Extract prompt from various JSON structures
function extractPrompt(input) {
  try {
    const data = JSON.parse(input);
    if (data.prompt) return data.prompt;
    if (data.message?.content) return data.message.content;
    if (Array.isArray(data.parts)) {
      return data.parts
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join(' ');
    }
    return '';
  } catch {
    const match = input.match(/"(?:prompt|content|text)"\s*:\s*"([^"]+)"/);
    return match ? match[1] : '';
  }
}

/**
 * Strip XML/URL/path/code so magic-keyword detection does not false-positive on
 * pasted code, system reminders, or agent tool outputs.
 * Previously used by regex magic-keyword detection; now replaced by Haiku sub-agent classifier.
 */

function extractExplicitHarnessCommand(prompt) {
  if (!prompt) return null;
  const trimmed = prompt.trim();
  // `[\s\S]*` (not `.*`) so the arg capture crosses newlines — a user
  // starting with `/fix` followed by a pasted multi-line transcript still
  // matches the slash command and bypasses the transcript-paste heuristic
  // (TPP6).
  const match = trimmed.match(/^\/(think|fix|investigate|implement|verify|cancel|queue)\b(?:[:\s-]*([\s\S]*))?$/i);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    args: (match[2] || '').trim(),
    source: 'slash',
  };
}

// Internal map: mode-classifier emits v3 mode ids, detector contract speaks
// dash-cased command names (matches file names in commands/).
const MODE_TO_COMMAND = {
  think: 'think',
  fix: 'fix',
  investigate: 'investigate',
  verify: 'verify',
  implement: 'implement',
};

// Prior versions carried `FIX_PATTERNS` + `INVESTIGATE_PATTERNS` + a
// `legacyPatternMatch` helper used when `ruleClassify` returned `default:*`.
// In v2.4.9 the LLM is the sole natural-language classifier. No regex fallback.
// If `ruleClassify` throws (LLM outage, malformed response, etc.), the caller
// treats it as "no classification" and the prompt flows through unseeded.

// Claude Code assistant-transcript markers. A prompt dominated by these is
// almost certainly the user pasting a prior session log to ask about it, not
// a real work request — the classifier would otherwise misfire on stray
// `fix:`/`Stop hook error:` tokens and seed a spurious /fix chain.
//
// Threshold is "≥2 distinct pattern hits" (NOT line-percentage) — simple,
// deterministic, and tolerant of short prompts where any percentage clause
// would be unstable. A single incidental `fix:` mention cannot reach two
// distinct markers.
// Global flags so match().length yields the occurrence count per pattern.
// Dominance heuristic counts OCCURRENCES across all patterns; ≥2 total
// matches = transcript paste. So two ⏺ bullets alone (same pattern, twice)
// still exceed the threshold — the previous distinct-pattern count missed
// that case (TPP4).
const TRANSCRIPT_PATTERNS = [
  /^\s*⏺/gm,                                   // assistant-bullet marker
  /^\s*⎿/gm,                                   // tool-result connector
  /^\s*Stop hook (?:error|feedback)\b/gim,
  /Ran \d+ stop hooks?/gi,
  /\[(?:master|main)\s+[0-9a-f]{7,40}\]/gi,    // git-commit banner
];

export function isTranscriptPaste(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  let hits = 0;
  for (const re of TRANSCRIPT_PATTERNS) {
    const matches = s.match(re);
    if (matches) hits += matches.length;
    if (hits >= 2) return true;
  }
  return false;
}

// Strip ANSI escape sequences and C0/C1 control characters before emitting
// user-controlled text to stderr — an attacker-shaped prompt could otherwise
// move the cursor / clear the screen / inject bell chars via printTag.
function sanitizeForLog(text, max = 80) {
  return String(text ?? '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .slice(0, max);
}

export function detectNaturalLanguageCommand(prompt, { cwd = process.cwd(), sessionId = '' } = {}) {
  const text = String(prompt || '').trim();
  if (!text) return null;

  // Transcript-paste heuristic: a prompt dominated by Claude Code transcript
  // markers (≥2 distinct patterns) is passed through without mode seeding.
  // Rollback lever: set SMELTER_SKIP_TRANSCRIPT_HEURISTIC=1 to disable.
  if (process.env.SMELTER_SKIP_TRANSCRIPT_HEURISTIC !== '1' && isTranscriptPaste(text)) {
    return { passthrough: true, matched: 'transcript-paste', source: 'passthrough' };
  }

  // LLM classifier is the sole natural-language router (v2.4.9). On failure
  // the error propagates — treat that as "no classification" in main() so the
  // prompt flows through without state seeding. No regex fallback.
  let classification;
  try {
    classification = ruleClassify(text, { cwd, sessionId });
  } catch {
    return null;
  }
  if (!classification) return null;
  const trigger = classification.trigger || '';

  // Passthrough — pure shell / git ops bail out entirely. MUST run BEFORE any
  // `MODE_TO_COMMAND[mode]` lookup because passthrough classifications return
  // `mode: null`, and indexing `MODE_TO_COMMAND[null]` would read an inherited
  // property (e.g. `null.toString`) on a malformed map.
  if (classification.passthrough === true) {
    const active = shouldCreateNewFeature(cwd, sessionId, text, 'magic');
    if (!active.create && active.state?.current_stage && active.state.current_stage !== 'done') {
      return {
        name: active.state.mode === 'verify' ? 'verify' : 'investigate',
        args: '',
        hint: 'active-workflow-continuation',
        matched: `active-workflow:${trigger || 'passthrough'}`,
        source: 'magic',
        chained_modes: null,
      };
    }
    return { passthrough: true, matched: trigger, source: 'passthrough' };
  }

  const entryCommand = MODE_TO_COMMAND[classification.mode];
  if (!entryCommand) return null;

  const chain = Array.isArray(classification.chained_modes) && classification.chained_modes.length >= 2
    ? classification.chained_modes
    : null;

  return {
    name: entryCommand,
    args: '',
    hint: classification.mode === 'fix' ? 'bug' : null,
    matched: trigger,
    source: 'magic',
    chained_modes: chain,
  };
}

// Command → v3 mode mapping. Five workflow commands; `queue` and `cancel`
// are utility commands (no mode). Modes resolved via workflow-loader.mjs
// from modes/workflow.yaml.
const COMMAND_CONFIG = {
  think:       { mode: 'think' },
  fix:         { mode: 'fix' },
  investigate: { mode: 'investigate' },
  verify:      { mode: 'verify' },
  implement:   { mode: 'implement' },
};

function writeStateFile(directory, filename, data) {
  const localDir = join(directory, '.smt', 'state');
  if (!existsSync(localDir)) {
    try { mkdirSync(localDir, { recursive: true }); } catch {}
  }
  try { writeFileSync(join(localDir, filename), JSON.stringify(data, null, 2), { mode: 0o600 }); } catch {}
}

// v2 no longer uses fixed step numbers. Retained empty for back-compat so
// `seedWorkflowState` short-circuits (see guard below) — v2 state.json is
// seeded on demand by `scripts/state-schema.mjs` when an actual workflow
// skill advances, not on command detection.
const INITIAL_STEP = {};

// Slug from prompt: first meaningful domain words, sanitized.
// Empty/punctuation-only prompts get a collision-resistant timestamp+random fallback.
//
// Defense-in-depth behind the `SMELTER_CLASSIFIER_SUBPROCESS` env guard in main():
// if a classifier system prompt ("You are a command classifier…") or an echoed
// skill-loader banner ever reaches deriveSlug, strip the non-domain preamble so
// the feature directory reflects the actual work, not the boilerplate.
const SYSTEM_PREAMBLE_REGEXPS = [
  /^you\s+are\s+(?:a\s+|an\s+|the\s+)?/i,              // "You are a X"
  /^(?:당신은|너는|당신이|네가)\s*/,                      // Korean copula openers
  /^\s*(?:skill|role|context|task|system|instruction|prompt)\s*[:：]\s*/i,
  /^(?:successfully\s+loaded\s+skill\s*[:：]?\s*)+/i,    // echoed skill-loader banner
  /^\s*\[[^\]]*magic\s+keyword[^\]]*\]\s*/i,            // "[MAGIC KEYWORD: X]" label
];

function stripSystemPreamble(text) {
  // Replace zero-width / format chars with a space so they cannot split a
  // preamble (e.g. `"You\u200Bare a…"` would otherwise leave `"Youare"` which
  // bypasses the `^you\s+are` regex — dropping them entirely would also fail).
  let out = text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, ' ');
  // Loop until stable so stacked preambles peel completely
  // (e.g. `"System: You are a …"` must lose both `System:` and `You are a`).
  let prev;
  do {
    prev = out;
    for (const re of SYSTEM_PREAMBLE_REGEXPS) out = out.replace(re, '').trimStart();
  } while (out !== prev);
  return out.trim();
}

// Leading filler tokens that should never start a slug.
const LEADING_FILLER_TOKENS = new Set([
  'a','an','the','is','are','was','were','be','been','being','do','does','did',
  'for','to','of','in','on','at','by','with','from','as','about','into','onto',
  'that','this','it','its','he','she','they','we','you','i',
  'and','or','but','if','so','then','than','because','just','please',
]);

function deriveSlug(prompt) {
  const raw = (prompt || '').toString().trim();
  const stripped = stripSystemPreamble(raw);
  const base = (stripped || raw).slice(0, 120).toLowerCase();

  const tokens = base
    .replace(/[^a-z0-9가-힣\s-]+/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);

  while (tokens.length > 1 && LEADING_FILLER_TOKENS.has(tokens[0])) tokens.shift();

  const slug = tokens.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

  if (slug) return slug;
  const suffix = randomBytes(3).toString('hex');
  return `feature-${Date.now().toString(36)}-${suffix}`;
}

// Atomic single-file write (tmp + rename) to avoid torn state on crash.
function writeAtomic(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

// Phase 11 C — decide whether this prompt should create a NEW feature directory
// or reuse the currently-active one for this session.
//
// Rules:
//   - Explicit slash command (source === 'slash')           → new feature
//   - Prompt mentions "새 feature" / "새 기능" / "다른 작업"  → new feature
//   - Otherwise, if per-session pointer exists AND its state
//     is not yet done                                       → REUSE existing
//   - No active pointer / state.done                        → new feature
//
// Per-session scoping is intentional: one Claude Code invocation may span
// multiple concurrent sessions sharing .smt/; key off session_id so one
// session does not drag another session's active feature around.
function shouldCreateNewFeature(directory, sessionId, prompt, source, commandName = '') {
  if (source === 'slash') return { create: true, reason: 'slash-command' };
  if (commandName === 'investigate') return { create: true, reason: 'investigate-command-reseed' };
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
    if (state.current_stage === 'done') return { create: true, reason: 'prior-done' };
    return { create: false, reuseSlug: ptr.slug, reuseStatePath: statePath, state };
  } catch { return { create: true, reason: 'pointer-parse-error' }; }
}

/**
 * applyMagicKeywords — scan the prompt for keys listed in modeCfg.magic_keywords
 * and apply each key's `set: {...}` to the state. Returns a summary of what was
 * applied (specifically `target_type`) so the caller can drive pipeline selection.
 *
 * Each magic keyword entry shape (from modes/workflow.yaml):
 *   typo: { set: { exempt.tdd: true, exempt.e2e: true, target_type: 'typo' } }
 *
 * Dotted keys under `set.exempt` are applied to state.exempt.*;
 * flat keys like `target_type` / `skip_brainstorm` are applied to state.<key>.
 *
 * @param {string} prompt
 * @param {object} modeCfg — output of loadModeConfig (workflow-loader getMode shape)
 * @param {object} state — mutable machineState being seeded
 * @returns {{ target_type?: string, skip_brainstorm?: boolean, matched: string[] }}
 */
function applyMagicKeywords(prompt, modeCfg, state) {
  const applied = { matched: [] };
  const text = String(prompt || '');
  const magic = modeCfg?.magic_keywords;
  if (!text || !magic || typeof magic !== 'object') return applied;

  for (const [keyword, spec] of Object.entries(magic)) {
    // Case-insensitive match on whole prompt. For ASCII keywords use
    // word-boundary `\b` (prevents `typography` matching `typo`). For non-ASCII
    // keywords (CJK: 텍스트, 덧붙여, 추가로) `\b` fails because CJK chars are
    // not in \w, so fall back to plain substring match. Multi-word keys (`add
    // to`) still work via word boundary on the outer edges.
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isAscii = /^[\x00-\x7F]+$/.test(keyword);
    const re = isAscii
      ? new RegExp(`\\b${escaped}\\b`, 'i')
      : new RegExp(escaped, 'i');
    if (!re.test(text)) continue;
    applied.matched.push(keyword);
    const set = spec?.set;
    if (!set || typeof set !== 'object') continue;

    for (const [k, v] of Object.entries(set)) {
      if (k.startsWith('exempt.')) {
        const sub = k.slice('exempt.'.length);
        state.exempt = { ...(state.exempt ?? {}), [sub]: v };
      } else if (k === 'target_type') {
        state.target_type = v;
        applied.target_type = v;
      } else if (k === 'skip_brainstorm') {
        applied.skip_brainstorm = Boolean(v);
      } else {
        state[k] = v;
      }
    }
  }

  return applied;
}

function seedWorkflowState(directory, commandName, prompt, sessionId, args = '', chainedModes = null, source = 'magic') {
  const mode = COMMAND_TO_MODE[commandName];
  if (!mode) return; // cancel, queue — utility commands, not v2 workflow modes

  // Phase 11 C: reuse active feature for natural-language follow-ups.
  const decision = shouldCreateNewFeature(directory, sessionId, prompt, source, commandName);
  if (!decision.create) {
    const smtStateDir = join(directory, '.smt', 'state');
    try {
      if (!existsSync(smtStateDir)) mkdirSync(smtStateDir, { recursive: true });
      // Session-scoped pointer is the primary. Non-scoped `active-feature.json`
      // is only written when session_id is absent (legacy CLI / test sim).
      // Global `.smt/active_task` is no longer written — concurrent sessions
      // would overwrite each other. See migration-investigation.md.
      if (sessionId) {
        writeAtomic(join(smtStateDir, `active-feature-${sessionId}.json`), JSON.stringify({ slug: decision.reuseSlug, session_id: sessionId, updated_at: Date.now() }, null, 2));
      } else {
        writeAtomic(join(smtStateDir, 'active-feature.json'), JSON.stringify({ slug: decision.reuseSlug, session_id: '', updated_at: Date.now() }, null, 2));
      }
      printTag(`Reuse active feature: ${decision.reuseSlug} (session=${sessionId || 'none'})`);
    } catch {}
    return;
  }

  // Prefer slash-args for slug derivation (ignore the leading slash-command literal).
  // For natural-language magic-keyword invocations, args is empty so we fall back
  // to the prompt with any leading slash-command token stripped.
  const cleanedPrompt = String(prompt || '').replace(/^\/\w+\b[:\s-]*/, '');
  const slugSource = args && args.trim() ? args : cleanedPrompt;
  const slug = deriveSlug(slugSource);
  const featuresDir = join(directory, '.smt', 'features');
  const featureDir = join(featuresDir, slug);
  const taskDir = join(featureDir, 'task');
  const stateDir = join(featureDir, 'state');
  const smtStateDir = join(directory, '.smt', 'state');
  const pointerPath = join(smtStateDir, 'active-feature.json');

  // Cross-slug switch detection: warn if an active feature exists with a different slug
  // and its workflow is in-flight. User explicitly invoked a new command, so honor it,
  // but preserve the prior pointer content as last-active for troubleshooting.
  try {
    if (existsSync(pointerPath)) {
      const prev = JSON.parse(readFileSync(pointerPath, 'utf-8'));
      if (prev?.slug && prev.slug !== slug) {
        try {
          if (!existsSync(smtStateDir)) mkdirSync(smtStateDir, { recursive: true });
          writeAtomic(join(smtStateDir, 'previous-feature.json'), JSON.stringify({
            slug: prev.slug, switched_at: Date.now(), new_slug: slug,
          }, null, 2));
        } catch {}
      }
    }
  } catch {}

  try {
    if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    if (!existsSync(smtStateDir)) mkdirSync(smtStateDir, { recursive: true });

    // plan.md (only create if missing — don't clobber prior plans)
    const planPath = join(taskDir, 'plan.md');
    if (!existsSync(planPath)) {
      const now = new Date().toISOString();
      // Sanitize prompt body: strip control chars and system-reminder-like leakage
      const cleanPrompt = String(prompt || '')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        .slice(0, 2000);
      const planContent = `---\nstatus: open\ncreated: ${now}\n---\n\n# ${slug}\n\n${cleanPrompt}\n\n## Plan\n\n## Wiki Links\n\n## Risks\n`;
      writeAtomic(planPath, planContent);
    }

    // workflow.json — v1 legacy, seed only if absent so re-running a command
    // doesn't reset progress. v2 enforcement reads `.state.json` (below).
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

    // .state.json — v2 source of truth consumed by critic-watchdog, auto-confirm,
    // route-on-fail. Without this file, every enforcement rule that starts with
    // `if (!state) return null` no-ops, which lets an agent bypass the entire
    // /fix → investigate → ... → human-check pipeline by writing code directly.
    // See critic-watchdog.mjs R12 for the companion block.
    const stateJsonPath = join(taskDir, `${slug}.state.json`);
    if (!existsSync(stateJsonPath)) {
      try {
        const modeCfg = loadModeConfig(mode);
        const chain = Array.isArray(chainedModes) && chainedModes.length >= 2 ? chainedModes : [];
        const machineState = createInitialState({ taskId: slug, mode, chainedModes: chain });
        if (modeCfg?.default_exempt) {
          machineState.exempt = { ...machineState.exempt, ...modeCfg.default_exempt };
        }

        // v3.1 — apply magic_keywords from the prompt: exempt flags, target_type,
        // skip_brainstorm. This is what wires the `/fix typo ...` → target_type=typo
        // → minimal-pipeline path that prior versions declared but never executed.
        const magicApplied = applyMagicKeywords(prompt, modeCfg, machineState);

        // v3.1 — if target_type_dispatch is set and we now have a target_type
        // (from magic keyword), resolve the runtime pipeline via selectPipeline.
        // Otherwise fall back to the mode's default allowed_skills.
        let resolvedAllowedSkills = modeCfg?.allowed_skills ?? [];
        if (modeCfg?.target_type_dispatch && magicApplied.target_type) {
          try {
            const cfg = loadWorkflowConfig({ root: PLUGIN_ROOT });
            const pipelineName = v3SelectPipeline(mode, { target_type: magicApplied.target_type }, cfg);
            if (pipelineName && pipelineName !== 'upgrade_required' && cfg.pipelines[pipelineName]) {
              resolvedAllowedSkills = [...cfg.pipelines[pipelineName]];
              machineState.target_type = magicApplied.target_type;
              printTag(`Pipeline: ${pipelineName} (target_type=${magicApplied.target_type})`);
            }
          } catch (err) {
            printTag(`Pipeline resolution failed: ${err.message}`);
          }
        }
        if (resolvedAllowedSkills.length) {
          machineState.allowed_skills = resolvedAllowedSkills;
        }
        if (typeof modeCfg?.entry_skill === 'string' && machineState.allowed_skills.includes(modeCfg.entry_skill)) {
          machineState.current_stage = modeCfg.entry_skill;
        }
        writeState(stateJsonPath, machineState);
        // Global `.smt/active_task` is no longer written — per-session pointer
        // below (line near activeFeaturePointer write) is authoritative.
      } catch (err) {
        // Never block command detection on state seeding — log-and-continue.
        printTag(`State seed failed: ${err.message}`);
      }
    }

    writeFeatureSummary(directory, slug, {
      status: 'in_progress',
      current_step: 'step-1',
      e2e_required: commandName === 'build' || commandName === 'fix' || commandName === 'implement',
      e2e_done: false,
      tests_required: commandName === 'build' || commandName === 'fix' || commandName === 'implement',
      tests_pass: false,
      review_required: commandName === 'build' || commandName === 'fix' || commandName === 'implement',
      review_done: false,
      surface: [],
      updated_at: new Date().toISOString(),
    });

    // Session-scoped active-feature pointer is primary. Non-scoped pointer
    // is written only when session_id is absent (legacy CLI / sim path).
    if (sessionId) {
      writeAtomic(join(smtStateDir, `active-feature-${sessionId}.json`), JSON.stringify({ slug, session_id: sessionId, updated_at: Date.now() }, null, 2));
    } else {
      writeAtomic(pointerPath, JSON.stringify({ slug, session_id: '', updated_at: Date.now() }, null, 2));
    }
  } catch {}
}

// Clear active-feature pointer(s) — called on /cancel so the next
// UserPromptSubmit does not silently resume a cancelled feature. Covers:
//   - per-session pointer `.smt/state/active-feature-<sessionId>.json`
//   - non-scoped pointer `.smt/state/active-feature.json` (legacy / sim)
//   - legacy `.smt/active_task` pointer (transitional cleanup)
// Without unlinking per-session, a cancelled chain is silently resurrected
// by the next prompt since session-aware consumers still read it.
function clearActiveFeature(directory, sessionId) {
  const tryUnlink = (p) => { try { if (existsSync(p)) unlinkSync(p); } catch {} };
  tryUnlink(join(directory, '.smt', 'state', 'active-feature.json'));
  if (sessionId) {
    tryUnlink(join(directory, '.smt', 'state', `active-feature-${sessionId}.json`));
  }
  tryUnlink(join(directory, '.smt', 'active_task'));
}

function activateHarnessState(directory, commandName, prompt, sessionId, args = '', chainedModes = null, source = 'magic') {
  const config = COMMAND_CONFIG[commandName];
  if (!config) return;
  seedWorkflowState(directory, commandName, prompt, sessionId, args, chainedModes, source);
}

function createSkillInvocation(skillName, originalPrompt, args = '', hint = null) {
  const argsSection = args ? `\nArguments: ${args}` : '';
  const hintSection = hint ? `\nBranch hint: ${hint}` : '';
  return `[MAGIC KEYWORD: ${skillName.toUpperCase()}]

You MUST invoke the skill using the Skill tool:

Skill: ${skillName}${argsSection}${hintSection}

User request:
${originalPrompt}

IMPORTANT: Invoke the skill IMMEDIATELY. Do not proceed without loading the skill instructions.`;
}

function createHookOutput(additionalContext) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
}

async function main() {
  // Re-entrancy guard: when `lib/subagent-classifier.mjs` spawns the Claude CLI
  // to run the Haiku classifier, that subprocess inherits our hook chain, so
  // keyword-detector runs on the CLASSIFIER'S system prompt as if it were user
  // input. That was seeding `.state.json` / active-feature pointers with slugs
  // derived from "You are a command classifier for a CLI tool called..." and
  // polluting the real session's state. The env flag is set by invokeClaude
  // below; detect + bail before any side effect.
  if (process.env.SMELTER_CLASSIFIER_SUBPROCESS === '1') {
    console.log(JSON.stringify({ continue: true }));
    return;
  }
  printTag('Keyword Detector');
  try {
    const input = readStdinSync();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    let data = {};
    try { data = JSON.parse(input); } catch {}
    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';

    const prompt = extractPrompt(input);
    if (!prompt) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // (1) Explicit slash command takes priority
    let detected = extractExplicitHarnessCommand(prompt);

    // (2) Deterministic natural-language routing for high-confidence prompts
    if (!detected) {
      detected = detectNaturalLanguageCommand(prompt, { cwd: directory, sessionId });
      if (detected?.passthrough === true) {
        // Pure shell / git op — no workflow mode, no state seeding.
        printTag(`Passthrough: ${sanitizeForLog(detected.matched)}`);
        console.log(JSON.stringify({ continue: true }));
        return;
      }
      if (detected) {
        printTag(`Magic Keyword: Local classified command`);
      }
    }

    // (3) Haiku sub-agent classifier for remaining non-slash prompts
    if (!detected) {
      const classification = classifyPrompt(prompt, { cwd: directory, sessionId });
      if (classification.intent === 'command' && classification.command) {
        const validCommands = ['think', 'fix', 'investigate', 'implement', 'verify', 'cancel', 'queue'];
        const cmd = classification.command.toLowerCase().replace(/^\//, '');
        if (validCommands.includes(cmd)) {
          printTag(`Magic Keyword: Haiku classified command`);
          detected = {
            name: cmd,
            args: '',
            hint: classification.branch || null,
            matched: `Haiku:${cmd}`,
            source: 'magic',
          };
        }
      }
      if (!detected && classification.intent === 'question') {
        printTag(`Magic Keyword: Haiku classified question`);
      }
    }

    // Clear stale cancel signals on any non-cancel/queue prompt
    if (!detected || (detected.name !== 'cancel' && detected.name !== 'queue')) {
      clearCancel(directory);
    }

    // Auto-detect interrupt
    const interruptMarkerPath = join(directory, '.smt', 'state', 'last-interrupt.json');
    let wasInterrupted = false;
    if (existsSync(interruptMarkerPath)) {
      try {
        const marker = JSON.parse(readFileSync(interruptMarkerPath, 'utf-8'));
        if (Date.now() - marker.timestamp < 60_000) wasInterrupted = true;
      } catch {}
      try { unlinkSync(interruptMarkerPath); } catch {}
    }

    if (!detected) {
      if (wasInterrupted) {
        printTag('Detect: Interrupt');
        console.log(JSON.stringify(createHookOutput(
          `[INTERRUPTED] The previous response was interrupted by the user. IMPORTANT: Follow the NEW instruction below. Do NOT continue or resume previous work unless explicitly asked.`
        )));
      } else {
        console.log(JSON.stringify({ continue: true }));
      }
      return;
    }

    // Trace
    let tracer = null;
    try { tracer = await import('../dist/hooks/subagent-tracker/flow-tracer.js'); } catch {}
    if (tracer) {
      try { tracer.recordKeywordDetected(directory, sessionId, detected.name); } catch {}
    }

    // /cancel
    if (detected.name === 'cancel') {
      printTag('Command: /cancel');
      const result = propagateHardCancel(directory, 'user /cancel command');
      clearActiveFeature(directory, sessionId);
      const killedMsg = result.killed.length > 0 ? `\nKilled: ${result.killed.join(', ')}` : '';
      const clearedMsg = result.cleared.length > 0 ? `\nCleared: ${result.cleared.join(', ')}` : '';
      console.log(JSON.stringify(createHookOutput(
        `[CANCEL] Hard cancel executed. All work stopped.${killedMsg}${clearedMsg}\n\nInform the user that cancellation is complete. Do NOT continue any previous work. Await new instructions.`
      )));
      return;
    }

    // /queue (slash-only; magic keyword not supported for queue)
    if (detected.name === 'queue') {
      printTag('Command: /queue');
      const intent = detected.args;
      if (!intent) {
        console.log(JSON.stringify(createHookOutput(
          `[QUEUE ERROR] No intent provided. Usage: /queue <what to do next>\nExample: /queue fix the login bug`
        )));
        return;
      }
      propagateQueueCancel(directory, intent, 'user /queue command', sessionId);
      console.log(JSON.stringify(createHookOutput(
        `[QUEUED] Intent queued for after current work completes: "${intent}"\n\nContinue current work. When the current task finishes, switch to the queued intent instead of continuing the old plan.`
      )));
      return;
    }

    // Harness commands — activate state
    activateHarnessState(directory, detected.name, prompt, sessionId, detected.args || '', detected.chained_modes || null, detected.source || 'magic');
    if (tracer) {
      try { tracer.recordModeChange(directory, sessionId, 'none', detected.name); } catch {}
    }

    // MODE banner (once per session per command)
    const MODE_LABELS = {
      plan: 'PLAN MODE',
      build: 'BUILD MODE',
      fix: 'FIX MODE',
      'simple-fix': 'SIMPLE-FIX MODE',
      investigate: 'INVESTIGATE MODE',
      implement: 'IMPLEMENT MODE',
      verify: 'VERIFY MODE',
    };
    const modeLabel = MODE_LABELS[detected.name];
    if (modeLabel) {
      const bannerFile = join(directory, '.smt', 'state', `mode-emitted-${sessionId || 'default'}.json`);
      let alreadyEmitted = false;
      try { alreadyEmitted = JSON.parse(readFileSync(bannerFile, 'utf-8')).mode === detected.name; } catch {}
      if (!alreadyEmitted) {
        printTag(modeLabel);
        try {
          const stateDir = join(directory, '.smt', 'state');
          if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
          writeFileSync(bannerFile, JSON.stringify({ mode: detected.name, ts: Date.now() }));
        } catch {}
      }
    }

    if (detected.source === 'magic') {
      const hintTag = detected.hint ? ` (${detected.hint})` : '';
      const publicName = detected.name;
      printTag(`Magic Keyword: ${detected.matched} → /${publicName}${hintTag}`);
    } else {
      printTag(`Command: /${detected.name}`);
    }

    console.log(JSON.stringify(createHookOutput(
      createSkillInvocation(detected.name, prompt, detected.args, detected.hint)
    )));
  } catch (error) {
    console.log(JSON.stringify({ continue: true }));
  }
}

// Guard: only run main() when this file is the entry module (CLI/hook path).
// Test files import `detectNaturalLanguageCommand` and `isTranscriptPaste`
// as pure functions; without this guard, module evaluation would enter main(),
// which reads /dev/stdin and hangs under `node --test` (stdin inherited from
// runner never closes). Runtime behavior unchanged — hook invocation still
// matches `file://${process.argv[1]}`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
