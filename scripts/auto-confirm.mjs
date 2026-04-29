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
import { SKILL_ARTIFACT_BASENAME } from './state-validator.mjs';
import { readLastAssistantText, lastAssistantQuestionShape, classifyQuestionShape } from './lib/transcript-reader.mjs';
import { inspectClassifierModel } from './lib/subagent-classifier.mjs';
import { nextV4Transition } from './lib/workflow-v4-controller.mjs';
import { transitionV4State } from './lib/workflow-v4-state.mjs';
import { resolveHookSessionId } from './lib/session-paths.mjs';
import { applyTransitionAdoption, retargetStateForMode } from './lib/workflow-transition-adoption.mjs';

// Question shapes that mark the assistant as actively soliciting a user
// reply. When the last message matches any of these, the spawn_sub_tasker
// branch is skipped — `detectRiskKeyword` substring matches would
// otherwise split a legitimate interactive discussion into a fictional
// follow-up task. Shape classification is conservative: bare trailing
// `?` is not enough; a supporting bullet / option structure is required
// (see classifyQuestionShape).
const INTERACTIVE_QUESTION_SHAPES = new Set(['multi_choice', 'yes_no', 'open_question']);

// H3 — stuck-loop guard threshold. When decide() returns the same
// signature (slug:mode:stage:action) this many consecutive times, the CLI
// entry halts instead of queueing another identical continuation. Prevents
// auto-confirm from churning in lockstep with a non-advancing state.
export const AUTO_CONFIRM_STUCK_THRESHOLD = 2;
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
  return `You classify whether Claude should continue automatically after a stop hook.\n\n` +
    `Return EXACTLY one line of JSON and nothing else:\n` +
    `{"action":"continue"|"halt","reason":"<short reason>"}\n\n` +
    `Choose action=continue when the assistant:\n` +
    `  - explicitly asks permission to proceed, OR\n` +
    `  - offers immediate next work (even conditionally), OR\n` +
    `  - names a concrete next step / file / command to run next, OR\n` +
    `  - uses conditional-offer phrasing: "원하면", "원하시면", "하시려면", "말씀해 주시면", "if you want", "if desired", "let me know if", "want me to", "shall I", "바로 ~한다", "다음 작업", "next:", "계속하려면", OR\n` +
    `  - uses question-offer phrasing with a single clear answer: "만들까요", "할까요", "수정할까요", "이어갈까요", "지금 실행", "지금 실행?", "여전히 지금 실행", "바로 실행할까요", "진행할까요", "proceed now?", "run it now?", "execute?", OR\n` +
    `  - describes remaining work: "남은 건 / 남은 작업은 / 이것도 마찬가지 / what remains / still need to / only X left / just need to".\n\n` +
    `HARD RULE: If the message names a concrete next step, return continue. A rhetorical question like "만들까요?" / "shall I?" with only one obvious answer is NOT a branching choice — return continue.\n\n` +
    `BRANCHING-CHOICE RULE: If the message presents the user with multiple options ("A/B", "어느 쪽", "which should I do", numbered alternatives, "원하시면 ... 또는 ..."), STILL return continue. The downstream injection will instruct the agent to pick the highest-confidence option and execute autonomously without re-asking the user. A/B choice is NOT a halt condition — only truly external blockers are.\n\n` +
    `Choose action=halt ONLY when the message is BOTH (a) a terminal final answer / completed report / pure summary with no forward-looking proposal, AND (b) genuinely blocked on external info that no reasoning could resolve: credentials/secrets, irreversible-destructive confirmation already imminent, or a requirement so ambiguous that ANY pick would be a guess.\n\n` +
    `When in doubt between continue and halt, pick continue.\n\n` +
    `Message:\n"""\n${lastMessage}\n"""`;
}

// Pick the model the lightweight classifier sub-agent should run with.
// Unified with scripts/lib/subagent-classifier.mjs so Codex windows use a
// Codex-family mini model and Claude windows use haiku.
export function pickSubAgentModel() {
  if (process.env.CODEX_MODE === '1') return 'gpt-5.4-mini';
  if (process.env.SMELTER_MODEL_MODE === 'codex') return 'gpt-5.4-mini';
  return inspectClassifierModel('');
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

// Spawn the lightweight classifier sub-agent and return
// { action: 'continue'|'halt', reason: string }.
// Tests inject a stub binary via SMT_CLASSIFIER_CMD env var.
export function classifyProceedPromptViaSubAgent(lastMessage, {
  model = 'haiku',
  timeoutMs = 40000,
  cmd = process.env.SMT_CLASSIFIER_CMD,
} = {}) {
  if (!lastMessage || typeof lastMessage !== 'string') return { action: 'halt', reason: 'empty_message' };

  const binary = cmd || resolveClaudeBinary();
  if (!binary) return { action: 'halt', reason: 'missing_binary' };

  const prompt = buildClassifierPrompt(lastMessage);
  const args = ['-p', prompt, '--model', model];

  let result;
  try {
    result = spawnSync(binary, args, {
      timeout: timeoutMs,
      encoding: 'utf-8',
      env: { ...process.env, SMT_CLASSIFIER: '1', SMELTER_CLASSIFIER_SUBPROCESS: '1' },
    });
  } catch {
    return { action: 'halt', reason: 'spawn_error' };
  }

  if (!result || result.status !== 0) return { action: 'halt', reason: 'nonzero_exit' };
  const raw = (result.stdout || '').trim();
  if (!raw) return { action: 'halt', reason: 'empty_output' };
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.action === 'continue' || parsed?.action === 'halt') {
        return {
          action: parsed.action,
          reason: typeof parsed?.reason === 'string' && parsed.reason ? parsed.reason : 'no_reason',
        };
      }
    } catch {}
  }
  return { action: 'halt', reason: 'invalid_output' };
}

