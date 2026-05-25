/**
 * keyword-detector-chain.integration.test.mjs — full UserPromptSubmit chain.
 *
 * Spawns each hook in order with the same stdin and verifies cumulative
 * additionalContext + state-seeder side effects + last-detection.json
 * communication file. LLM is stubbed via SMELTER_MODE_CLASSIFIER_MODULE.
 *
 * Order: keyword-detector → cancel-handler → state-seeder → magic-keyword-injector
 * (auto-confirm-consumer is NOT in the test chain; it is independent of
 *  detection state.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPTS = {
  detector: join(process.cwd(), 'scripts', 'keyword-detector.mjs'),
  cancel: join(process.cwd(), 'scripts', 'cancel-handler.mjs'),
  seed: join(process.cwd(), 'scripts', 'state-seeder.mjs'),
  inject: join(process.cwd(), 'scripts', 'magic-keyword-injector.mjs'),
};
const STUB = join(process.cwd(), 'scripts', 'lib', '__fixtures__', 'mode-classifier-stub.mjs');

function runChain({ cwd, prompt, sessionId = 'chain-int' }) {
  const input = JSON.stringify({ cwd, session_id: sessionId, prompt });
  const env = { ...process.env, SMELTER_MODE_CLASSIFIER_MODULE: STUB };
  const contexts = [];
  for (const key of ['detector', 'cancel', 'seed', 'inject']) {
    const r = spawnSync(process.execPath, [SCRIPTS[key]], { input, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`${key} exit=${r.status} stderr=${r.stderr}`);
    const parsed = JSON.parse(r.stdout || '{}');
    if (parsed.hookSpecificOutput?.additionalContext) {
      contexts.push(parsed.hookSpecificOutput.additionalContext);
    }
  }
  return contexts.join('\n');
}

function findFeature(cwd) {
  const dir = join(cwd, '.smt', 'features');
  if (!existsSync(dir)) return null;
  const slugs = readdirSync(dir);
  return slugs.length ? slugs[0] : null;
}

test('IT-a /fix slash → state seeded + skill invocation emitted', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'chain-int-'));
  try {
    const ctx = runChain({ cwd, prompt: '/fix login bug' });
    assert.match(ctx, /\[MAGIC KEYWORD: FIX\]/);
    assert.match(ctx, /Skill: fix/);
    const slug = findFeature(cwd);
    assert.ok(slug, 'state-seeder must create feature on slash');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('IT-b magic Korean fix → state seeded + skill invocation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'chain-int-'));
  try {
    const ctx = runChain({ cwd, prompt: '버그 고쳐줘' });
    assert.match(ctx, /\[MAGIC KEYWORD: FIX\]/);
    const slug = findFeature(cwd);
    assert.ok(slug, 'state-seeder must create feature on magic intent=new');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('IT-c /cancel → [CANCEL] emitted, no feature seeded, no [MAGIC KEYWORD]', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'chain-int-'));
  try {
    const ctx = runChain({ cwd, prompt: '/cancel' });
    assert.match(ctx, /\[CANCEL\]/);
    assert.doesNotMatch(ctx, /\[MAGIC KEYWORD/);
    assert.equal(existsSync(join(cwd, '.smt', 'features')), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('IT-d /queue → [QUEUED] emitted, no feature seeded', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'chain-int-'));
  try {
    const ctx = runChain({ cwd, prompt: '/queue 다음에 로그인 수정' });
    assert.match(ctx, /\[QUEUED\]/);
    assert.equal(existsSync(join(cwd, '.smt', 'features')), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('IT-e intent=new magic creates new feature on continue session', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'chain-int-'));
  try {
    runChain({ cwd, prompt: '버그 고쳐줘', sessionId: 'session-e' });
    const firstSlug = findFeature(cwd);
    assert.ok(firstSlug);
    runChain({ cwd, prompt: '새 feature 만들자 — 결제 모듈', sessionId: 'session-e' });
    const slugs = readdirSync(join(cwd, '.smt', 'features'));
    assert.ok(slugs.length >= 2, 'intent=new must create second feature');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('IT-f passthrough git status → no skill emit, no feature seeded', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'chain-int-'));
  try {
    const ctx = runChain({ cwd, prompt: 'git status' });
    assert.doesNotMatch(ctx, /\[MAGIC KEYWORD/);
    assert.doesNotMatch(ctx, /\[CANCEL\]/);
    assert.equal(existsSync(join(cwd, '.smt', 'features')), false);

    const detFile = join(cwd, '.smt', 'state', 'last-detection-chain-int.json');
    if (existsSync(detFile)) {
      const det = JSON.parse(readFileSync(detFile, 'utf8'));
      assert.ok(['passthrough', 'none'].includes(det.detection?.kind),
        `passthrough kind expected, got ${det.detection?.kind}`);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
