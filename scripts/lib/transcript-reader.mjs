#!/usr/bin/env node
// transcript-reader.mjs — Parse a Claude Code transcript JSONL file and
// extract the last assistant text message.
//
// Claude Code Stop hook stdin carries `transcript_path` but NOT
// `last_assistant_text`. Without reading the transcript, the auto-confirm
// stage-completion classifier (Phase 2) silently skipped in production
// because its gate requires a substantive last message. This module fills
// that gap.
//
// Transcript format: one JSON object per line. Each line is an event;
// assistant messages carry `role: 'assistant'` with a `content` array of
// parts. Text parts have `type: 'text'` and a `text` field.

import { existsSync, readFileSync, statSync, lstatSync } from 'node:fs';

// Max transcript size we'll read into memory (guard against pathological
// log files). 8 MiB is plenty for any realistic session, and the hook has
// a strict time budget so parsing GB-sized files would be a self-DoS.
export const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;

// Extract the concatenated plain-text portion of an assistant message's
// content. Claude Code events wrap text parts as `{ type: 'text', text: '…' }`.
// Tool-use parts, thinking parts, and non-text parts are skipped.
export function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const pieces = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      pieces.push(part.text);
    }
  }
  return pieces.join('\n').trim();
}

// Return the text of the last assistant-role message in a JSONL transcript.
// Returns '' when the file does not exist, is empty, oversize, or has no
// assistant messages. Never throws — hook callers cannot tolerate exceptions.
export function readLastAssistantText(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return '';
  try {
    if (!existsSync(transcriptPath)) return '';
    const st = statSync(transcriptPath);
    if (!st.isFile()) return '';
    if (st.size === 0 || st.size > TRANSCRIPT_MAX_BYTES) return '';
    const raw = readFileSync(transcriptPath, 'utf-8');
    // Iterate from the end — the last assistant message is the answer.
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      // Two shapes observed in Claude Code transcripts:
      //   { type: 'message', message: { role, content } }  (legacy envelope)
      //   { role, content, ... }                            (flat envelope)
      const msg = parsed?.message || parsed;
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role !== 'assistant') continue;
      const text = extractAssistantText(msg.content);
      if (text) return text;
    }
  } catch { /* swallow */ }
  return '';
}

// Load the transcript as an array of parsed message objects, oldest first.
// Malformed lines are skipped. Never throws. Returns [] on any error, missing
// file, oversize, or when the path resolves to a symlink/non-regular file
// (defense-in-depth against redirect attacks — `transcript_path` comes from
// Claude Code stdin and is treated as untrusted).
function loadTranscriptEntries(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return [];
  try {
    if (!existsSync(transcriptPath)) return [];
    // Reject symlinks and non-regular files BEFORE the size check so a
    // symlinked target cannot bias the shape gate or the invocation signal.
    const lst = lstatSync(transcriptPath);
    if (lst.isSymbolicLink() || !lst.isFile()) return [];
    const st = statSync(transcriptPath);
    if (!st.isFile()) return [];
    if (st.size === 0) return [];
    if (st.size > TRANSCRIPT_MAX_BYTES) return [];
    const raw = readFileSync(transcriptPath, 'utf-8');
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { continue; }
      const msg = parsed?.message || parsed;
      if (!msg || typeof msg !== 'object') continue;
      entries.push(msg);
    }
    return entries;
  } catch { return []; }
}

// Determine whether a user-role entry is a "user text" message (i.e., the
// actual user prompt anchor for turn boundaries) versus a "tool_result"
// envelope that Claude Code wraps under role: 'user'. Only the former is
// the turn anchor; the latter is part of the current assistant-turn's tool
// loop and must NOT be treated as a new turn start.
function isUserTextEntry(msg) {
  if (!msg || msg.role !== 'user') return false;
  const content = msg.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => part && part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0);
}

