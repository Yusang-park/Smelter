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

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readState, writeState, MODES } from './state-schema.mjs';
import { route } from './route-on-fail.mjs';

export const QUEUE_FILENAME = 'auto-confirm-queue.json';
export const QUEUE_MAX_AGE_MS = 5 * 60 * 1000;

const RISK_KEYWORDS = [
  '리스크', '위험', '주의해야', '잠재적',
  'TODO', '나중에', '추후',
  '고려 필요', '검토 필요',
  '이상하지만', '임시로', '일단',
];

// Patterns where the assistant is explicitly asking permission to proceed.
// When these match, the Stop hook auto-confirms ("yes, proceed") instead of
// halting. When they DO NOT match in the fallback branch, the hook halts to
// avoid the infinite "no explicit signal, prompting to proceed" loop.
const PROCEED_PROMPT_PATTERNS = [
  // Korean
  /진행\s*할까요/, /계속\s*할까요/, /진행해도\s*(될까요|괜찮을까요)/,
  /다음\s*(단계|스텝)로\s*(갈까요|넘어갈까요|진행할까요)/,
  /시작\s*할까요/, /(이대로|그대로)\s*진행/,
  // English
  /shall\s+i\s+(proceed|continue|go\s+ahead|move\s+on)/i,
  /should\s+i\s+(proceed|continue|go\s+ahead|move\s+on)/i,
  /ready\s+to\s+(proceed|continue|move\s+on)/i,
  /ok\s+to\s+(proceed|continue)/i,
  /may\s+i\s+(proceed|continue|go\s+ahead)/i,
  /\bproceed\?\s*$/i, /\bcontinue\?\s*$/i,
];

export function detectProceedPrompt(text) {
  if (!text || typeof text !== 'string') return false;
  return PROCEED_PROMPT_PATTERNS.some(p => p.test(text));
}

// Pick the model the next-turn agent should use when spawning a sub-agent.
// Default = sonnet. Codex CLI environments use the smaller mini.
export function pickSubAgentModel() {
  if (process.env.CODEX_MODE === '1') return 'haiku';
  const cfg = readJson(join(homedir(), '.smt', 'config.json'));
  if (cfg && cfg.codexMode === true) return 'haiku';
  return 'sonnet';
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

// Find the state.json for the active task. Prefer .smt/active_task pointer,
// else the most recently updated *.state.json under .smt/features/*/task/.
export function findActiveTaskState(cwd) {
  const active = join(cwd, '.smt', 'active_task');
  if (existsSync(active)) {
    try {
      const target = readFileSync(active, 'utf-8').trim();
      if (existsSync(target)) return target;
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
    return { action: 'advance', reason: 'last event pass, advance to next workflow skill', payload: {} };
  }

  const hasRed = (state.test_cycles || []).some(c =>
    c.run_result === 'fail' && ['added_case', 'modified_case'].includes(c.action)
  );
  if (hasRed && state.current_stage !== 'workflow-coding' && state.allowed_skills.includes('workflow-coding')) {
    return { action: 'enter_skill', reason: 'RED cycle ready, enter workflow-coding', payload: { skill: 'workflow-coding' } };
  }

  if (detectProceedPrompt(lastAssistantText)) {
    return { action: 'continue', reason: 'assistant asked permission to proceed — auto-confirming' };
  }

  return { action: 'halt', reason: 'no explicit signal and no proceed prompt — halting to avoid loop' };
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
      lines.push('Previous skill passed. Advance to the next skill per current mode.');
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

// Queue-drop helpers. The queue file is a single JSON object — one entry at a
// time; a stale file older than QUEUE_MAX_AGE_MS is ignored/overwritten.

export function queuePath(cwd) {
  return join(cwd, '.smt', 'state', QUEUE_FILENAME);
}

export function dropQueue(cwd, payload) {
  const path = queuePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const entry = {
    t: new Date().toISOString(),
    ...payload,
  };
  writeFileSync(path, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
  return path;
}

// CLI entry (Stop hook): reads stdin JSON from Claude Code.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!isEnabled()) { process.exit(0); }
  const stdin = readFileSync('/dev/stdin', 'utf-8');
  let input = {};
  try { input = JSON.parse(stdin); } catch {}
  const cwd = input.cwd || process.cwd();
  const statePath = findActiveTaskState(cwd);
  const state = statePath ? readState(statePath) : null;
  const lastAssistantText = input.last_assistant_text || '';
  const decision = decide({ state, lastAssistantText, statePath });
  const subAgentModel = pickSubAgentModel();
  const injection = buildPromptInjection(decision, state, { subAgentModel });

  if (decision.action === 'halt' || decision.action === 'no_state') {
    process.exit(0);
  }

  try {
    dropQueue(cwd, {
      reason: decision.reason,
      action: decision.action,
      additionalContext: injection,
      sub_agent_model: subAgentModel,
      state_path: statePath,
    });
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
