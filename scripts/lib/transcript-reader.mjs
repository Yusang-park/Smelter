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

import { existsSync, readFileSync, statSync } from 'node:fs';

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