// Does the transcript contain a successful Skill tool_use for the given
// skillName AFTER the last user-text anchor (the current turn)? "Successful"
// means a matching tool_result with `is_error !== true` is present.
//
// This is the signal used by stop-stage-enforcer to distinguish "skill
// actively running interactive Q&A" (continue Stop) from "agent drifted past
// the MANDATORY injection without invoking Skill" (force entry_not_started).
//
// Fail-closed: any missing path, parse/IO error, or absent signal → false.
export function hasSkillInvocationSinceLastUserText(transcriptPath, skillName) {
  if (!skillName || typeof skillName !== 'string') return false;
  const entries = loadTranscriptEntries(transcriptPath);
  if (entries.length === 0) return false;

  // Find the index of the last user-text entry. The current-turn window
  // starts AFTER it. A transcript with NO user-text entry at all is
  // pathological (Claude Code always records the initial user prompt) —
  // fail-closed so a crafted transcript cannot scan the whole file and
  // latch onto a stale invocation.
  let anchor = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isUserTextEntry(entries[i])) { anchor = i; break; }
  }
  if (anchor === -1) return false;
  const start = anchor + 1;

  // Collect Skill tool_use blocks with matching skill name in the window.
  // Also collect all tool_result entries (from any user-role entry after
  // start) to verify success of each candidate invocation.
  const candidateToolUseIds = new Set();
  const toolResultStatus = new Map(); // tool_use_id → { is_error: boolean }
  for (let i = start; i < entries.length; i++) {
    const msg = entries[i];
    if (!msg || !msg.content) continue;
    const parts = Array.isArray(msg.content) ? msg.content : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (msg.role === 'assistant' && part.type === 'tool_use'
          && part.name === 'Skill'
          && part.input && part.input.skill === skillName
          && typeof part.id === 'string') {
        candidateToolUseIds.add(part.id);
      }
      if (msg.role === 'user' && part.type === 'tool_result'
          && typeof part.tool_use_id === 'string') {
        toolResultStatus.set(part.tool_use_id, { is_error: part.is_error === true });
      }
    }
  }

  // Must have at least one candidate with a matching successful tool_result.
  for (const id of candidateToolUseIds) {
    const result = toolResultStatus.get(id);
    if (result && result.is_error !== true) return true;
  }
  return false;
}

// Detect the shape of the assistant's most recent user-directed question.
// Conservative bias — a bare trailing `?` is NOT enough; we require a
// multi-choice / yes-no / bulleted supporting structure to avoid treating
// rhetorical prose as a directed question.
//
// Returns: 'multi_choice' | 'yes_no' | 'open_question' | 'none'
export function lastAssistantQuestionShape(transcriptPath) {
  const text = readLastAssistantText(transcriptPath);
  if (!text) return 'none';
  return classifyQuestionShape(text);
}

// Pure classifier so callers with their own text source (no transcript path)
// can reuse the same rules. Exported for tests and for auto-confirm which
// may already have the last assistant text in-memory.
//
// Conservative bias: every return other than `'none'` requires BOTH a
// supporting structural signal (option lines, yes/no selector, bullets)
// AND a directing signal (trailing `?` / Korean question ending / selector
// phrase). This prevents narrative numbered prose (`"1. First ... 2. Then
// ..."`) from being classified as `multi_choice` and silently suppressing
// the auto-confirm risk-keyword branch.
export function classifyQuestionShape(text) {
  if (!text || typeof text !== 'string') return 'none';
  const body = text.trim();
  if (!body) return 'none';

  // Directing signal — a line ending in `?`, a Korean question ending, or a
  // recognizable selector phrase. `?\s*$` matches a `?` at the end of ANY
  // line (multiline flag) so questions that lead the message (Q1 followed
  // by option list) still count.
  const trailingQuestion = /\?\s*$/m.test(body)
    || /(까요\?|나요\?|시겠습니까|습니까\?|를\s*택하시겠|택하시겠)/.test(body);
  const selectorPhrase = /\b(Pick one|Choose one|Choose|Select one|Which (?:one|of|do|direction)|Do you (?:want|prefer))\b/i.test(body)
    || /(어느\s*쪽|어떤\s*것|어떻게\s*하|택하시겠)/.test(body);
  const directing = trailingQuestion || selectorPhrase;

  // 1) Multi-choice requires ≥ 2 option lines AND a directing signal.
  //    Canonical option lines match letter or digit markers:
  //    `- (A)`, `(A)`, `A)`, `A.`, `1.`, `1)`, `- A.`, etc.
  const optionLineRe = /^\s*(?:-\s*)?(?:\(?[A-Z]\)?|\d+[\.\)])[\s.:]/gm;
  const optionMatches = body.match(optionLineRe) || [];
  if (optionMatches.length >= 2 && directing) return 'multi_choice';

  // 2) Yes/No: explicit selector language. These patterns are themselves
  //    the directing signal — no additional anchor required.
  if (/\b[yY]\s*\/\s*[nN]\b/.test(body)) return 'yes_no';
  if (/(예|yes)\s*(\/|또는|or)\s*(아니오|no)/i.test(body)) return 'yes_no';

  // 3) Open question: a directing trailing `?` / Korean ending AND at least
  //    one bullet / numbered line in the body. The bullet requirement is
  //    what prevents rhetorical `?`-ending prose from qualifying — a
  //    paragraph of explanation ending in a rhetorical question has no
  //    bulleted options beneath it.
  const hasBullet = /^\s*-\s/m.test(body) || /^\s*\d+\.\s/m.test(body);
  if (trailingQuestion && hasBullet) return 'open_question';

  return 'none';
}
