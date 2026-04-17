#!/usr/bin/env node
/**
 * auto-confirm.mjs — Stop hook (command-agnostic).
 *
 * Behavior: when the main agent ends a turn while the project still has pending
 * work, drop the main agent's last assistant message + pending-task list into
 * `.smt/state/auto-confirm-queue.json` and block the stop with a
 * static "continue working" reason. The queue file is consumed on the next
 * UserPromptSubmit by `auto-confirm-consumer.mjs`, which injects the forwarded
 * payload as additionalContext. We do NOT spawn `claude` from the Stop hook —
 * Stop hooks run under a 15s cap and a full sub-agent roundtrip never fits.
 *
 * Gates:
 *   - `~/.smt/config.json` → `{ "autoConfirm": true }`. Defaults to ON.
 *   - Never blocks context-limit or user-abort stops.
 *
 * Works across /tasker, /feat, /qa.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { printTag } from './lib/yellow-tag.mjs';
import { readCancel, clearCancel } from './lib/cancel-signal.mjs';
import { classifyAutoConfirm } from './lib/subagent-classifier.mjs';

const AUTO_CONFIRM_RESUME_FILENAME = 'auto-confirm-resume.json';
const AUTO_CONFIRM_RESUME_MAX_AGE_MS = 5 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);

function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

export function isAutoConfirmEnabled() {
  const cfgPath = join(homedir(), '.smt', 'config.json');
  const cfg = readJsonFile(cfgPath);
  if (!cfg) return true; // default on
  return cfg.autoConfirm !== false;
}

export function isContextLimitStop(data) {
  const reason = (data.stop_reason || data.stopReason || '').toLowerCase();
  const patterns = [
    'context_limit', 'context_window', 'context_exceeded', 'context_full',
    'max_context', 'token_limit', 'max_tokens',
    'conversation_too_long', 'input_too_long',
  ];
  if (patterns.some(p => reason.includes(p))) return true;
  const endTurn = (data.end_turn_reason || data.endTurnReason || '').toLowerCase();
  return endTurn && patterns.some(p => endTurn.includes(p));
}

export function isUserAbort(data) {
  if (data.user_requested || data.userRequested) return true;
  const reason = (data.stop_reason || data.stopReason || '').toLowerCase();
  const exact = ['aborted', 'abort', 'cancel', 'interrupt'];
  const substr = ['user_cancel', 'user_interrupt', 'user_aborted', 'ctrl_c', 'manual_stop'];
  return exact.some(p => reason === p) || substr.some(p => reason.includes(p));
}

/**
 * Heuristic: does this message look like a confirmation / approval question
 * that would benefit from auto-continuation? We look at the last ~300 chars
 * since that's where agents typically place "shall I proceed?" type questions.
 */
export function looksLikeConfirmationQuestion(message) {
  if (!message || typeof message !== 'string') return false;
  const tail = message.slice(-400).toLowerCase();
  const patterns = [
    /shall i (?:proceed|continue|go ahead|do|start|create|update)/,
    /should i (?:proceed|continue|go ahead|do|start|create|update)/,
    /do you want me to /,
    /would you like me to /,
    /let me know (?:if|when|whether)/,
    /ready to (?:proceed|continue|push|commit|deploy)\?/,
    /which approach do you prefer/,
    /what do you prefer/,
    /which option do you want/,
    /원하면 다음 중 하나로 이어가겠다/,
    /i can continue with one of/,
    /진행할까요?\?|계속할까요?\?|할까요?\?|맞나요?\?/,
    /proceed\?\s*$|continue\?\s*$|ok\?\s*$/,
  ];
  return patterns.some(p => p.test(tail));
}

export function looksLikeOfferedNextSteps(message) {
  if (!message || typeof message !== 'string') return false;
  const tail = message.slice(-500).toLowerCase();
  const patterns = [
    /원하면 다음 중 하나로 이어가겠다/,
    /다음 중 하나로 이어가겠다/,
    /i can continue with one of/,
    /one of the following next steps/,
  ];
  return patterns.some(pattern => pattern.test(tail));
}

export function buildOfferedNextStepsPrompt(lastMessage) {
  return `[AUTO-CONFIRM] The last response offered concrete next steps. Execute the most direct next step now based on this message: ${lastMessage}`;
}