// Build the stage-completion classifier prompt. The classifier judges whether
// the main agent's last assistant message indicates that the current workflow
// stage is finished. Output is a JSON line with verdict + one-line summary.
export function buildStageCompletionPrompt({ lastMessage, currentStage, mode }) {
  return `You are a workflow stage completion judge for the Smelter engine.\n\n` +
    `Context:\n- mode: ${mode}\n- current_stage: ${currentStage}\n\n` +
    `Read the assistant's final message below and decide whether the work for the CURRENT stage is finished.\n\n` +
    `"Finished" means the stage's canonical output (findings for workflow-investigate, task list for workflow-tasker, etc.) is substantively present in the message. Conversational acknowledgements ("OK I will investigate") do NOT count as finished.\n\n` +
    `Exception: if the message explicitly acknowledges that the USER selected a next workflow step ` +
    `(examples: "User selected /fix", "사용자가 /fix 선택", "review passed — proceeding to next", ` +
    `"investigation done, user chose /fix", "consensus reached on this review", "all rounds ok"), ` +
    `return {"verdict":"complete","summary":"user-selected transition"} even if the canonical artifact path ` +
    `is discussed separately. ` +
    `Do NOT apply this exception to: ` +
    `(a) agent-speculation phrases like "I think we should go to /fix" or "we may need /fix next"; ` +
    `(b) investigation-complete statements without explicit user selection, e.g. "조사 완료" or "investigation done" alone; ` +
    `(c) "/fix" appearing as a file path token (e.g. "fix/auth.ts"). ` +
    `The exception requires the USER to have explicitly selected the next step.\n\n` +
    `Output EXACTLY one line of JSON, no prose around it:\n` +
    `{"verdict":"complete","summary":"<one-line summary of what the stage produced>"}\n` +
    `OR\n` +
    `{"verdict":"incomplete","summary":"<one-line reason the stage is not yet done>"}\n\n` +
    `Message:\n"""\n${lastMessage}\n"""`;
}

// Spawn the stage-completion classifier sub-agent. Distinct from the
// proceed/halt classifier so the two judgements can run independently.
// Returns { verdict: 'complete'|'incomplete'|'unknown', summary: string }.
// Tests inject a stub via `cmd` option.
export function classifyStageCompletionViaSubAgent({
  lastMessage, currentStage, mode,
  model = 'sonnet',
  timeoutMs = 40000,
  cmd = process.env.SMT_STAGE_CLASSIFIER_CMD || process.env.SMT_CLASSIFIER_CMD,
} = {}) {
  if (!lastMessage || typeof lastMessage !== 'string') return { verdict: 'unknown', summary: '' };
  if (!currentStage || typeof currentStage !== 'string') return { verdict: 'unknown', summary: '' };

  const binary = cmd || resolveClaudeBinary();
  if (!binary) return { verdict: 'unknown', summary: '' };

  const prompt = buildStageCompletionPrompt({ lastMessage, currentStage, mode });
  const args = ['-p', prompt, '--model', model];

  let result;
  try {
    result = spawnSync(binary, args, {
      timeout: timeoutMs,
      encoding: 'utf-8',
      env: { ...process.env, SMT_CLASSIFIER: '1', SMELTER_CLASSIFIER_SUBPROCESS: '1' },
    });
  } catch {
    return { verdict: 'unknown', summary: '' };
  }

  if (!result || result.status !== 0) return { verdict: 'unknown', summary: '' };

  const raw = (result.stdout || '').trim();
  if (!raw) return { verdict: 'unknown', summary: '' };

  // Scan stdout for the first JSON line containing `verdict`.
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const verdict = parsed?.verdict;
      if (verdict === 'complete' || verdict === 'incomplete') {
        return {
          verdict,
          summary: typeof parsed?.summary === 'string' ? parsed.summary : '',
        };
      }
    } catch { /* keep scanning */ }
  }
  return { verdict: 'unknown', summary: '' };
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
  // Session-isolation guard: when sessionId is provided but its per-session
  // pointer is absent, treat state as absent. Any mtime-based fallback would
  // bleed another session's feature into this one, causing the stage
  // classifier to issue "advance to X" loops on unrelated work.
  if (sessionId) return null;
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
  // Staleness guard: without a session pointer, a stale state.json from a
  // prior workflow run would otherwise bleed into an unrelated casual chat
  // session and force workflow directives. Require the fallback state.json
  // to be recent (edited within the last hour) to count as "active".
  if (latest && Date.now() - latestMtime > ACTIVE_STATE_MAX_AGE_MS) return null;
  return latest;
}

// A task state.json older than this, when discovered only via mtime fallback
// (no session pointer), is treated as stale and ignored. One hour is long
// enough to survive a lunch break but short enough that a week-old abandoned
// workflow does not inject directives into today's casual chat.
export const ACTIVE_STATE_MAX_AGE_MS = 60 * 60 * 1000;

