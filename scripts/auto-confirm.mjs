#!/usr/bin/env node
// auto-confirm.mjs — Smelter Stop hook (queue-drop pattern).
//
// See document/workflow.md section 11. Enforces Iron Law #1 (never halt).
//
// Architecture:
//   Stop event          → this script reads state.json, runs decide(),
//                         drops a payload into .smt/state/auto-confirm-queue.json,
//                         and emits a `block` decision so Claude Code keeps the
//                         session alive for the next UserPromptSubmit.
//   UserPromptSubmit    → auto-confirm-consumer.mjs picks up the queued payload
//                         and injects it as additionalContext on the next turn.
//
// The split exists because Stop hooks run under a strict time cap and cannot
// spawn sub-agents; we stash state on disk and let the UserPromptSubmit hook
// (which has access to additionalContext) do the injection.
//
// Halt (no block, no queue) allowed only in the 4 cases of section 11-4:
//   - explicit user stop / abort
//   - workflow-human-check awaiting user input
//   - mode upgrade awaiting user decision
//   - no active state.json
//
// Chained-intent auto-transition (mode-classifier + section 4-3 transition gate)
// is handled here: when state.chained_modes has at least 2 entries and the last
// assistant message signals a mode transition, advance the chain and queue a
// continuation prompt without asking the user.

import { existsSync, readFileSync, readdirSync, statSync, lstatSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readState, writeState, MODES } from './state-schema.mjs';
import { route } from './route-on-fail.mjs';
import { readCancel, clearCancel } from './lib/cancel-signal.mjs';
import { pickNextStage } from './stop-stage-enforcer.mjs';

// H3 — stuck-loop guard threshold. When decide() returns the same
// signature (slug:mode:stage:action) this many consecutive times, the CLI
// entry halts instead of queueing another identical continuation. Prevents
// auto-confirm from churning in lockstep with a non-advancing state.
export const AUTO_CONFIRM_STUCK_THRESHOLD = 3;
// Loop counter entries older than this are considered stale and reset on
// next bump, regardless of signature.
export const AUTO_CONFIRM_STUCK_MAX_AGE_MS = 30 * 60 * 1000;

export const QUEUE_FILENAME = 'auto-confirm-queue.json';
export const QUEUE_MAX_AGE_MS = 5 * 60 * 1000;

// Restrict sessionId to filename-safe characters so it can be embedded in the
// queue filename. Claude Code ships UUIDs, which pass as-is; anything weird
// falls through to the legacy shared path to preserve best-effort behavior.
export function sanitizeSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return '';
  return /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : '';
}

const RISK_KEYWORDS = [
  '리스크', '위험', '주의해야', '잠재적',
  'TODO', '나중에', '추후',
  '고려 필요', '검토 필요',
  '이상하지만', '임시로', '일단',
];

// Lightweight LLM classifier: decides whether the assistant's last message is
// asking permission to proceed (auto-confirm) or providing a final summary
// (halt). 100 % of the proceed-vs-halt judgement is delegated to this sub-agent
// — there is no regex fallback. If the sub-agent process fails (timeout, no
// binary, malformed output) the hook halts (the only safe default; halting
// breaks the infinite "no explicit signal, prompting to proceed" loop).

export function buildClassifierPrompt(lastMessage) {
  return `You are a binary classifier. Read the assistant's final message and output exactly one word.\n\n` +
    `Output \"continue\" if the message is explicitly asking the user for permission to proceed (any language). Examples: \"shall I proceed?\", \"진행할까요?\", \"ready to continue?\", \"次に進めますか？\".\n\n` +
    `Output \"halt\" otherwise (final answer, summary, completed report, error message, etc.).\n\n` +
    `Output exactly one of: continue OR halt. No punctuation. No other words.\n\n` +
    `Message:\n"""\n${lastMessage}\n"""`;
}

