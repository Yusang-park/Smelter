#!/usr/bin/env node
// Tests for yellow-tag.mjs — existing NO_COLOR / piped behavior (preserved)
// + sanitization contract for control chars, ANSI CSI introducers, bidi
// overrides, and zero-width separators smuggled into a label through
// err.message or filesystem paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOD = join(__dirname, 'yellow-tag.mjs');
const MOD_URL = pathToFileURL(MOD).href;

let yellowTagModulePromise;

async function loadYellowTag() {
  yellowTagModulePromise ??= import(MOD_URL);
  return yellowTagModulePromise;
}

// ── preserved legacy cases (env-driven color suppression) ──────────────────

function runWithEnv(env) {
  const code = `import('${MOD}').then(m => m.printTag('Test Tag'));`;
  return spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

test('legacy-1: NO_COLOR=1 produces plain ASCII output without ANSI', () => {
  const r = runWithEnv({ NO_COLOR: '1' });
  assert.equal(r.stderr.trim(), '[Test Tag]');
});

test('legacy-2: piped stderr (NO_COLOR unset) still contains the bracketed label', () => {
  const r = runWithEnv({ NO_COLOR: '' });
  assert.ok(r.stderr.includes('[Test Tag]'));
});

// ── new sanitization cases ────────────────────────────────────────────────

function stripWrap(s) {
  return s.replace(/\x1b\[\d+m/g, '');
}

function bodyOf(s) {
  const plain = stripWrap(s);
  const m = plain.match(/^\[(.*)\]$/s);
  return m ? m[1] : plain;
}

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { fn(); } finally { process.stderr.write = original; }
  return chunks.join('');
}

// --- happy path ---

test('regression: module imports cleanly under Node 22', async () => {
  const mod = await loadYellowTag();
  assert.equal(typeof mod.formatTag, 'function');
  assert.equal(typeof mod.printTag, 'function');
});

test('happy: plain ASCII label passes through unchanged inside the bracket body', async () => {
  const { formatTag } = await loadYellowTag();
  assert.equal(bodyOf(formatTag('Session Start')), 'Session Start');
});

test('happy: empty label produces empty body, not an error', async () => {
  const { formatTag } = await loadYellowTag();
  assert.equal(bodyOf(formatTag('')), '');
});

// --- boundary ---

test('boundary: Hangul + mixed-script content is preserved byte-for-byte', async () => {
  const { formatTag } = await loadYellowTag();
  const label = '세션 시작 — start';
  assert.equal(bodyOf(formatTag(label)), label);
});

test('boundary: leading and trailing spaces inside the label are preserved', async () => {
  const { formatTag } = await loadYellowTag();
  const label = '  spaced  ';
  assert.equal(bodyOf(formatTag(label)), label);
});

// --- error path (injection attempts) ---

test('error: ANSI CSI introducer \\x1b is stripped from the label body', async () => {
  const { formatTag } = await loadYellowTag();
  const body = bodyOf(formatTag('before\x1b[2Jafter'));
  assert.ok(!body.includes('\x1b'), `expected no ESC inside body; got ${JSON.stringify(body)}`);
  assert.ok(body.includes('before') && body.includes('after'));
});

test('error: CR/LF inside the label are stripped (prevents overwrite/injection)', async () => {
  const { formatTag } = await loadYellowTag();
  const body = bodyOf(formatTag('head\r\nfoot'));
  assert.ok(!/[\r\n]/.test(body), `expected no CR/LF inside body; got ${JSON.stringify(body)}`);
});

test('error: C0 controls (\\x00-\\x08, \\x0b-\\x1f) and DEL \\x7f are stripped', async () => {
  const { formatTag } = await loadYellowTag();
  const label = 'a\x00b\x07c\x1fd\x7fe';
  assert.equal(bodyOf(formatTag(label)), 'abcde');
});

// --- edge case ---

test('edge: bidi override U+202E is stripped', async () => {
  const { formatTag } = await loadYellowTag();
  const body = bodyOf(formatTag('hello‮world'));
  assert.ok(!body.includes('‮'), `expected no RLO in body; got ${JSON.stringify(body)}`);
});

test('edge: zero-width space U+200B is stripped', async () => {
  const { formatTag } = await loadYellowTag();
  assert.equal(bodyOf(formatTag('a​b')), 'ab');
});

test('edge: ZWNJ (U+200C) and ZWJ (U+200D) are PRESERVED (legitimate Persian/Hindi use)', async () => {
  const { formatTag } = await loadYellowTag();
  const zwnj = 'a‌b';
  const zwj = 'a‍b';
  assert.equal(bodyOf(formatTag(zwnj)), zwnj);
  assert.equal(bodyOf(formatTag(zwj)), zwj);
});

test('edge: isolates U+2066-U+2069 and line/paragraph separators U+2028/U+2029 are stripped', async () => {
  const { formatTag } = await loadYellowTag();
  const label = `a\u2066b\u2069c\u2028d\u2029e`;
  assert.equal(bodyOf(formatTag(label)), 'abcde');
});

// --- integration ---

test('integration: printTag emits one line to stderr with no raw ESC inside the tag body', async () => {
  const { printTag } = await loadYellowTag();
  const captured = captureStderr(() => printTag('before\x1b[2Jafter'));
  assert.ok(captured.endsWith('\n'), `expected trailing newline; got ${JSON.stringify(captured)}`);
  const body = bodyOf(captured.replace(/\n$/, ''));
  assert.ok(!body.includes('\x1b'), `payload ESC leaked into body: ${JSON.stringify(body)}`);
  assert.ok(body.includes('before') && body.includes('after'));
});

test('integration: realistic fs-error message (path carrying CR+ESC) is sanitized when logged', async () => {
  const { printTag } = await loadYellowTag();
  const fakeMessage = "ENOENT: no such file or directory, open '/tmp/\x1b[31mevil\x1b[0m/file'";
  const captured = captureStderr(() => printTag(`State seed failed: ${fakeMessage}`));
  const body = bodyOf(captured.replace(/\n$/, ''));
  assert.ok(!body.includes('\x1b'), `ESC leaked from err.message into tag body: ${JSON.stringify(body)}`);
  assert.ok(body.startsWith('State seed failed: ENOENT'));
});