// Detect a mode-transition signal in the assistant's last message.
// Returns one of: exact mode name, '*' for a generic gate signal, '' when none.
export function detectModeTransitionSignal(message) {
  if (!message || typeof message !== 'string') return '';
  const patterns = [
    /mode_transition_to_(brainstorm|fix|explore|implement|verify)\b/i,
    /transition(?:ing)?\s+to\s+(brainstorm|fix|explore|implement|verify)\s+mode/i,
    /switching\s+to\s+(brainstorm|fix|explore|implement|verify)\s+mode/i,
    /(brainstorm|fix|explore|implement|verify)\s+모드로\s*(?:전환|넘어)/i,
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
  const sourceState = JSON.parse(JSON.stringify(state));
  retargetStateForMode(state, nextMode);
  applyTransitionAdoption({
    sourceState,
    sourceStatePath: path,
    targetState: state,
    targetStatePath: path,
    toMode: nextMode,
  });
  try { writeState(path, state); } catch { return ''; }
  return nextMode;
}

export function buildChainedTransitionPrompt(nextMode, remaining) {
  const tail = remaining.length > 1 ? ` (remaining chain: ${remaining.slice(1).join(' -> ')})` : '';
  return `[AUTO-CONFIRM] Chained intent detected. Auto-transitioning to '${nextMode}' mode${tail}. Continue with the ${nextMode} workflow now.`;
}

// Canonical artifact path for a given stage (per state-validator rules).
// Returns { basename, absPath } when the stage has an expected artifact;
// null when the stage has no canonical artifact (coding, write-test, e2e,
// reviews, human-check — completion is gated on other signals).
export function canonicalArtifactPath(statePath, stage) {
  const basename = SKILL_ARTIFACT_BASENAME[stage];
  if (!basename) return null;
  const absPath = join(dirname(statePath), basename);
  return { basename, absPath };
}

// Fix A — prose-completion pass-event writer.
// Called from main() when decide() returns { action: 'stage_complete' }.
// Writes a { result: 'pass', declarer: 'hook' } entry to state.events[] for the
// current stage, persisting via writeState. Does NOT advance completed_stages
// (validateEvidenceIntegrity at state-validator.mjs:61 early-returns only when
// completed_stages is empty; a prose-completion event lacks evidence.path and
// would trip per-stage validation if completed_stages were advanced).
//
// Idempotent via alreadyHasPass; blocked by alreadyHasFail (a prior fail is
// terminal for the session — no recovery path in this fix).
export function applyProseCompletionPass(state, statePath) {
  if (!state || !statePath) return;
  const stage = state.current_stage;
  if (!stage || typeof stage !== 'string') return;
  const events = Array.isArray(state.events) ? state.events : [];
  const alreadyHasPass = events.some(e => e && e.skill === stage && e.result === 'pass');
  const alreadyHasFail = events.some(e => e && e.skill === stage && e.result === 'fail');
  if (alreadyHasPass || alreadyHasFail) return;
  if (!Array.isArray(state.events)) state.events = [];
  state.events.push({
    t: new Date().toISOString(),
    skill: stage,
    result: 'pass',
    declarer: 'hook',
  });
  try {
    writeState(statePath, state);
  } catch {
    process.stderr.write(`\x1b[33m[smelter] auto-confirm · Fix A writeState failed for ${stage}\x1b[0m\n`);
  }
}

const ARTIFACT_COMPLETION_DEFERRED_SKILLS = new Set([
  'workflow-e2e-review',
  'workflow-agent-review',
  'workflow-team-code-review',
  'workflow-human-check',
]);

// Artifact-backed completion backfill.
// Covers the common hook ordering where Skill(PostToolUse) enters a stage
// before the agent writes that stage's canonical artifact. On Stop, the file is
// now present, but no later Skill hook will run unless we record the event here.
export function applyArtifactCompletionEvent(state, statePath) {
  if (!state || !statePath) return false;
  const stage = state.current_stage;
  if (!stage || typeof stage !== 'string') return false;
  const artifact = canonicalArtifactPath(statePath, stage);
  if (!artifact) return false;
  try {
    if (!existsSync(artifact.absPath)) return false;
    const st = statSync(artifact.absPath);
    if (!st.isFile() || st.size === 0) return false;
  } catch {
    return false;
  }

  const events = Array.isArray(state.events) ? state.events : [];
  const alreadySettled = events.some(e => e && e.skill === stage && (e.result === 'pass' || e.result === 'fail'));
  if (alreadySettled) return false;

  const beforeEvents = Array.isArray(state.events) ? [...state.events] : state.events;
  const beforeCompleted = Array.isArray(state.completed_stages) ? [...state.completed_stages] : state.completed_stages;

  let result = 'pass';
  let cause = null;
  if (/-review$/.test(stage)) {
    try {
      const verdict = detectReviewVerdict(readFileSync(artifact.absPath, 'utf-8'));
      if (verdict === 'fail') {
        result = 'fail';
        cause = detectReviewFailCause(readFileSync(artifact.absPath, 'utf-8')) || 'review_reject';
      }
    } catch {
      return false;
    }
  }

  if (!Array.isArray(state.events)) state.events = [];
  const event = {
    t: new Date().toISOString(),
    skill: stage,
    result,
    declarer: 'hook',
    evidence: { type: 'file_present', path: artifact.absPath },
  };
  if (cause) event.cause = cause;
  state.events.push(event);

  if (result === 'pass' && !ARTIFACT_COMPLETION_DEFERRED_SKILLS.has(stage)) {
    if (!Array.isArray(state.completed_stages)) state.completed_stages = [];
    if (!state.completed_stages.includes(stage)) state.completed_stages.push(stage);
  }

  try {
    writeState(statePath, state);
    return true;
  } catch {
    if (beforeEvents === undefined) delete state.events;
    else state.events = beforeEvents;
    if (beforeCompleted === undefined) delete state.completed_stages;
    else state.completed_stages = beforeCompleted;
    process.stderr.write(`\x1b[33m[smelter] auto-confirm · artifact completion writeState failed for ${stage}\x1b[0m\n`);
    return false;
  }
}

// Stage-completion detection gate: run the classifier only when
//   - current_stage is set,
//   - a lastAssistantText is available,
//   - no pass event exists for the current_stage yet (otherwise the state
//     machine has already observed completion).
// Returning false here short-circuits decide() to its legacy paths.
export function shouldRunStageCompletionClassifier(state, lastAssistantText) {
  if (!state) return false;
  if (!lastAssistantText || typeof lastAssistantText !== 'string') return false;
  if (lastAssistantText.length < 20) return false;
  const stage = state.current_stage;
  if (!stage || typeof stage !== 'string') return false;
  const events = Array.isArray(state.events) ? state.events : [];
  const alreadyPassed = events.some(e => e && e.skill === stage && e.result === 'pass');
  return !alreadyPassed;
}

export function detectPlainHumanCheckMenu(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return false;
  const hasAllLabels = ['complete', 'rework', 'hold', 'upgrade'].every((label) => s.includes(label));
  if (!hasAllLabels) return false;
  const looksLikeQuestion = /decide|choose|select|선택|결정|\?/.test(s);
  const mentionsNativeTool = /askuserquestion|toolsearch\(\s*['"]select:askuserquestion/i.test(String(text || ''));
  return looksLikeQuestion && !mentionsNativeTool;
}

export function detectPhaseBlockedQuestion(text) {
  return /(?:blocked by current phase|current phase|requires phase|source edit requires EXECUTE|phase skip blocked)/i.test(String(text || '')) && /\?/.test(String(text || ''));
}

function applyV4ControllerTransition(state, statePath, event) {
  if (!state || typeof state.task_type !== 'string' || typeof state.step !== 'string') return null;
  const transition = nextV4Transition(state, event);
  if (!transition?.step || transition.step === state.step) return transition;
  transitionV4State(state, transition.step);
  if (statePath) {
    try {
      writeState(statePath, state);
    } catch (err) {
      process.stderr.write(`\x1b[33m[smelter] auto-confirm · v0.4 transition write failed: ${err.message}\x1b[0m\n`);
    }
  }
  return transition;
}

// Decision tree per section 11-2. Returns { action, reason, payload }.
//
// `questionShape` (optional) is the classification of the assistant's last
// message from lastAssistantQuestionShape() — when it falls inside
// INTERACTIVE_QUESTION_SHAPES, the spawn_sub_tasker branch is suppressed
// so that a legitimate user-directed question whose prose happens to
// contain a risk keyword (e.g. Korean "위험") does not get rerouted into
// a fictional follow-up task. The shape gate is placed STRICTLY after
// the halt conditions (workflow-human-check / _awaiting_mode_upgrade /
  // explore-review) so those pauses remain authoritative.
export function decide({ state, lastAssistantText, statePath, stageClassifier, questionShape }) {
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
  // Fix B: scope the halt clearance to a pass event actually produced by
  // workflow-human-check itself. A pass event from any prior skill (e.g.
  // workflow-tasker-review) used to satisfy the lastEvent check and cause
  // the Stop-hook loop advance-to-workflow-write-test (see investigation
  // 2026-04-21). `Array.isArray` guards normalize undefined/malformed
  // state files, and `legacyCompleted` preserves progression for pre-Fix-B
  // states whose completed_stages already records workflow-human-check.
  //
  // On terminal approval (humanCheckPassed || legacyCompleted), short-circuit
  // to session_wrap so a genuine human-check approval does not fall through
  // to the generic `last.result === 'pass'` advance branch below. Without
  // this, pickNextStage() would re-enter the chain at the first uncompleted
  // skill after a completed approval.
  if (state.current_stage === 'workflow-human-check') {
    const events = Array.isArray(state.events) ? state.events : [];
    const completed = Array.isArray(state.completed_stages) ? state.completed_stages : [];
    const humanCheckPassed = events.some(
      e => e && e.skill === 'workflow-human-check' && e.result === 'pass'
    );
    const legacyCompleted = completed.includes('workflow-human-check');
    if (!humanCheckPassed && !legacyCompleted) {
      if (detectPlainHumanCheckMenu(lastAssistantText)) {
        return {
          action: 'enter_skill',
          reason: 'workflow-human-check rendered a plain-text decision menu; re-enter and use native AskUserQuestion.',
          payload: { skill: 'workflow-human-check', direction: 'enter', forceNativeDecision: true },
        };
      }
      return { action: 'halt', reason: 'awaiting user decision in workflow-human-check' };
    }
    applyV4ControllerTransition(state, statePath, { type: 'human_pass' });
    return { action: 'session_wrap', reason: 'workflow-human-check approved, writing session log' };
  }
  if (state._awaiting_mode_upgrade) {
    return { action: 'halt', reason: 'awaiting user mode upgrade decision' };
  }

  const hasAnyEvent = Array.isArray(state.events) && state.events.length > 0;
  if (!state.current_stage && !hasAnyEvent && Array.isArray(state.allowed_skills) && state.allowed_skills.length > 0) {
    const skill = pickNextStage(state);
    return {
      action: 'enter_skill',
      reason: `continue: active workflow has not entered its first stage. Enter ${skill} before any user-facing confirmation or side effect.`,
      payload: { skill, direction: 'enter' },
    };
  }
  const hasAnyProgress = hasAnyEvent ||
    (Array.isArray(state.completed_stages) && state.completed_stages.length > 0) ||
    (Array.isArray(state.test_cycles) && state.test_cycles.length > 0) ||
    (Array.isArray(state.active_feedback) && state.active_feedback.length > 0);
  if (state.current_stage && !hasAnyProgress && Array.isArray(state.allowed_skills) && state.allowed_skills.includes(state.current_stage) && INTERACTIVE_QUESTION_SHAPES.has(questionShape)) {
    return {
      action: 'enter_skill',
      reason: `continue: seeded workflow asked for confirmation before entering ${state.current_stage}. Enter the Skill before user-facing confirmation or side effects.`,
      payload: { skill: state.current_stage, direction: 'enter' },
    };
  }

  applyArtifactCompletionEvent(state, statePath);

  const events = state.events || [];
  const last = events[events.length - 1];
  if (state.mode === 'explore' && state.current_stage === 'workflow-investigate-review' && last?.result === 'pass') {
    return { action: 'halt', reason: 'explore mode user decision required after workflow-investigate-review pass' };
  }

  if (isSubTaskerOnRisk() && lastAssistantText && detectRiskKeyword(lastAssistantText)
      && !INTERACTIVE_QUESTION_SHAPES.has(questionShape)) {
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
      reason: `continue: unresolved feedback '${unresolved.id}' for ${unresolved.target_skill}. Invoke that Skill and resolve it.`,
      payload: { skill: unresolved.target_skill, feedback_id: unresolved.id },
    };
  }

  if (INTERACTIVE_QUESTION_SHAPES.has(questionShape) && detectPhaseBlockedQuestion(lastAssistantText)) {
    const allowed = Array.isArray(state.allowed_skills) ? state.allowed_skills : [];
    const skill = allowed.includes('workflow-coding') ? 'workflow-coding' : state.current_stage;
    if (skill) {
      return {
        action: 'enter_skill',
        reason: `continue: phase-blocked work must re-enter ${skill}, not ask the user how to proceed.`,
        payload: { skill, direction: skill === 'workflow-coding' ? 'back' : 'enter' },
      };
    }
  }

  if (last && last.result === 'fail') {
    if (state.step === 'VERIFY') {
      applyV4ControllerTransition(state, statePath, { type: 'verify_fail', signal: last.cause || '' });
    }
    const r = route({ event: last, state });
    if (r.reason === 'whitelist_violation') {
      return { action: 'request_mode_upgrade', reason: r.info, payload: r };
    }
    if (r.target) {
      // Producer-chain → direction 'back' because the chain routes to the
      // upstream skill that owns the defect.
      return { action: 'enter_skill', reason: `continue: route back to upstream producer ${r.target}. Cause: ${r.reason}`, payload: { skill: r.target, direction: 'back' } };
    }
  }

  // Fix A companion — the advance branch only fires when EITHER
  //   (a) the last event's skill matches current_stage (normal PostToolUse path), OR
  //   (b) current_stage has a prior fail event (producer-chain recovery — e.g.
  //       workflow-coding failed with scope_mismatch, routed to workflow-tasker,
  //       which passed → advance resumes at coding/next).
  // Without this guard, Fix A's hook-written pass for the prior stage would
  // trigger pickNextStage and skip the current stage entirely.
  const currentStageHasFail = events.some(e => e && e.skill === state.current_stage && e.result === 'fail');
  if (last && last.result === 'pass' && (last.skill === (state.current_stage || '') || currentStageHasFail)) {
    applyV4ControllerTransition(state, statePath, { type: 'stage_pass' });
    // H2 — name the next skill explicitly instead of a vague "advance".
    // pickNextStage honors allowed_skills order + completed_stages so the
    // agent receives an unambiguous target instead of guessing from
    // conversation context.
    //
    // Fresh-snapshot note: `state` here is the pre-transition snapshot read
    // at Stop entry (main() loads it once before calling decide). That is
    // the intended semantics — PostToolUse:Skill for this very turn has
    // already persisted the pass event and bumped completed_stages, so
    // pickNextStage sees the correct post-pass view of the chain.
    const skill = pickNextStage(state);
    return {
      action: 'advance',
      reason: `continue: previous stage passed. Next stage ${skill}.`,
      payload: { skill, direction: 'advance' },
    };
  }

  const hasRed = (state.test_cycles || []).some(c =>
    c.run_result === 'fail' && ['added_case', 'modified_case'].includes(c.action)
  ) || (state.events || []).some(e => e?.type === 'test_red' || e?.type === 'tdd_adopted');
  const allowed = Array.isArray(state.allowed_skills) ? state.allowed_skills : [];
  const codingIdx = allowed.indexOf('workflow-coding');
  const currentIdx = allowed.indexOf(state.current_stage);
  const codingNotCompleted = !Array.isArray(state.completed_stages) || !state.completed_stages.includes('workflow-coding');
  const beforeCoding = codingIdx >= 0 && (currentIdx < 0 || currentIdx < codingIdx);
  if (hasRed && state.current_stage !== 'workflow-coding' && codingNotCompleted && beforeCoding) {
    return { action: 'enter_skill', reason: `continue: failing test ready; enter workflow-coding.`, payload: { skill: 'workflow-coding' } };
  }

  // Stage-completion gate: when current_stage is set, no pass event has
  // been recorded for it yet, and the main agent has produced a substantive
  // last message, consult the stage-completion classifier. This covers the
  // common case where the agent finished investigating in prose without
  // saving the canonical artifact.
  if (stageClassifier && shouldRunStageCompletionClassifier(state, lastAssistantText)) {
    const verdict = stageClassifier({
      lastMessage: lastAssistantText,
      currentStage: state.current_stage,
      mode: state.mode,
    });
    if (verdict && verdict.verdict === 'complete') {
      const artifact = statePath ? canonicalArtifactPath(statePath, state.current_stage) : null;

      // Review-skill fail routing: when the completed stage is a *-review and
      // its prose verdict is 'fail', route back via route-on-fail to the
      // upstream producer. Without this, pickNextStage advances forward into
      // the next review, ignoring the review's own fail verdict.
      const isReviewStage = /-review$/.test(state.current_stage || '');
      const reviewVerdict = isReviewStage ? detectReviewVerdict(lastAssistantText) : null;
      if (isReviewStage && reviewVerdict === 'fail') {
        const syntheticEvent = {
          skill: state.current_stage,
          result: 'fail',
          cause: detectReviewFailCause(lastAssistantText),
        };
        const r = route({ event: syntheticEvent, state });
        if (r.reason === 'whitelist_violation') {
          return { action: 'request_mode_upgrade', reason: r.info, payload: r };
        }
        if (r.target) {
          return {
            action: 'enter_skill',
            reason: `continue: review fail; route back to upstream producer ${r.target}. Cause: ${r.reason}`,
            payload: { skill: r.target, direction: 'back' },
          };
        }
      }

      // Fresh-snapshot note: same pre-transition snapshot read at Stop entry.
      // The classifier just verified the current_stage is complete in prose;
      // pickNextStage selects the next allowed skill based on that snapshot,
      // which is exactly the post-pass view the injected directive needs.
      const nextSkill = pickNextStage(state);
      return {
        action: 'stage_complete',
        reason: `continue: stage ${state.current_stage} done; next ${nextSkill}.`,
        payload: {
          stage: state.current_stage,
          nextSkill,
          summary: verdict.summary || '',
          artifact, // null when stage has no canonical artifact
          lastMessage: lastAssistantText,
        },
      };
    }
    if (verdict && verdict.verdict === 'incomplete') {
      return {
        action: 'stage_incomplete',
        reason: `continue: stage ${state.current_stage} incomplete; re-enter that Skill and finish it.`,
        payload: {
          stage: state.current_stage,
          summary: verdict.summary || '',
        },
      };
    }
    // verdict === 'unknown' — fall through to the proceed/halt classifier.
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

// Detect explicit pass/fail verdict in review-skill prose.
// Returns 'pass' | 'fail' | null. Prefers the last occurrence so mid-text
// mentions ("pass criteria not met") don't mask the authoritative verdict.
export function detectReviewVerdict(text) {
  if (!text || typeof text !== 'string') return null;
  const re = /(?:^|\n|\s)(?:final\s+)?verdict\s*(?::|=|\n+)\s*[`*"']?(pass|fail)\b/gi;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1].toLowerCase();
  return last;
}

// Pull a fail-cause keyword from review prose so route-on-fail can branch
// via onFailByCase. Returns null when no known cause is named — route() then
// uses onFailDefault.
export function detectReviewFailCause(text) {
  if (!text || typeof text !== 'string') return null;
  const causes = [
    ['artifact_missing', /artifact[_\s-]*missing|missing\s+artifact|no\s+artifact/i],
    ['file_absent', /file[_\s-]*absent|file\s+not\s+found/i],
    ['insufficient_scenario', /insufficient[_\s-]*scenario|thin\s+scenario|scenario\s+coverage/i],
    ['mocked_interface', /mocked[_\s-]*interface|mocks?\s+on\s+the\s+interface/i],
    ['assertion', /assertion[_\s-]*fail|assert(?:ion)?\s+failed/i],
    ['typecheck', /type[_\s-]*check|tsc\s+(?:error|fail)/i],
    ['build', /build[_\s-]*fail|compile[_\s-]*error/i],
    ['test_run', /test[_\s-]*run|test\s+failed/i],
    ['tdd_cycle', /tdd[_\s-]*cycle|red\s+cycle/i],
    ['scope_mismatch', /scope[_\s-]*mismatch/i],
    ['lint', /\blint\b/i],
  ];
  for (const [name, re] of causes) if (re.test(text)) return name;
  return null;
}

export function formatMandatoryInjection({ skill, direction, subAgentModel, state, lastAssistantText }) {
  const lines = [];
  const dir = direction || 'advance';
  const directionLabel = dir === 'back' ? 'go BACK to'
    : dir === 'enter' ? 'ENTER'
    : 'ADVANCE to';
  lines.push('[MANDATORY WORKFLOW STEP]');
  if (state) {
    lines.push(`mode=${state.mode}, current_stage=${state.current_stage || 'null'}, ${directionLabel} ${skill} (direction=${dir})`);
  } else {
    lines.push(`${directionLabel} ${skill} (direction=${dir})`);
  }
  lines.push('');
  lines.push(`FIRST tool call MUST be Skill(skill: '${skill}'); no prose before it.`);
  lines.push('State advances only after the actual Skill tool call.');
  if (skill === 'workflow-human-check') {
    lines.push('Human-check decision MUST use native AskUserQuestion with exactly: rework, complete, hold, upgrade. Plain-text menus are invalid.');
  }
  if (subAgentModel) {
    lines.push(`Use Task(..., model='${subAgentModel}') only when a specialist is needed.`);
  }
  return lines.join('\n');
}

// Build the autopick directive appended to `continue` injections when the
// assistant's last message presented a branching choice (multi_choice /
// yes_no / open_question shapes). Tells the agent to pick the highest-
// confidence option and execute silently — never re-present the choice.
export function buildAutopickDirective(questionShape) {
  if (!INTERACTIVE_QUESTION_SHAPES.has(questionShape)) return '';
  const lines = [
    '',
    '[NO-CHOICE POLICY]',
    'Previous reply presented options. Do NOT repeat them.',
    'Pick the single highest-confidence option (strongest evidence / safest blast radius / fewest assumptions), state pick + why in ONE line, then execute via tools.',
    'Halt only for external blockers: credentials or irreversible destructive confirmation. Judgement calls are not blockers.',
  ];
  return lines.join('\n');
}

export function buildPromptInjection(decision, state, { subAgentModel = 'sonnet', lastAssistantText = '', questionShape = 'none' } = {}) {
  const header = `[auto-confirm] ${decision.reason}`;

  switch (decision.action) {
    case 'enter_skill': {
      const direction = decision.payload?.direction || 'enter';
      const block = formatMandatoryInjection({
        skill: decision.payload.skill,
        direction,
        subAgentModel,
        state,
        lastAssistantText,
      });
      const tail = decision.payload.feedback_id
        ? `\nResolve feedback: ${decision.payload.feedback_id}`
        : '';
      return `${header}\n${block}${tail}`;
    }
    case 'advance': {
      if (!decision.payload?.skill) {
        const lines = [
          header,
          'Previous skill passed. Advance to the next skill per current mode.',
          `Spawn the work via a sub-agent using model='${subAgentModel}'.`,
        ];
        if (state) lines.push(`state: mode=${state.mode}, current=${state.current_stage || 'null'}, completed=${(state.completed_stages || []).length}`);
        return lines.join('\n');
      }
      const direction = decision.payload.direction || 'advance';
      const block = formatMandatoryInjection({
        skill: decision.payload.skill,
        direction,
        subAgentModel,
        state,
        lastAssistantText,
      });
      return `${header}\n${block}`;
    }
    case 'chain_advance': {
      const lines = [header];
      lines.push(buildChainedTransitionPrompt(decision.payload.nextMode, decision.payload.remaining));
      lines.push(`Spawn the work via a sub-agent using model='${subAgentModel}'.`);
      return lines.join('\n');
    }
    case 'spawn_sub_tasker':
      return `${header}\nRisk language detected. Spawn sub-tasker to extract TODO into new task.\nSub-tasker model='${subAgentModel}'.`;
    case 'stage_complete': {
      const { stage, nextSkill, summary, artifact } = decision.payload;
      const lines = [header];
      lines.push('[MANDATORY WORKFLOW STEP]');
      lines.push(`mode=${state?.mode || '?'}, current_stage=${stage} → classifier verdict: complete (${summary})`);
      if (artifact) {
        lines.push(`Write missing artifact at absolute path: ${artifact.absPath} (basename: ${artifact.basename}); real findings only, no placeholder.`);
        lines.push(`After writing ${artifact.basename}, invoke Skill(skill: '${nextSkill}') as the next tool call.`);
      } else {
        lines.push(`No canonical artifact required for this stage (test_cycles[] or git diff evidence).`);
        lines.push(`You MUST invoke Skill(skill: '${nextSkill}') as the FIRST tool call of your reply.`);
      }
      lines.push('No prose before the Skill call.');
      if (subAgentModel) {
        lines.push(`Use Task(..., model='${subAgentModel}') only when a specialist is needed.`);
      }
      return lines.join('\n');
    }
    case 'stage_incomplete': {
      const { stage, summary } = decision.payload;
      const lines = [header];
      lines.push('[MANDATORY WORKFLOW STEP]');
      lines.push(`mode=${state?.mode || '?'}, current_stage=${stage} → classifier verdict: INCOMPLETE`);
      lines.push(`Reason: ${summary}`);
      lines.push('');
      lines.push(`Invoke Skill(skill: '${stage}') and continue; do not advance yet.`);
      lines.push('No prose before the Skill call.');
      if (subAgentModel) {
        lines.push(`Delegate to a sub-agent using Task(subagent_type=..., model='${subAgentModel}') if a specialist is needed.`);
      }
      return lines.join('\n');
    }
    case 'request_mode_upgrade':
      return `${header}\nMode upgrade required: ${decision.payload.suggested_upgrade_target}\nPresent user with upgrade options.`;
    case 'session_wrap':
      return `${header}\nTask complete. Write session/YYYY-MM-DD.md log and terminate.`;
    case 'continue': {
      const autopick = buildAutopickDirective(questionShape);
      const next = state ? pickNextStage(state) : null;
      if (next) {
        const block = formatMandatoryInjection({
          skill: next,
          direction: 'enter',
          subAgentModel,
          state,
          lastAssistantText,
        });
        return `${header}\nAssistant asked permission to proceed. Auto-confirmed.\n${block}${autopick}`;
      }
      return `${header}\nAssistant asked permission to proceed. Auto-confirmed: yes, continue.\nSpawn the next step via a sub-agent using model='${subAgentModel}'.${autopick}`;
    }
    case 'halt':
    case 'no_state':
      return null;
    default: {
      const lines = [header, 'Continue the current workflow. Do not stop until user intervenes.'];
      if (state) lines.push(`state: mode=${state.mode}, current=${state.current_stage || 'null'}, completed=${(state.completed_stages || []).length}`);
      return lines.join('\n');
    }
  }
}

// H3 — stuck-loop guard helpers. Mirrors stop-stage-enforcer's counter but
// keyed on auto-confirm decisions (action-aware) so churn at this layer is
// detectable before Stop runs. Per-project + per-session to avoid collisions
// across concurrent sessions.

export function autoConfirmSignature(state, _actionUnused) {
  // Post-fold (Fix #3): signature encodes completed_stages.length instead of
  // the decision action. The count is monotonically increasing on genuine
  // advance, so the counter resets precisely when the state moves forward —
  // no reliance on action-string stability. This matches the semantics the
  // folded stop-stage-enforcer used and closes the dual-counter gap.
  if (!state) return `no-state:0`;
  const slug = state.task_id || '?';
  const stage = state.current_stage || 'null';
  const mode = state.mode || '?';
  const completed = Array.isArray(state.completed_stages) ? state.completed_stages.length : 0;
  return `${slug}:${mode}:${stage}:${completed}`;
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

// ---------------------------------------------------------------------------
// Stage-chain helpers (Fix #3 fold — ported from the former
// scripts/stop-stage-enforcer.mjs). Kept as local exports so auto-confirm is
// self-contained as the single Stop hook after the fold.
// ---------------------------------------------------------------------------

// Always-terminal stages — any mode reaching these may halt.
export const ALWAYS_TERMINAL_STAGES = new Set(['workflow-human-check', 'done']);

// Decide what next stage the agent should enter, based on the mode's
// allowed_skills minus completed_stages and the current_stage. Order-aware:
// when current_stage is in allowed_skills, prefer the next uncompleted stage
// AFTER it in chain order; otherwise fall back to the first uncompleted-and-
// not-current allowed skill, or 'workflow-human-check' if none remain.
export function pickNextStage(state) {
  const allowed = state?.allowed_skills || [];
  const completed = new Set(state?.completed_stages || []);
  const current = state?.current_stage || '';
  const currentIdx = allowed.indexOf(current);
  if (currentIdx >= 0) {
    for (let i = currentIdx + 1; i < allowed.length; i++) {
      if (!completed.has(allowed[i])) return allowed[i];
    }
  }
  const remaining = allowed.filter(s => !completed.has(s) && s !== current);
  return remaining[0] || 'workflow-human-check';
}

// Check whether current_stage is terminal for the active mode.
// A stage is terminal when:
//   - it is in ALWAYS_TERMINAL_STAGES, or
//   - it is the last entry of state.allowed_skills (mode's chain end)
export function isTerminalStage(state) {
  const stage = state?.current_stage;
  if (!stage) return false;
  if (ALWAYS_TERMINAL_STAGES.has(stage)) return true;
  const allowed = state?.allowed_skills || [];
  if (allowed.length > 0 && allowed[allowed.length - 1] === stage) return true;
  return false;
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
  const sessionId = resolveHookSessionId(input);
  const statePath = findActiveTaskState(cwd, sessionId);
  const state = statePath ? readState(statePath) : null;
  // Resolve the agent's last assistant text. Test fixtures inject
  // `last_assistant_text` directly; production Claude Code Stop stdin
  // only carries `transcript_path`, so derive the text by parsing the
  // transcript JSONL when the explicit field is missing.
  const lastAssistantText = input.last_assistant_text
    || readLastAssistantText(input.transcript_path || '')
    || '';
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

  // Fix #3 fold — the folded Stop hook runs a single classifier subprocess
  // under Stop's own 120s timeout. Cap the inner classifier call at 10s so a
  // hung sub-agent cannot starve the Stop hook of its remaining wall-clock
  // budget (mandatoryDirective still queues cleanly even if the classifier
  // verdict is unknown). spawnSync enforces the wall-clock cap internally;
  // any caller-side AbortController would be advisory-only since spawnSync
  // is synchronous. On timeout or throw we fall through to verdict='unknown'.
  const STAGE_CLASSIFIER_TIMEOUT_MS = 10000;
  const stageClassifier = (ctx) => {
    try {
      return classifyStageCompletionViaSubAgent({
        ...ctx,
        model: subAgentModel,
        timeoutMs: STAGE_CLASSIFIER_TIMEOUT_MS,
      });
    } catch {
      return { verdict: 'unknown', summary: 'classifier timeout' };
    }
  };
  // Shape of the assistant's last message — gates spawn_sub_tasker on
  // interactive Q&A. Pure text classifier; reuses the lastAssistantText
  // we already read above.
  const questionShape = classifyQuestionShape(lastAssistantText);
  let decision = decide({ state, lastAssistantText, statePath, stageClassifier, questionShape });

  // Iron Law #5: artifacts are written by the skill producer, never by this hook.
  // The stage_complete injection (see buildPromptInjection) tells the agent to
  // write the canonical artifact via the Write tool before invoking the next
  // skill. No auto-synthesis here.

  // 'classify_needed' resolves via the lightweight LLM classifier sub-agent.
  // Per spec there is no regex fallback — sub-agent decision is final, and a
  // sub-agent failure halts (safe default that breaks the prior infinite loop).
  if (decision.action === 'classify_needed') {
    const verdict = classifyProceedPromptViaSubAgent(decision.payload.lastMessage, { model: subAgentModel });
    if (verdict.action === 'continue') {
      decision = { action: 'continue', reason: `classifier sub-agent (${subAgentModel}) → continue: ${verdict.reason}` };
    } else {
      decision = { action: 'halt', reason: `classifier sub-agent (${subAgentModel}) → halt: ${verdict.reason}` };
    }
  }

  const injection = buildPromptInjection(decision, state, { subAgentModel, lastAssistantText, questionShape });

  // 'session_wrap' is terminal — current_stage is already 'done'. Re-injecting
  // "write session log" on every Stop creates an infinite loop because the
  // state never changes again. Treat it as a halt so the session ends cleanly.
  if (decision.action === 'halt' || decision.action === 'no_state' || decision.action === 'session_wrap') {
    clearAutoConfirmLoop(cwd, sessionId);
    process.exit(0);
  }

  // Fix A — when the stage-completion classifier verdict is 'complete' but the
  // canonical artifact was produced in prose (no file write), skill-stage-
  // transition.mjs never writes a pass event (it is artifact-gated). Without a
  // pass event in state.events[], shouldRunStageCompletionClassifier keeps
  // firing on every Stop, and if the agent's follow-up is a mode-transition
  // acknowledgement ("User selected /fix"), the classifier verdict flips to
  // 'incomplete', looping until the stuck-loop guard exits silently. Persist
  // the pass event here so subsequent Stop events short-circuit the classifier.
  // Must run BEFORE autoConfirmSignature so the signature reflects the updated
  // state; completed_stages is intentionally not advanced (see
  // applyProseCompletionPass for rationale).
  if (decision.action === 'stage_complete') {
    applyProseCompletionPass(state, statePath);
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
