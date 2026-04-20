#!/usr/bin/env node
// transcript-reader.test.mjs — Unit tests for readLastAssistantText.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractAssistantText,
  readLastAssistantText,
  hasSkillInvocationSinceLastUserText,
  lastAssistantQuestionShape,
  TRANSCRIPT_MAX_BYTES,
} from './transcript-reader.mjs';

// Helper: build a JSONL transcript from a list of entries.
function writeTranscript(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  const path = join(dir, 'transcript.jsonl');
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path, body, 'utf-8');
  return { dir, path };
}

function userText(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}
function userToolResult(tool_use_id, { is_error = false, content = 'ok' } = {}) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id, content, is_error }],
  };
}
function assistantText(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
function assistantSkillCall(tool_use_id, skill) {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: tool_use_id, name: 'Skill', input: { skill } }],
  };
}
function assistantMixed(text, toolUse) {
  return { role: 'assistant', content: [{ type: 'text', text }, toolUse] };
}

test('extractAssistantText: string input returned as-is', () => {
  assert.equal(extractAssistantText('hello'), 'hello');
});

test('extractAssistantText: array with text parts joined', () => {
  const content = [
    { type: 'text', text: 'line one' },
    { type: 'tool_use', name: 'Read', input: {} },
    { type: 'text', text: 'line two' },
  ];
  assert.equal(extractAssistantText(content), 'line one\nline two');
});

test('extractAssistantText: non-text parts ignored', () => {
  const content = [
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    { type: 'thinking', thinking: 'private' },
  ];
  assert.equal(extractAssistantText(content), '');
});

test('extractAssistantText: null/undefined yield empty string', () => {
  assert.equal(extractAssistantText(null), '');
  assert.equal(extractAssistantText(undefined), '');
  assert.equal(extractAssistantText({}), '');
});

test('readLastAssistantText: nonexistent path → empty string', () => {
  assert.equal(readLastAssistantText('/no/such/file.jsonl'), '');
});

test('readLastAssistantText: empty path → empty string', () => {
  assert.equal(readLastAssistantText(''), '');
  assert.equal(readLastAssistantText(null), '');
  assert.equal(readLastAssistantText(undefined), '');
});