export function looksLikeSelfCommitment(message) {
  if (!message || typeof message !== 'string') return false;
  const tail = message.slice(-500).toLowerCase();
  const patterns = [
    /next i (?:will|ll) /,
    /i (?:will|ll) (?:now )?(?:update|fix|change|edit|implement|run|finish|continue|handle|refactor)/,
    /i(?:'|’)m going to /,
    /다음(?:으로)? .*?(?:하겠습니다|할게요|진행하겠습니다|수정하겠습니다|고치겠습니다)/,
    /(?:이제|바로|계속) .*?(?:하겠습니다|진행하겠습니다|수정하겠습니다|고치겠습니다)/,
  ];
  return patterns.some(p => p.test(tail));
}

/**
 * Extract last assistant message text from the Stop hook payload.
 * Transcripts may appear under `transcript` or `messages`.
 */
export function extractMessageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content.trim();
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b && b.type === 'text')
      .map(b => b.text || '')
      .join('\n')
      .trim();
  }
  return '';
}

export function extractLastAssistantMessage(data) {
  const transcript = data.transcript || data.messages;
  if (!Array.isArray(transcript)) return '';
  for (let i = transcript.length - 1; i >= 0; i--) {
    const msg = transcript[i];
    if (msg.role !== 'assistant') continue;
    return extractMessageText(msg);
  }
  return '';
}

export function extractClaudeHistory(data) {
  const transcript = data.transcript || data.messages;
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter(msg => msg && msg.role === 'assistant')
    .map(extractMessageText)
    .filter(Boolean)
    .slice(-3);
}

export function buildAutoConfirmMessages(lastMessage, claudeHistory) {
  const history = Array.isArray(claudeHistory) ? claudeHistory.filter(Boolean) : [];
  const normalizedLast = typeof lastMessage === 'string' ? lastMessage.trim() : '';
  if (!normalizedLast && history.length === 0) return [];
  if (!normalizedLast) return history;
  if (history[history.length - 1] === normalizedLast) return history;
  return [...history, normalizedLast].filter(Boolean).slice(-3);
}

export function looksLikeWrapUpMessage(message) {
  if (!message || typeof message !== 'string') return false;
  const text = message.toLowerCase();
  const patterns = [
    /\bsummary\b/,
    /no further concrete action remains/,
    /wrapped up the (?:investigation|work|task)/,
    /documented the result/,
    /정리(?:했습니다|했어요|함)/,
    /마무리(?:했습니다|했어요|함)/,
  ];
  return patterns.some(pattern => pattern.test(text));
}

export function shouldStopForRepeatedWrapUps(history) {
  if (!Array.isArray(history) || history.length < 3) return false;
  const recent = history.slice(-3);
  return recent.every(looksLikeWrapUpMessage);
}

export function shouldAutoContinueWithHistory(lastMessage, pendingTasks, claudeHistory) {
  if (looksLikeNoMoreWork(lastMessage)) return false;
  if (Array.isArray(pendingTasks) && pendingTasks.length > 0) return true;
  if (looksLikeConfirmationQuestion(lastMessage)) return true;
  if (looksLikeSelfCommitment(lastMessage)) return true;
  if (shouldStopForRepeatedWrapUps(claudeHistory)) return false;
  if (looksLikeWrapUpMessage(lastMessage)) return null;
  return false;
}

export function buildPendingTasksPrompt(pendingTasks) {
  const taskSummary = formatPendingTaskSummary(pendingTasks);
  return `[AUTO-CONFIRM] Session tasks: ${taskSummary}. Execute these tasks now.`;
}

export function buildRiskReviewPrompt() {
  return '[AUTO-CONFIRM] 남은 리스크 해결 및 테스트 및 검토 하라';
}

export function buildAutoConfirmPrompt(classification) {
  if (!classification || classification.action === 'stop') return '';
  if (classification.action === 'risk_review') return buildRiskReviewPrompt();
  return `[AUTO-CONFIRM] ${classification.prompt}`;
}

export function shouldAutoContinue(lastMessage, pendingTasks, claudeHistory = []) {
  return shouldAutoContinueWithHistory(lastMessage, pendingTasks, claudeHistory);
}

export function classifyAutoConfirmFallback(lastMessage, claudeHistory, directory, sessionId) {
  const messages = buildAutoConfirmMessages(lastMessage, claudeHistory);
  if (messages.length === 0) {
    return {
      action: 'risk_review',
      reason: 'no assistant history',
      prompt: buildRiskReviewPrompt(),
    };
  }
  try {
    return classifyAutoConfirm(messages, { cwd: directory, sessionId });
  } catch {
    return {
      action: 'risk_review',
      reason: 'classifier failed',
      prompt: buildRiskReviewPrompt(),
    };
  }
}

// Resolve the active feature slug for this session via the session-scoped pointer
// (same logic as step-injector.mjs). Falls back to features with active workflows.
function resolveActiveSlugs(projectDir, sessionId) {
  if (!sessionId) return [];
  const stateDir = join(projectDir, '.smt', 'state');
  const pointerPath = join(stateDir, `active-feature-${sessionId}.json`);
  try {
    if (!existsSync(pointerPath)) return [];
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    if (pointer?.slug) return [pointer.slug];
  } catch {}
  return [];
}