// Pick the model the lightweight classifier sub-agent should run with.
// Default = sonnet. Codex CLI environments use mini.
export function pickSubAgentModel() {
  if (process.env.CODEX_MODE === '1') return 'haiku';
  const cfg = readJson(join(homedir(), '.smt', 'config.json'));
  if (cfg && cfg.codexMode === true) return 'haiku';
  return 'sonnet';
}

// Resolve a runnable claude binary path. The user's shell wraps `claude` as a
// function (looking up ~/.local/share/claude/versions/* by mtime), but a
// subprocess does not see shell functions, so we re-implement the lookup.
function resolveClaudeBinary() {
  const versionsDir = join(homedir(), '.local', 'share', 'claude', 'versions');
  if (!existsSync(versionsDir)) return null;
  const versions = readdirSync(versionsDir);
  let best = null;
  let bestMtime = 0;
  for (const v of versions) {
    const p = join(versionsDir, v);
    try {
      const s = statSync(p);
      if (s.size > 0 && (s.mode & 0o111) && s.mtimeMs > bestMtime) {
        bestMtime = s.mtimeMs;
        best = p;
      }
    } catch {}
  }
  return best;
}

// Spawn the lightweight classifier sub-agent and return 'continue' or 'halt'.
// Tests inject a stub binary via SMT_CLASSIFIER_CMD env var.
export function classifyProceedPromptViaSubAgent(lastMessage, {
  model = 'sonnet',
  timeoutMs = 40000,
  cmd = process.env.SMT_CLASSIFIER_CMD,
} = {}) {
  if (!lastMessage || typeof lastMessage !== 'string') return 'halt';

  const binary = cmd || resolveClaudeBinary();
  if (!binary) return 'halt';

  const prompt = buildClassifierPrompt(lastMessage);
  const args = ['-p', prompt, '--model', model];

  let result;
  try {
    result = spawnSync(binary, args, {
      timeout: timeoutMs,
      encoding: 'utf-8',
      // SMT_CLASSIFIER=1 prevents the spawned claude session from re-firing
      // this Stop hook recursively (see CLI entry guard below).
      env: { ...process.env, SMT_CLASSIFIER: '1' },
    });
  } catch {
    return 'halt';
  }

  if (!result || result.status !== 0) return 'halt';
  const out = (result.stdout || '').trim().toLowerCase();
  // Accept exact "continue" or any line starting with continue (defensive
  // against trailing whitespace / punctuation).
  if (/^continue\b/.test(out)) return 'continue';
  return 'halt';
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

export function isEnabled() {
  const cfg = readJson(join(homedir(), '.smt', 'config.json'));
  return !cfg || cfg.autoConfirm !== false;
}

export function isSubTaskerOnRisk() {
  const cfg = readJson(join(homedir(), '.smt', 'config.json'));
  return !cfg || cfg.subTaskerOnRisk !== false;
}

// Find the state.json for the active task. Session-isolated: per-session
// pointer (`.smt/state/active-feature-<sessionId>.json`) is primary; non-scoped
// pointer (`.smt/state/active-feature.json`) is the session-less fallback
// (legacy CLI / sim). Global `.smt/active_task` was deprecated in the
// session-isolation migration — concurrent sessions would overwrite it. As a
// final resort, the most recently updated *.state.json under
// `.smt/features/*/task/` is returned (test-fixture convenience).
export function findActiveTaskState(cwd, sessionId) {
  const pointerPath = sessionId
    ? join(cwd, '.smt', 'state', `active-feature-${sessionId}.json`)
    : join(cwd, '.smt', 'state', 'active-feature.json');
  if (existsSync(pointerPath)) {
    try {
      const ptr = JSON.parse(readFileSync(pointerPath, 'utf-8'));
      if (ptr?.slug) {
        const candidate = join(cwd, '.smt', 'features', ptr.slug, 'task', `${ptr.slug}.state.json`);
        if (existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  const featuresRoot = join(cwd, '.smt', 'features');
  if (!existsSync(featuresRoot)) return null;
  let latest = null;
  let latestMtime = 0;
  for (const slug of readdirSync(featuresRoot)) {
    const taskDir = join(featuresRoot, slug, 'task');
    if (!existsSync(taskDir)) continue;
    for (const f of readdirSync(taskDir)) {
      if (!f.endsWith('.state.json')) continue;
      const full = join(taskDir, f);
      try {
        const mtime = statSync(full).mtimeMs;
        if (mtime > latestMtime) { latestMtime = mtime; latest = full; }
      } catch {}
    }
  }
  return latest;
}

// Detect a mode-transition signal in the assistant's last message.
// Returns one of: exact mode name, '*' for a generic gate signal, '' when none.
export function detectModeTransitionSignal(message) {
  if (!message || typeof message !== 'string') return '';
  const patterns = [
    /mode_transition_to_(simple_fix|fix|investigate|plan|implement)\b/i,
    /transition(?:ing)?\s+to\s+(simple_fix|fix|investigate|plan|implement)\s+mode/i,
    /switching\s+to\s+(simple_fix|fix|investigate|plan|implement)\s+mode/i,
    /(simple_fix|fix|investigate|plan|implement)\s+모드로\s*(?:전환|넘어)/i,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m && MODES.includes(m[1].toLowerCase())) return m[1].toLowerCase();
  }
  if (/ready\s+to\s+transition|mode\s+transition\s+gate|전환\s*가능/i.test(message)) {
    return '*';
  }
  return '';
}

// Consume the head of chained_modes and return the next mode to transition to.
// Returns '' when the chain is empty or has only one element.
// Mutates + persists the state atomically via writeState.
export function consumeNextChainedMode(path, state, requestedMode = '') {
  if (!state || !Array.isArray(state.chained_modes) || state.chained_modes.length <= 1) {
    return '';
  }
  const [, ...rest] = state.chained_modes;
  if (rest.length === 0) return '';
  let nextMode = rest[0];
  if (requestedMode && requestedMode !== '*') {
    if (!rest.includes(requestedMode)) return '';
    nextMode = requestedMode;
    const idx = rest.indexOf(requestedMode);
    state.chained_modes = rest.slice(idx);
  } else {
    state.chained_modes = rest;
  }
  state.mode = nextMode;
  try { writeState(path, state); } catch { return ''; }
  return nextMode;
}

export function buildChainedTransitionPrompt(nextMode, remaining) {
  const tail = remaining.length > 1 ? ` (remaining chain: ${remaining.slice(1).join(' -> ')})` : '';
  return `[AUTO-CONFIRM] Chained intent detected. Auto-transitioning to '${nextMode}' mode${tail}. Continue with the ${nextMode} workflow now.`;
}

// Decision tree per section 11-2. Returns { action, reason, payload }.
export function decide({ state, lastAssistantText, statePath }) {
  if (!state) return { action: 'no_state', reason: 'no active task state.json found' };

  // Chained-intent auto-transition must fire before human-check halt so a
  // compound request does not block on user prompting.
  const transitionSignal = detectModeTransitionSignal(lastAssistantText || '');
  if (transitionSignal && Array.isArray(state.chained_modes) && state.chained_modes.length > 1 && statePath) {
    const nextMode = consumeNextChainedMode(statePath, state, transitionSignal);
    if (nextMode) {
      return {
        action: 'chain_advance',
        reason: `chained intent → auto-transition to ${nextMode}`,
        payload: { nextMode, remaining: state.chained_modes },
      };
    }
  }

  // Halt conditions (section 11-4)
  if (state.current_stage === 'workflow-human-check') {
    const lastEvent = state.events[state.events.length - 1];
    if (!lastEvent || lastEvent.result !== 'pass') {
      return { action: 'halt', reason: 'awaiting user decision in workflow-human-check' };
    }
  }
  if (state._awaiting_mode_upgrade) {
    return { action: 'halt', reason: 'awaiting user mode upgrade decision' };
  }

  const events = state.events || [];
  const last = events[events.length - 1];

  if (state.current_stage === 'done') {
    return { action: 'session_wrap', reason: 'task complete, writing session log' };
  }

  if (isSubTaskerOnRisk() && lastAssistantText && detectRiskKeyword(lastAssistantText)) {
    return {
      action: 'spawn_sub_tasker',
      reason: 'risk keyword detected in assistant response',
      payload: { text: lastAssistantText },
    };
  }

  const unresolved = (state.active_feedback || []).find(f => !f.resolved);
  if (unresolved) {
    return {
      action: 'enter_skill',
      reason: 'unresolved active_feedback',
      payload: { skill: unresolved.target_skill, feedback_id: unresolved.id },
    };
  }

  if (last && last.result === 'fail') {
    const r = route({ event: last, state });
    if (r.reason === 'whitelist_violation') {
      return { action: 'request_mode_upgrade', reason: r.info, payload: r };
    }
    if (r.target) {
      return { action: 'enter_skill', reason: `producer chain: ${r.reason}`, payload: { skill: r.target } };
    }
  }

  if (last && last.result === 'pass') {
    // H2 — name the next skill explicitly instead of a vague "advance".
    // pickNextStage honors allowed_skills order + completed_stages so the
    // agent receives an unambiguous target instead of guessing from
    // conversation context.
    const skill = pickNextStage(state);
    return {
      action: 'advance',
      reason: `last event pass, advance to ${skill}`,
      payload: { skill },
    };
  }

  const hasRed = (state.test_cycles || []).some(c =>
    c.run_result === 'fail' && ['added_case', 'modified_case'].includes(c.action)
  );
  if (hasRed && state.current_stage !== 'workflow-coding' && state.allowed_skills.includes('workflow-coding')) {
    return { action: 'enter_skill', reason: 'RED cycle ready, enter workflow-coding', payload: { skill: 'workflow-coding' } };
  }

  // No state-machine signal matched. Hand the proceed-vs-halt decision to the
  // lightweight LLM classifier sub-agent. No regex fallback (per spec).
  return {
    action: 'classify_needed',
    reason: 'no state signal — classifier sub-agent will decide proceed vs halt',
    payload: { lastMessage: lastAssistantText || '' },
  };
}

export function detectRiskKeyword(text) {
  if (!text) return false;
  return RISK_KEYWORDS.some(k => text.includes(k));
}

export function buildPromptInjection(decision, state, { subAgentModel = 'sonnet' } = {}) {
  const lines = [];
  lines.push(`[auto-confirm] ${decision.reason}`);

  switch (decision.action) {
    case 'enter_skill':
      lines.push(`Enter next workflow skill: ${decision.payload.skill}`);
      if (decision.payload.feedback_id) lines.push(`Resolve feedback: ${decision.payload.feedback_id}`);
      lines.push(`Spawn the work via a sub-agent using model='${subAgentModel}'.`);
      break;
    case 'advance':
      if (decision.payload?.skill) {
        lines.push(`Previous skill passed. Enter next workflow skill: ${decision.payload.skill}`);
      } else {
        lines.push('Previous skill passed. Advance to the next skill per current mode.');
      }
      lines.push(`Spawn the work via a sub-agent using model='${subAgentModel}'.`);
      break;
    case 'chain_advance':
      lines.push(buildChainedTransitionPrompt(decision.payload.nextMode, decision.payload.remaining));
      lines.push(`Spawn the work via a sub-agent using model='${subAgentModel}'.`);
      break;
    case 'spawn_sub_tasker':
      lines.push('Risk language detected. Spawn sub-tasker to extract TODO into new task.');
      lines.push(`Sub-tasker model='${subAgentModel}'.`);
      break;
    case 'request_mode_upgrade':
      lines.push(`Mode upgrade required: ${decision.payload.suggested_upgrade_target}`);
      lines.push('Present user with upgrade options.');
      break;
    case 'session_wrap':
      lines.push('Task complete. Write session/YYYY-MM-DD.md log and terminate.');
      break;
    case 'continue':
      lines.push('Assistant asked permission to proceed. Auto-confirmed: yes, continue.');
      lines.push(`Spawn the next step via a sub-agent using model='${subAgentModel}'.`);
      break;
    case 'halt':
    case 'no_state':
      return null;
    default:
      lines.push('Continue the current workflow. Do not stop until user intervenes.');
  }

  if (state) {
    lines.push(`state: mode=${state.mode}, current=${state.current_stage || 'null'}, completed=${(state.completed_stages || []).length}`);
  }
  return lines.join('\n');
}

// H3 — stuck-loop guard helpers. Mirrors stop-stage-enforcer's counter but
// keyed on auto-confirm decisions (action-aware) so churn at this layer is
// detectable before Stop runs. Per-project + per-session to avoid collisions
// across concurrent sessions.

export function autoConfirmSignature(state, action) {
  if (!state) return `no-state:${action || 'null'}`;
  const slug = state.task_id || '?';
  const stage = state.current_stage || 'null';
  const mode = state.mode || '?';
  const act = action || 'null';
  return `${slug}:${mode}:${stage}:${act}`;
}

export function autoConfirmLoopCounterPath(cwd, sessionId = '') {
  const projectHash = createHash('md5').update(cwd).digest('hex').slice(0, 8);
  const sessHash = sessionId
    ? createHash('md5').update(String(sessionId)).digest('hex').slice(0, 8)
    : 'no-session';
  return `/tmp/smelter-auto-confirm-loop-${projectHash}-${sessHash}.json`;
}

export function bumpAutoConfirmLoop(cwd, sessionId, signature) {
  const path = autoConfirmLoopCounterPath(cwd, sessionId);
  // Symlink rejection — on a shared /tmp an adversary could pre-plant a
  // symlink at a predictable path to redirect writes. Session UUIDs make
  // pre-placement impractical, but lstat() keeps this defense-in-depth cheap.
  let prior = null;
  try {
    if (existsSync(path)) {
      // lstat first — statSync follows symlinks; we want to reject the link
      // itself, not its target.
      const lst = lstatSync(path);
      if (lst.isSymbolicLink() || !lst.isFile()) return 1;
      prior = JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {}
  const now = Date.now();
  const stale = prior && now - (prior.last_seen || 0) > AUTO_CONFIRM_STUCK_MAX_AGE_MS;
  if (!prior || stale || prior.signature !== signature) {
    const fresh = { signature, count: 1, first_seen: now, last_seen: now };
    try { writeFileSync(path, JSON.stringify(fresh), { mode: 0o600 }); } catch {}
    return 1;
  }
  const next = { ...prior, count: prior.count + 1, last_seen: now };
  try { writeFileSync(path, JSON.stringify(next), { mode: 0o600 }); } catch {}
  return next.count;
}

export function clearAutoConfirmLoop(cwd, sessionId = '') {
  try { unlinkSync(autoConfirmLoopCounterPath(cwd, sessionId)); } catch {}
}

// Queue-drop helpers. The queue file is a single JSON object — one entry at a
// time; a stale file older than QUEUE_MAX_AGE_MS is ignored/overwritten.

// Session-scoped when sessionId is present; falls back to the legacy shared
// filename only when sessionId is empty or not filename-safe. Parallel Claude
// sessions in the same project must each read/write their own file so one
// session does not consume another session's queued continuation payload.
export function queuePath(cwd, sessionId = '') {
  const safe = sanitizeSessionId(sessionId);
  const filename = safe ? `auto-confirm-queue-${safe}.json` : QUEUE_FILENAME;
  return join(cwd, '.smt', 'state', filename);
}

export function dropQueue(cwd, payload, sessionId = '') {
  const path = queuePath(cwd, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const entry = {
    t: new Date().toISOString(),
    session_id: sanitizeSessionId(sessionId) || null,
    ...payload,
  };
  writeFileSync(path, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
  return path;
}

// CLI entry (Stop hook): reads stdin JSON from Claude Code.
if (import.meta.url === `file://${process.argv[1]}`) {
  // Recursion guard: when the classifier sub-agent itself fires a Stop event,
  // bail out immediately so we don't spawn classifiers in a loop.
  if (process.env.SMT_CLASSIFIER === '1') process.exit(0);

  if (!isEnabled()) { process.exit(0); }
  const stdin = readFileSync('/dev/stdin', 'utf-8');
  let input = {};
  try { input = JSON.parse(stdin); } catch {}
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || '';
  const statePath = findActiveTaskState(cwd, sessionId);
  const state = statePath ? readState(statePath) : null;
  const lastAssistantText = input.last_assistant_text || '';
  const subAgentModel = pickSubAgentModel();

  // Queue-signal check (highest priority): if /queue dropped a cancel-signal.json
  // with a queued_intent, inject it now and skip both classifier + state-machine
  // decisions. Consume the signal so it fires only once.
  const queueSignal = readCancel(cwd, sessionId);
  if (queueSignal && queueSignal.type === 'queue' && queueSignal.queued_intent) {
    const injection = `[auto-confirm] queued intent → ${queueSignal.queued_intent}\nSpawn the work via a sub-agent using model='${subAgentModel}'.`;
    try {
      dropQueue(cwd, {
        reason: 'queue-signal consumed',
        action: 'continue',
        additionalContext: injection,
        sub_agent_model: subAgentModel,
        state_path: statePath,
        queued_intent: queueSignal.queued_intent,
      }, sessionId);
    } catch {}
    clearCancel(cwd);
    console.log(JSON.stringify({
      decision: 'block',
      reason: 'queue-signal consumed',
      meta: { queued: true, source: 'cancel-signal', sub_agent_model: subAgentModel },
    }));
    process.exit(2);
  }

  let decision = decide({ state, lastAssistantText, statePath });

  // 'classify_needed' resolves via the lightweight LLM classifier sub-agent.
  // Per spec there is no regex fallback — sub-agent decision is final, and a
  // sub-agent failure halts (safe default that breaks the prior infinite loop).
  if (decision.action === 'classify_needed') {
    const verdict = classifyProceedPromptViaSubAgent(decision.payload.lastMessage, { model: subAgentModel });
    if (verdict === 'continue') {
      decision = { action: 'continue', reason: `classifier sub-agent (${subAgentModel}) → continue` };
    } else {
      decision = { action: 'halt', reason: `classifier sub-agent (${subAgentModel}) → halt` };
    }
  }

  const injection = buildPromptInjection(decision, state, { subAgentModel });

  // 'session_wrap' is terminal — current_stage is already 'done'. Re-injecting
  // "write session log" on every Stop creates an infinite loop because the
  // state never changes again. Treat it as a halt so the session ends cleanly.
  if (decision.action === 'halt' || decision.action === 'no_state' || decision.action === 'session_wrap') {
    clearAutoConfirmLoop(cwd, sessionId);
    process.exit(0);
  }

  // H3 — stuck-loop guard. If decide() keeps returning an identical signature
  // with no state progression, halt with a stderr warning so the agent and
  // user can escape. Stop-enforcer has its own guard; this one fires earlier
  // and covers action-specific churn (e.g., same enter_skill queued repeatedly).
  const signature = autoConfirmSignature(state, decision.action);
  const loopCount = bumpAutoConfirmLoop(cwd, sessionId, signature);
  if (loopCount >= AUTO_CONFIRM_STUCK_THRESHOLD) {
    clearAutoConfirmLoop(cwd, sessionId);
    process.stderr.write(
      `\x1b[33m[smelter] auto-confirm · stuck-loop escape ` +
      `(signature=${signature}, fired ${loopCount}x)\x1b[0m\n`,
    );
    process.exit(0);
  }

  try {
    dropQueue(cwd, {
      reason: decision.reason,
      action: decision.action,
      additionalContext: injection,
      sub_agent_model: subAgentModel,
      state_path: statePath,
    }, sessionId);
  } catch {
    // Never fail the Stop hook just because disk write failed.
  }

  const output = {
    decision: 'block',
    reason: decision.reason,
    meta: { queued: true, state_path: statePath, sub_agent_model: subAgentModel },
  };
  console.log(JSON.stringify(output));
  process.exit(2);
}