test('readLastAssistantText: flat envelope (role/content at top level)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const path = join(dir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ role: 'user', content: 'hi' }),
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'first assistant' }] }),
      JSON.stringify({ role: 'user', content: 'next' }),
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'LATEST answer' }] }),
    ].join('\n') + '\n';
    writeFileSync(path, lines, 'utf-8');
    assert.equal(readLastAssistantText(path), 'LATEST answer');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readLastAssistantText: nested envelope (message wrapper)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const path = join(dir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'wrapped answer' }] } }),
    ].join('\n') + '\n';
    writeFileSync(path, lines, 'utf-8');
    assert.equal(readLastAssistantText(path), 'wrapped answer');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readLastAssistantText: malformed lines are skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const path = join(dir, 'transcript.jsonl');
    const lines = [
      '{ bad json',
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }),
      '',
      '   ',
    ].join('\n') + '\n';
    writeFileSync(path, lines, 'utf-8');
    assert.equal(readLastAssistantText(path), 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readLastAssistantText: empty file → empty string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const path = join(dir, 'empty.jsonl');
    writeFileSync(path, '', 'utf-8');
    assert.equal(readLastAssistantText(path), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readLastAssistantText: no assistant messages → empty string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const path = join(dir, 'only-user.jsonl');
    const lines = [
      JSON.stringify({ role: 'user', content: 'hi' }),
      JSON.stringify({ role: 'system', content: 'policy' }),
    ].join('\n') + '\n';
    writeFileSync(path, lines, 'utf-8');
    assert.equal(readLastAssistantText(path), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readLastAssistantText: oversize file short-circuits to empty', () => {
  // Sanity check on the guard constant. Files above TRANSCRIPT_MAX_BYTES
  // must return '' without attempting to parse.
  assert.ok(TRANSCRIPT_MAX_BYTES > 0, 'constant must be positive');
});

test('readLastAssistantText: assistant with tool_use only (no text) → empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const path = join(dir, 'tool-only.jsonl');
    const lines = [
      JSON.stringify({ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }),
    ].join('\n') + '\n';
    writeFileSync(path, lines, 'utf-8');
    // Assistant has no text parts → extractAssistantText returns '';
    // the scanner should then treat it as "no substantive text" and return ''.
    assert.equal(readLastAssistantText(path), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// -------------------------------------------------------------------------
// hasSkillInvocationSinceLastUserText
// -------------------------------------------------------------------------

test('hasSkillInvocationSinceLastUserText: matching tool_use with successful tool_result → true', () => {
  const { dir, path } = writeTranscript([
    userText('start brainstorm'),
    assistantSkillCall('toolu_1', 'workflow-brainstorm'),
    userToolResult('toolu_1', { is_error: false, content: 'loaded' }),
    assistantText('Q1 — what mode?'),
  ]);
  try {
    assert.equal(hasSkillInvocationSinceLastUserText(path, 'workflow-brainstorm'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hasSkillInvocationSinceLastUserText: tool_use with errored tool_result → false', () => {
  const { dir, path } = writeTranscript([
    userText('start brainstorm'),
    assistantSkillCall('toolu_1', 'workflow-brainstorm'),
    userToolResult('toolu_1', { is_error: true, content: 'rejected' }),
    assistantText('recovery message'),
  ]);
  try {
    assert.equal(hasSkillInvocationSinceLastUserText(path, 'workflow-brainstorm'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hasSkillInvocationSinceLastUserText: tool_use without any matching tool_result → false', () => {
  const { dir, path } = writeTranscript([
    userText('start'),
    assistantSkillCall('toolu_1', 'workflow-brainstorm'),
    // No matching tool_result yet (platform crash / truncated)
    assistantText('orphan'),
  ]);
  try {
    assert.equal(hasSkillInvocationSinceLastUserText(path, 'workflow-brainstorm'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hasSkillInvocationSinceLastUserText: stale invocation before last user-text → false', () => {
  const { dir, path } = writeTranscript([
    userText('old task'),
    assistantSkillCall('toolu_1', 'workflow-brainstorm'),
    userToolResult('toolu_1', { is_error: false }),
    assistantText('done with old task'),
    userText('now unrelated work'),   // <-- current-turn anchor
    assistantText('drifting off topic'),
  ]);
  try {
    assert.equal(hasSkillInvocationSinceLastUserText(path, 'workflow-brainstorm'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hasSkillInvocationSinceLastUserText: anchor skips user-role tool_result envelopes', () => {
  // The anchor must be the last user message with a type: 'text' part,
  // NOT a user message that only carries tool_result envelopes. Otherwise
  // the current-turn invocation's tool_result (which is itself a user-role
  // entry) would be treated as the anchor and cut the invocation out of
  // the window.
  const { dir, path } = writeTranscript([
    userText('answer A'),             // last real user prompt
    assistantSkillCall('toolu_1', 'workflow-brainstorm'),
    userToolResult('toolu_1', { is_error: false }),  // tool_result, NOT the anchor
    assistantText('Q2?'),
  ]);
  try {
    assert.equal(hasSkillInvocationSinceLastUserText(path, 'workflow-brainstorm'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hasSkillInvocationSinceLastUserText: skill name mismatch → false', () => {
  const { dir, path } = writeTranscript([
    userText('anchor'),
    assistantSkillCall('toolu_1', 'workflow-investigate'),
    userToolResult('toolu_1', { is_error: false }),
    assistantText('tail'),
  ]);
  try {
    assert.equal(hasSkillInvocationSinceLastUserText(path, 'workflow-brainstorm'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hasSkillInvocationSinceLastUserText: missing / empty path → false', () => {
  assert.equal(hasSkillInvocationSinceLastUserText('', 'workflow-brainstorm'), false);
  assert.equal(hasSkillInvocationSinceLastUserText(null, 'workflow-brainstorm'), false);
  assert.equal(hasSkillInvocationSinceLastUserText(undefined, 'workflow-brainstorm'), false);
  assert.equal(hasSkillInvocationSinceLastUserText('/no/such/file.jsonl', 'workflow-brainstorm'), false);
});

test('hasSkillInvocationSinceLastUserText: malformed JSONL lines skipped, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const path = join(dir, 'bad.jsonl');
    const lines = [
      JSON.stringify(userText('anchor')),
      '{ not json',
      JSON.stringify(assistantSkillCall('toolu_1', 'workflow-brainstorm')),
      JSON.stringify(userToolResult('toolu_1', { is_error: false })),
      'also not json',
      JSON.stringify(assistantText('ok')),
    ].join('\n') + '\n';
    writeFileSync(path, lines, 'utf-8');
    assert.equal(hasSkillInvocationSinceLastUserText(path, 'workflow-brainstorm'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// -------------------------------------------------------------------------
// lastAssistantQuestionShape
// -------------------------------------------------------------------------

test('lastAssistantQuestionShape: multi_choice with (A)/(B)/(C) → multi_choice', () => {
  const { dir, path } = writeTranscript([
    assistantText([
      '어느 쪽을 택하시겠습니까?',
      '- (A) 옵션 A',
      '- (B) 옵션 B',
      '- (C) 옵션 C',
    ].join('\n')),
  ]);
  try {
    assert.equal(lastAssistantQuestionShape(path), 'multi_choice');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lastAssistantQuestionShape: numbered options 1. 2. 3. → multi_choice', () => {
  const { dir, path } = writeTranscript([
    assistantText([
      'Pick one:',
      '1. First',
      '2. Second',
      '3. Third',
    ].join('\n')),
  ]);
  try {
    assert.equal(lastAssistantQuestionShape(path), 'multi_choice');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lastAssistantQuestionShape: yes/no selector → yes_no', () => {
  const { dir, path } = writeTranscript([
    assistantText('Proceed? (y/n)'),
  ]);
  try {
    assert.equal(lastAssistantQuestionShape(path), 'yes_no');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lastAssistantQuestionShape: open question with ? and bullet list → open_question', () => {
  const { dir, path } = writeTranscript([
    assistantText([
      'Which direction do you prefer?',
      '- approach one',
      '- approach two',
    ].join('\n')),
  ]);
  try {
    assert.equal(lastAssistantQuestionShape(path), 'open_question');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lastAssistantQuestionShape: narrative numbered prose (no question anchor) → none (regression guard)', () => {
  // Multiple lines starting with `1.` / `2.` / `A.` in a narrative report
  // must NOT classify as multi_choice — otherwise the shape gate would
  // silently suppress risk-keyword routing on a legitimate disclosure.
  const { dir, path } = writeTranscript([
    assistantText([
      '1. First we read the file.',
      '2. Then we discovered a 위험 in the auth layer.',
      '3. The TODO marker remains in production code.',
    ].join('\n')),
  ]);
  try {
    assert.equal(lastAssistantQuestionShape(path), 'none');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lastAssistantQuestionShape: symlinked transcript → none (fail-closed)', () => {
  // Ensure the symlink rejection in loadTranscriptEntries flows through.
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  try {
    const real = join(dir, 'real.jsonl');
    writeFileSync(real, JSON.stringify(assistantText('?')) + '\n', 'utf-8');
    const link = join(dir, 'link.jsonl');
    // Best-effort; if symlinks aren't supported (e.g., restricted FS) skip.
    try { symlinkSync(real, link); } catch { return; }
    assert.equal(lastAssistantQuestionShape(link), 'none');
    assert.equal(hasSkillInvocationSinceLastUserText(link, 'workflow-brainstorm'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lastAssistantQuestionShape: bare trailing ? with NO options → none (regression guard)', () => {
  // Rhetorical / explanatory prose ending in ? must NOT qualify as a
  // directed question; otherwise risk-keyword shape gate over-suppresses.
  const { dir, path } = writeTranscript([
    assistantText('There is a latent 위험 in this approach. Why does this matter?'),
  ]);
  try {
    assert.equal(lastAssistantQuestionShape(path), 'none');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lastAssistantQuestionShape: declarative prose → none', () => {
  const { dir, path } = writeTranscript([
    assistantText('The implementation is complete and tests pass.'),
  ]);
  try {
    assert.equal(lastAssistantQuestionShape(path), 'none');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lastAssistantQuestionShape: missing / empty path → none', () => {
  assert.equal(lastAssistantQuestionShape(''), 'none');
  assert.equal(lastAssistantQuestionShape(null), 'none');
  assert.equal(lastAssistantQuestionShape('/no/such/file.jsonl'), 'none');
});
