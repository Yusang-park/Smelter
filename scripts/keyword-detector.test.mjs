#!/usr/bin/env node
/**
 * keyword-detector.test.mjs — chain-aware classifier integration tests.
 * Covers the wire-up between keyword-detector (UserPromptSubmit hook) and
 * mode-classifier (rule-based classifier with classifyChain).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'keyword-detector.mjs');

function runDetector({ cwd, prompt, sessionId = 'chain-test' }) {
  const input = JSON.stringify({ cwd, session_id: sessionId, prompt });
  const result = spawnSync(process.execPath, [SCRIPT_PATH], { input, encoding: 'utf8' });
  assert.equal(result.status, 0, `detector exit=${result.status} stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

function findStateFile(cwd) {
  const featuresDir = join(cwd, '.smt', 'features');
  if (!existsSync(featuresDir)) return null;
  const slugs = readdirSync(featuresDir);
  for (const slug of slugs) {
    const stateJson = join(featuresDir, slug, 'task', `${slug}.state.json`);
    if (existsSync(stateJson)) return stateJson;
  }
  return null;
}

test('chain prompt with 하고 connective seeds chained_modes on state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-chain-'));
  try {
    const out = runDetector({ cwd, prompt: '확인하고 수정해줘' });
    assert.equal(out.continue, true);
    assert.match(out.hookSpecificOutput?.additionalContext ?? '', /MAGIC KEYWORD/);

    const statePath = findStateFile(cwd);
    assert.ok(statePath, 'state file not seeded');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.ok(Array.isArray(state.chained_modes), 'chained_modes must be array');
    assert.ok(state.chained_modes.length >= 2, `expected chain length >= 2, got ${state.chained_modes.length}`);
    assert.equal(state.chained_modes[0], state.mode, 'entry mode must match chained_modes[0]');
    assert.deepEqual(state.chained_modes.slice(0, 2), ['investigate', 'fix']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('single-mode prompt produces no chain on state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-single-'));
  try {
    const out = runDetector({ cwd, prompt: '버그 고쳐줘' });
    assert.equal(out.continue, true);
    assert.match(out.hookSpecificOutput?.additionalContext ?? '', /Skill: fix/);

    const statePath = findStateFile(cwd);
    assert.ok(statePath, 'state file not seeded');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.mode, 'fix');
    assert.ok(
      !state.chained_modes || state.chained_modes.length < 2,
      `single-intent prompt must not produce chain, got ${JSON.stringify(state.chained_modes)}`,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('explicit slash command bypasses classifier and seeds single mode', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-slash-'));
  try {
    const out = runDetector({ cwd, prompt: '/fix login bug' });
    assert.equal(out.continue, true);
    assert.match(out.hookSpecificOutput?.additionalContext ?? '', /Skill: fix/);

    const statePath = findStateFile(cwd);
    assert.ok(statePath, 'state file not seeded for slash command');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.mode, 'fix');
    assert.ok(
      !state.chained_modes || state.chained_modes.length < 2,
      'slash command must not produce chain',
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('plan+implement chain (설계하고 구현해) seeds plan → implement', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-chain2-'));
  try {
    const out = runDetector({ cwd, prompt: '설계하고 구현해줘' });
    assert.equal(out.continue, true);

    const statePath = findStateFile(cwd);
    assert.ok(statePath, 'state file not seeded');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.deepEqual(state.chained_modes.slice(0, 2), ['plan', 'implement']);
    assert.equal(state.mode, 'plan', 'entry mode must be first chain element');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ── Slug stability (feature: harness-integrity-phase-11 C) ─────────────────

test('CSS1: natural-language follow-up REUSES active feature (no new slug)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-reuse1-'));
  try {
    runDetector({ cwd, prompt: '사이드바 폭 파악해줘', sessionId: 's1' });
    const before = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(before.length, 1, 'first prompt creates 1 feature');

    runDetector({ cwd, prompt: '이거 더 자세히 분석해줘', sessionId: 's1' });
    const after = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(after.length, 1, `natural-language follow-up must NOT create new feature; got ${after.length}: ${after.join(', ')}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('CSS2: slash command always creates new feature', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-reuse2-'));
  try {
    runDetector({ cwd, prompt: '사이드바 폭 파악해줘', sessionId: 's1' });
    runDetector({ cwd, prompt: '/investigate 로그인 플로우', sessionId: 's1' });
    const dirs = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(dirs.length, 2, 'slash command creates distinct feature');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('CSS3: after slash command, next natural-language follow-up REUSES the slash feature', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-reuse3-'));
  try {
    runDetector({ cwd, prompt: '/investigate 로그인 플로우', sessionId: 's1' });
    runDetector({ cwd, prompt: 'OAuth 부분 추가로 확인', sessionId: 's1' });
    const dirs = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(dirs.length, 1, `post-slash follow-up must reuse; got ${dirs.length}: ${dirs.join(', ')}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('CSS4: explicit "새 feature" phrase creates new feature', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-reuse4-'));
  try {
    runDetector({ cwd, prompt: '사이드바 폭 파악해줘', sessionId: 's1' });
    runDetector({ cwd, prompt: '새 feature 만들자 — 결제 모듈', sessionId: 's1' });
    const dirs = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(dirs.length, 2, 'explicit new-feature phrase creates distinct');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('CSS5: different session_id on same cwd gets its own active pointer', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-reuse5-'));
  try {
    runDetector({ cwd, prompt: '사이드바 분석', sessionId: 'sess-A' });
    runDetector({ cwd, prompt: '로그인 분석', sessionId: 'sess-B' });
    runDetector({ cwd, prompt: '이거 이어서', sessionId: 'sess-A' }); // should reuse A's feature
    const dirs = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(dirs.length, 2, `each session has its own feature; sess-A follow-up must reuse. got ${dirs.length}: ${dirs.join(', ')}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ── Slug preamble pruning (defense-in-depth behind SMELTER_CLASSIFIER_SUBPROCESS) ──

test('SLUG1: "/fix You are a command classifier…" strips "You are a" preamble', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-slug-you-'));
  try {
    runDetector({
      cwd,
      prompt: '/fix You are a command classifier for a CLI tool called smelter',
      sessionId: 'slug-s1',
    });
    const slugs = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(slugs.length, 1, `expected 1 feature dir, got: ${slugs.join(', ')}`);
    const slug = slugs[0];
    assert.ok(!slug.startsWith('you-are'), `slug must not start with 'you-are'; got: ${slug}`);
    assert.match(slug, /command|classifier|cli|smelter/, `slug should reflect domain; got: ${slug}`);
    assert.ok(slug.length <= 50, `slug too long (${slug.length}): ${slug}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SLUG2: "/fix The login endpoint…" drops leading filler "the"', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-slug-filler-'));
  try {
    runDetector({ cwd, prompt: '/fix The login endpoint 500 regression', sessionId: 'slug-s2' });
    const slug = readdirSync(join(cwd, '.smt', 'features'))[0];
    assert.ok(!slug.startsWith('the-'), `leading 'the' must be dropped; got: ${slug}`);
    assert.match(slug, /^login/, `slug should lead with domain word 'login'; got: ${slug}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SLUG3: "/fix Skill: fix successfully loaded skill: X" strips skill-loader banner', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-slug-skill-'));
  try {
    runDetector({
      cwd,
      prompt: '/fix Skill: fix successfully loaded skill: workflow-investigate — fix hook crash',
      sessionId: 'slug-s3',
    });
    const slug = readdirSync(join(cwd, '.smt', 'features'))[0];
    assert.ok(!/^skill/.test(slug), `leading 'skill:' label must be stripped; got: ${slug}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SLUG4: "/fix 당신은 …" strips Korean copula preamble', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-slug-ko-'));
  try {
    runDetector({ cwd, prompt: '/fix 당신은 코드 리뷰어입니다 로그인 버그 수정', sessionId: 'slug-s4' });
    const slug = readdirSync(join(cwd, '.smt', 'features'))[0];
    assert.ok(!slug.startsWith('당신은'), `Korean preamble must be stripped; got: ${slug}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SLUG5: stacked preambles ("System: You are a X") peel iteratively', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-slug-stacked-'));
  try {
    runDetector({
      cwd,
      prompt: '/fix System: You are a command classifier — fix the slug generation bug',
      sessionId: 'slug-s5',
    });
    const slug = readdirSync(join(cwd, '.smt', 'features'))[0];
    assert.ok(!slug.startsWith('system'), `nested 'System:' label must peel; got: ${slug}`);
    assert.ok(!slug.startsWith('you-are'), `nested 'You are a' must peel; got: ${slug}`);
    assert.match(slug, /command|classifier|fix|slug/, `slug should reflect domain; got: ${slug}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SLUG6: zero-width char inside "You\\u200Bare a …" cannot bypass preamble strip', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-slug-zwsp-'));
  try {
    runDetector({
      cwd,
      prompt: '/fix You\u200Bare a command classifier fix the bug',
      sessionId: 'slug-s6',
    });
    const slug = readdirSync(join(cwd, '.smt', 'features'))[0];
    assert.ok(!slug.startsWith('you'), `zero-width char must not bypass 'You are a' strip; got: ${slug}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
