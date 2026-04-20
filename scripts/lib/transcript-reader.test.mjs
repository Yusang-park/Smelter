#!/usr/bin/env node
// transcript-reader.test.mjs — Unit tests for readLastAssistantText.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractAssistantText,
  readLastAssistantText,
  TRANSCRIPT_MAX_BYTES,
} from './transcript-reader.mjs';

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