function formatPendingTaskSummary(pendingTasks) {
  if (!Array.isArray(pendingTasks) || pendingTasks.length === 0) return '';
  return pendingTasks
    .map((task, index) => `${index + 1}. ${task.title}`)
    .join(' | ');
}

function looksLikeNoMoreWork(message) {
  if (!message || typeof message !== 'string') return false;
  const tail = message.slice(-500).toLowerCase();
  const patterns = [
    /no further concrete action remains/,
    /no more work remains/,
    /nothing left to do/,
    /nothing else to do/,
    /there(?: is|'s) nothing left/,
    /더 이상 진행할게 없/,
    /더 진행할 작업 없/,
    /더 할 일 없/,
    /진행할게 없/,
    /없다\.?\s*더 진행할게 없/,
  ];
  return patterns.some(pattern => pattern.test(tail));
}

// Read pending task titles from the current session's active feature only.
export function readPendingTasks(projectDir, sessionId = '') {
  if (process.env.SMELTER_DISABLE_PENDING_TASKS_FOR_TEST === '1') return [];
  const tasks = [];
  const featuresDir = join(projectDir, '.smt', 'features');
  if (!existsSync(featuresDir)) return tasks;

  const slugs = resolveActiveSlugs(projectDir, sessionId);
  if (slugs.length === 0) return tasks;

  for (const slug of slugs) {
    const taskDirPath = join(featuresDir, slug, 'task');
    if (!existsSync(taskDirPath)) continue;
    let files = [];
    try { files = readdirSync(taskDirPath).filter(f => f.endsWith('.md') && f !== 'plan.md').sort(); } catch {}
    for (const f of files) {
      try {
        const content = readFileSync(join(taskDirPath, f), 'utf-8');
        for (const line of content.split('\n')) {
          const m = line.match(/^[-*]\s*\[\s\]\s*(.+)$/);
          if (m) tasks.push({ status: 'pending', title: m[1].trim() });
        }
      } catch {}
    }
  }
  return tasks;
}

async function main() {
  printTag('Auto-Confirm');
  try {
    const input = readStdinSync();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';

    // Never block context-limit stops
    if (isContextLimitStop(data)) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    // Respect explicit user abort
    if (isUserAbort(data)) {
      try {
        const stateDir = join(directory, '.smt', 'state');
        if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
        writeFileSync(
          join(stateDir, 'last-interrupt.json'),
          JSON.stringify({ timestamp: Date.now(), reason: data.stop_reason || 'user_abort' }),
        );
      } catch {}
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Global autoConfirm gate — checked BEFORE cancel-signal handling so a
    // disabled autoConfirm truly no-ops the hook.
    if (!isAutoConfirmEnabled()) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Cancel signal — respect hard/queue
    const cancelSignal = readCancel(directory, sessionId);
    if (cancelSignal) {
      if (cancelSignal.type === 'hard') {
        clearCancel(directory);
        console.log(JSON.stringify({ continue: true }));
        return;
      }
      if (cancelSignal.type === 'queue' && cancelSignal.queued_intent) {
        clearCancel(directory);
        printTag('Auto-Confirm: Queued Redirect');
        console.log(JSON.stringify({
          decision: 'block',
          reason: `[QUEUED REDIRECT] Previous work complete. Now execute the queued intent: ${cancelSignal.queued_intent}`,
        }));
        return;
      }
    }

    const pending = readPendingTasks(directory, sessionId);
    const lastMessage = extractLastAssistantMessage(data);
    const claudeHistory = extractClaudeHistory(data);
    const pendingDecision = shouldAutoContinue(lastMessage, pending, claudeHistory);

    if (pendingDecision === false) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    if (pendingDecision === true) {
      printTag('Auto-Confirm: tasks');
      console.log(JSON.stringify({ decision: 'block', reason: buildPendingTasksPrompt(pending) }));
      return;
    }

    if (looksLikeOfferedNextSteps(lastMessage)) {
      printTag('Auto-Confirm: offered-next-steps');
      console.log(JSON.stringify({ decision: 'block', reason: buildOfferedNextStepsPrompt(lastMessage) }));
      return;
    }

    const classification = classifyAutoConfirmFallback(lastMessage, claudeHistory, directory, sessionId);
    if (classification.action === 'stop') {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    printTag('Auto-Confirm: classifier');
    console.log(JSON.stringify({ decision: 'block', reason: buildAutoConfirmPrompt(classification) }));
  } catch (err) {
    // Never deadlock on errors
    try { printTag('Auto-Confirm: Error (continue)'); } catch {}
    console.log(JSON.stringify({ continue: true }));
  }
}

// Only run main when invoked as a script (not when imported for tests).
if (process.argv[1] && process.argv[1] === __filename) {
  main();
}
