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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = dirname(__dirname);

// Command name as it appears on disk (e.g. `simple-fix`) → internal mode id
// used by state-schema (`simple_fix`). Only differs where the slash uses `-`
// but the mode enum uses `_`.
const COMMAND_TO_MODE = {
  plan: 'plan',
  fix: 'fix',
  'simple-fix': 'simple_fix',
  investigate: 'investigate',
  implement: 'implement',
  verify: 'verify',
};

function loadModeConfig(mode) {
  const modePath = join(PLUGIN_ROOT, 'modes', `${mode}.json`);
  if (!existsSync(modePath)) return null;
  try { return JSON.parse(readFileSync(modePath, 'utf-8')); } catch { return null; }
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
  const match = trimmed.match(/^\/(plan|build|fix|simple-fix|investigate|implement|verify|cancel|queue)\b(?:[:\s-]*(.*))?$/i);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    args: (match[2] || '').trim(),
    source: 'slash',
  };
}

const FIX_PATTERNS = [
  /\bfix\b/i,
  /\bcorrect(?:ion)?\b/i,
  /\bpatch\b/i,
  /\bresolve\b/i,
  /\bdirect correction\b/i,
  /버그|고쳐|수정|해결해|오류|에러/,
];

const INVESTIGATE_PATTERNS = [
  /\bcheck\b/i,
  /\binvestigate\b/i,
  /\binspect\b/i,
  /\bdiagnose\b/i,
  /\bverify\b/i,
  /\blook into\b/i,
  /\btriage\b/i,
  /\bdebug\b/i,
  /\broot cause\b/i,
  /분석|조사|확인해|살펴봐|진단/,
];

// Internal map: mode-classifier emits mode ids (enum in state-schema MODES), but
// detector contract speaks dash-cased command names (matches file names in
// commands/ and keys in COMMAND_CONFIG below).
const MODE_TO_COMMAND = {
  simple_fix: 'simple-fix',
  fix: 'fix',
  investigate: 'investigate',
  verify: 'verify',
  plan: 'plan',
  implement: 'implement',
};

// Legacy helper retained for scripts/test-keyword-detector.mjs compatibility and
// as a tight fallback when mode-classifier returns its `default:*` trigger. The
// canonical classifier is now `scripts/mode-classifier.mjs` — see wireup below.
function legacyPatternMatch(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  const hasFix = FIX_PATTERNS.some((pattern) => pattern.test(text));
  const hasInvestigate = INVESTIGATE_PATTERNS.some((pattern) => pattern.test(text));
  if (hasFix) {
    return { name: 'fix', args: '', hint: 'bug', matched: 'local:fix', source: 'magic' };
  }
  if (hasInvestigate) {
    return { name: 'investigate', args: '', hint: null, matched: 'local:investigate', source: 'magic' };
  }
  return null;
}

export function detectNaturalLanguageCommand(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return null;

  const classification = ruleClassify(text);
  const trigger = classification.trigger || '';
  const entryCommand = MODE_TO_COMMAND[classification.mode];

  // Classifier's safe default fires when no rule matched. Defer to the legacy
  // bi-pattern matcher so broad English verbs (\bcheck\b, \bdebug\b, \bresolve\b)
  // retained by FIX_PATTERNS / INVESTIGATE_PATTERNS keep routing as they did.
  if (trigger.startsWith('default:') || !entryCommand) {
    return legacyPatternMatch(text);
  }

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

// Command → v2 mode mapping. The six workflow commands map to modes in
// `modes/<mode>.json`; `queue` and `cancel` are utility commands (no mode).
const COMMAND_CONFIG = {
  plan:         { mode: 'plan' },
  'simple-fix': { mode: 'simple_fix' },
  fix:          { mode: 'fix' },
  investigate:  { mode: 'investigate' },
  verify:       { mode: 'verify' },
  implement:    { mode: 'implement' },
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

// Slug from prompt: first meaningful words, sanitized.
// Empty/punctuation-only prompts get a collision-resistant timestamp+random fallback.
function deriveSlug(prompt) {
  const base = (prompt || '').toString().trim().slice(0, 80).toLowerCase();
  const slug = base
    .replace(/[^a-z0-9가-힣\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
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

function seedWorkflowState(directory, commandName, prompt, sessionId, args = '', chainedModes = null) {
  const mode = COMMAND_TO_MODE[commandName];
  if (!mode) return; // cancel/queue/build — not a v2 workflow command

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
        if (modeCfg?.allowed_skills?.length) {
          machineState.allowed_skills = modeCfg.allowed_skills;
        }
        if (modeCfg?.default_exempt) {
          machineState.exempt = { ...machineState.exempt, ...modeCfg.default_exempt };
        }
        writeState(stateJsonPath, machineState);
        // active_task pointer consumed by critic-watchdog.readActiveState.
        writeAtomic(join(directory, '.smt', 'active_task'), stateJsonPath);
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

    // active-feature pointer (atomic)
    writeAtomic(pointerPath, JSON.stringify({ slug, session_id: sessionId || '', updated_at: Date.now() }, null, 2));
    if (sessionId) {
      writeAtomic(join(smtStateDir, `active-feature-${sessionId}.json`), JSON.stringify({ slug, session_id: sessionId, updated_at: Date.now() }, null, 2));
    }
  } catch {}
}

// Clear active-feature pointer — called on /cancel and /queue so the next
// UserPromptSubmit does not silently resume a cancelled/redirected feature.
function clearActiveFeature(directory) {
  try {
    const p = join(directory, '.smt', 'state', 'active-feature.json');
    if (existsSync(p)) unlinkSync(p);
  } catch {}
}

function activateHarnessState(directory, commandName, prompt, sessionId, args = '', chainedModes = null) {
  const config = COMMAND_CONFIG[commandName];
  if (!config) return;
  seedWorkflowState(directory, commandName, prompt, sessionId, args, chainedModes);
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
      detected = detectNaturalLanguageCommand(prompt);
      if (detected) {
        printTag(`Magic Keyword: Local classified command`);
      }
    }

    // (3) Haiku sub-agent classifier for remaining non-slash prompts
    if (!detected) {
      const classification = classifyPrompt(prompt, { cwd: directory, sessionId });
      if (classification.intent === 'command' && classification.command) {
        const validCommands = ['plan', 'build', 'fix', 'simple-fix', 'investigate', 'implement', 'verify', 'cancel', 'queue'];
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
      clearActiveFeature(directory);
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
    activateHarnessState(directory, detected.name, prompt, sessionId, detected.args || '', detected.chained_modes || null);
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

main();
