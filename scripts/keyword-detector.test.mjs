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
// Deterministic LLM stub so tests do not depend on real Claude CLI availability.
const CLASSIFIER_STUB_PATH = join(process.cwd(), 'scripts', 'lib', '__fixtures__', 'mode-classifier-stub.mjs');
// In-process tests (TPP7/TPP8 call detectNaturalLanguageCommand directly) also
// need the stub: setting this before the module is imported makes classifyMode
// use the stub instead of a real Claude subprocess. Scope via before/after
// hooks so the override does NOT leak to unrelated tests if this file is ever
// batched into a shared runner process.
const __ORIG_MODE_CLASSIFIER_MODULE = process.env.SMELTER_MODE_CLASSIFIER_MODULE;
process.env.SMELTER_MODE_CLASSIFIER_MODULE = CLASSIFIER_STUB_PATH;
test.after(() => {
  if (__ORIG_MODE_CLASSIFIER_MODULE === undefined) {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
  } else {
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = __ORIG_MODE_CLASSIFIER_MODULE;
  }
});

function runDetector({ cwd, prompt, sessionId = 'chain-test' }) {
  const input = JSON.stringify({ cwd, session_id: sessionId, prompt });
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    input, encoding: 'utf8',
    env: { ...process.env, SMELTER_MODE_CLASSIFIER_MODULE: CLASSIFIER_STUB_PATH },
  });
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
    assert.deepEqual(state.chained_modes.slice(0, 2), ['explore', 'fix']);
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

test('short apply-only prompt seeds implement before first code edit', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-short-apply-'));
  try {
    const out = runDetector({ cwd, prompt: 'select만 적용.', sessionId: 'short-apply' });
    assert.equal(out.continue, true);
    assert.match(out.hookSpecificOutput?.additionalContext ?? '', /Skill: implement/);
    assert.match(out.hookSpecificOutput?.additionalContext ?? '', /FIRST tool call/i);
    assert.match(out.hookSpecificOutput?.additionalContext ?? '', /Skill\(skill: 'implement'\)/);
    assert.match(out.hookSpecificOutput?.additionalContext ?? '', /Read\/search tools are allowed before choosing/i);
    assert.match(out.hookSpecificOutput?.additionalContext ?? '', /Do not edit or run mutating commands before the selected Skill call/);

    const statePath = findStateFile(cwd);
    assert.ok(statePath, 'state file must be seeded before any code edit attempt');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.mode, 'implement');
    assert.equal(state.target_type, 'extend_existing');
    assert.equal(state.skip_brainstorm, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('rich text editor UI request seeds implement before plan confirmation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-rich-editor-'));
  try {
    const prompt = 'edit-artist/artist-info에서 description이 html임. html을 수정하는 text editor를 설치해서 UI로 bold와 같은 수정사항 조작할 수 있도록 편의성을 높여줘.';
    const out = runDetector({ cwd, prompt, sessionId: 'rich-editor' });
    assert.equal(out.continue, true);
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    assert.match(ctx, /Skill: implement/);
    assert.match(ctx, /selected Skill call/);

    const statePath = findStateFile(cwd);
    assert.ok(statePath, 'state file must be seeded for concrete UI feature request');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.mode, 'implement');
    assert.equal(state.target_type, 'extend_existing');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('communication-only prompt does not seed a workflow', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-comm-'));
  try {
    const out = runDetector({ cwd, prompt: '한글로 말해봐', sessionId: 'comm-only' });
    assert.equal(out.continue, true);
    assert.equal(out.hookSpecificOutput, undefined, 'communication-only prompt must pass through');
    assert.equal(findStateFile(cwd), null, 'communication-only prompt must not create workflow state');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('active workflow is sticky: natural-language explore does not reseed mode', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-sticky-'));
  const sessionId = 'sticky-mode';
  try {
    const first = runDetector({ cwd, prompt: '다크모드 토글 추가해줘', sessionId });
    assert.equal(first.continue, true);
    const firstStatePath = findStateFile(cwd);
    assert.ok(firstStatePath, 'initial implement state file not seeded');
    const firstState = JSON.parse(readFileSync(firstStatePath, 'utf8'));
    assert.equal(firstState.mode, 'implement');

    const second = runDetector({ cwd, prompt: '파악해줘', sessionId });
    assert.equal(second.continue, true);
    assert.equal(second.hookSpecificOutput, undefined, 'sticky continuation must not inject Skill: explore');

    const slugs = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(slugs.length, 1, `active workflow must not create a second feature, got ${slugs}`);
    const state = JSON.parse(readFileSync(firstStatePath, 'utf8'));
    assert.equal(state.mode, 'implement', 'active workflow mode must remain implement');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('active workflow rollback intent injects current-mode investigate stage', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-rollback-'));
  const sessionId = 'rollback-mode';
  try {
    const first = runDetector({ cwd, prompt: '다크모드 토글 추가해줘', sessionId });
    assert.equal(first.continue, true);
    const firstStatePath = findStateFile(cwd);
    assert.ok(firstStatePath, 'initial implement state file not seeded');

    const second = runDetector({ cwd, prompt: '다시 탐색해보자', sessionId });
    assert.equal(second.continue, true);
    const ctx = second.hookSpecificOutput?.additionalContext ?? '';
    assert.match(ctx, /ACTIVE WORKFLOW CONTINUATION/);
    assert.match(ctx, /Skill: workflow-investigate/);
    assert.doesNotMatch(ctx, /다시 탐색해보자/, 'continuation must inject only the command, not replay the user prompt');

    const slugs = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(slugs.length, 1, 'rollback intent must stay inside the active feature');
    const state = JSON.parse(readFileSync(firstStatePath, 'utf8'));
    assert.equal(state.mode, 'implement', 'rollback intent must not switch mode to explore');
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

test('retired slash commands are fail-closed and do not seed workflow state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-retired-'));
  try {
    for (const prompt of ['/investigate auth', '/think auth', '/plan auth', '/simple-fix copy']) {
      const out = runDetector({ cwd, prompt, sessionId: `retired-${prompt.slice(1, 5)}` });
      assert.equal(out.continue, true);
      assert.equal(out.hookSpecificOutput, undefined, `${prompt} must not inject workflow context`);
    }
    assert.equal(findStateFile(cwd), null, 'retired slash commands must not seed state');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('brainstorm+implement chain (설계하고 구현해) seeds brainstorm → implement', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-chain2-'));
  try {
    const out = runDetector({ cwd, prompt: '설계하고 구현해줘' });
    assert.equal(out.continue, true);

    const statePath = findStateFile(cwd);
    assert.ok(statePath, 'state file not seeded');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.deepEqual(state.chained_modes.slice(0, 2), ['brainstorm', 'implement']);
    assert.equal(state.mode, 'brainstorm', 'entry mode must be first chain element');
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
    runDetector({ cwd, prompt: '/explore 로그인 플로우', sessionId: 's1' });
    const dirs = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(dirs.length, 2, 'slash command creates distinct feature');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('CSS3: after slash command, next natural-language follow-up REUSES the slash feature', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-reuse3-'));
  try {
    runDetector({ cwd, prompt: '/explore 로그인 플로우', sessionId: 's1' });
    runDetector({ cwd, prompt: 'OAuth 부분 추가로 확인', sessionId: 's1' });
    const dirs = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(dirs.length, 1, `post-slash follow-up must reuse; got ${dirs.length}: ${dirs.join(', ')}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('CSS3b: active workflow sticky follow-up does not inject a new mode', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-reuse3b-'));
  try {
    runDetector({ cwd, prompt: '/explore 로그인 플로우', sessionId: 's1' });
    const out = runDetector({ cwd, prompt: 'workflow-tasker가 뭐야?', sessionId: 's1' });
    assert.equal(out.continue, true);
    assert.equal(out.hookSpecificOutput, undefined, 'sticky follow-up must not inject a different mode skill');
    const dirs = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(dirs.length, 1, `active workflow follow-up must not fork feature; got ${dirs.length}: ${dirs.join(', ')}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('CSS3c: active workflow still allows transcript paste passthrough', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-reuse3c-'));
  try {
    runDetector({ cwd, prompt: '/explore 로그인 플로우', sessionId: 's1' });
    const out = runDetector({ cwd, prompt: '⏺ step 1\n⏺ step 2', sessionId: 's1' });
    assert.equal(out.continue, true);
    assert.equal(out.hookSpecificOutput, undefined);
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

const UUID_SLUG_RE = /^feature-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('SLUG1: "/fix You are a command classifier…" → uuid-fixed slug (no prompt derivation)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-slug-you-'));
  try {
    runDetector({
      cwd,
      prompt: '/fix You are a command classifier for a CLI tool called smelter',
      sessionId: 'slug-s1',
    });
    const slugs = readdirSync(join(cwd, '.smt', 'features'));
    assert.equal(slugs.length, 1, `expected 1 feature dir, got: ${slugs.join(', ')}`);
    assert.match(slugs[0], UUID_SLUG_RE, `slug must be uuid-fixed; got: ${slugs[0]}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('SLUG2: "/fix The login endpoint…" → uuid-fixed slug (no filler leak, no prompt words)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-slug-filler-'));
  try {
    runDetector({ cwd, prompt: '/fix The login endpoint 500 regression', sessionId: 'slug-s2' });
    const slug = readdirSync(join(cwd, '.smt', 'features'))[0];
    assert.match(slug, UUID_SLUG_RE, `slug must be uuid-fixed; got: ${slug}`);
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

test('SLUG5: stacked preambles → uuid-fixed slug (no peel artifacts)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-slug-stacked-'));
  try {
    runDetector({
      cwd,
      prompt: '/fix System: You are a command classifier — fix the slug generation bug',
      sessionId: 'slug-s5',
    });
    const slug = readdirSync(join(cwd, '.smt', 'features'))[0];
    assert.match(slug, UUID_SLUG_RE, `slug must be uuid-fixed; got: ${slug}`);
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

// ── Transcript-paste passthrough (feature: transcript-paste-heuristic) ────

import { isTranscriptPaste, detectNaturalLanguageCommand } from './keyword-detector.mjs';

const VERBATIM_TRANSCRIPT = `[master fc8915cb] fix: resolve DOMAIN via SecretsManager in getUpdateSubscriptionUrl
 2 files changed, 174 insertions(+), 5 deletions(-)
⏺ 커밋 완료: fc8915cb — 2 files changed (index.ts + index.test.ts만).
⏺ Ran 2 stop hooks (ctrl+o to expand)
  ⎿  Stop hook error: [Stage] entry_not_started
  ⎿  Stop hook error: stage-completion classifier → workflow-investigate incomplete
⏺ Skill(workflow-investigate)
  ⎿  Successfully loaded skill`;

test('TPP1 isTranscriptPaste: true for verbatim user transcript', () => {
  assert.equal(isTranscriptPaste(VERBATIM_TRANSCRIPT), true);
});

test('TPP2 isTranscriptPaste: false on natural-language intent "fix the bug in auth"', () => {
  assert.equal(isTranscriptPaste('fix the bug in auth'), false);
});

test('TPP3 isTranscriptPaste: false on single incidental mention (one marker only)', () => {
  assert.equal(isTranscriptPaste('I saw this error: fix: 123 — is it related?'), false);
});

test('TPP4 isTranscriptPaste: true on two distinct ⏺ markers alone', () => {
  assert.equal(isTranscriptPaste('⏺ step 1\n⏺ step 2'), true);
});

test('TPP5 isTranscriptPaste: true on [master <sha>] banner + ⏺ marker', () => {
  assert.equal(isTranscriptPaste('[master abc1234] fix: something\n⏺ done'), true);
});

test('TPP6 explicit /fix slash at prompt start bypasses transcript heuristic', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-tpp6-'));
  try {
    const prompt = `/fix quoted log follows\n${VERBATIM_TRANSCRIPT}`;
    const out = runDetector({ cwd, prompt, sessionId: 'tpp6' });
    assert.equal(out.continue, true);
    assert.match(out.hookSpecificOutput?.additionalContext ?? '', /Skill: fix/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('TPP7 detectNaturalLanguageCommand returns passthrough on transcript paste', () => {
  const result = detectNaturalLanguageCommand(VERBATIM_TRANSCRIPT);
  assert.equal(result?.passthrough, true, `expected passthrough, got ${JSON.stringify(result)}`);
  assert.equal(result?.source, 'passthrough');
});

test('TPP8 detectNaturalLanguageCommand still returns fix on "버그 고쳐줘"', () => {
  const result = detectNaturalLanguageCommand('버그 고쳐줘');
  assert.equal(result?.name, 'fix');
  assert.equal(result?.source, 'magic');
});

test('TPP9 isTranscriptPaste: false on empty / whitespace-only', () => {
  assert.equal(isTranscriptPaste(''), false);
  assert.equal(isTranscriptPaste('   \n  \t  '), false);
});

test('TPP10 mixed paste+current fix directive seeds fix instead of passthrough', () => {
  const mixed = `${VERBATIM_TRANSCRIPT}\n이걸 고쳐줘`;
  const result = detectNaturalLanguageCommand(mixed);
  assert.equal(result?.name, 'fix', `current directive must win; got ${JSON.stringify(result)}`);
  assert.equal(result?.source, 'magic');
});

test('TPP10b mixed paste+current implement directive seeds implement instead of passthrough', () => {
  const mixed = `확인해서 구현 진행해.\n${VERBATIM_TRANSCRIPT}`;
  const result = detectNaturalLanguageCommand(mixed);
  assert.equal(result?.name, 'implement', `current implement directive must win; got ${JSON.stringify(result)}`);
  assert.equal(result?.source, 'magic');
});

test('TPP11 SMELTER_SKIP_TRANSCRIPT_HEURISTIC=1 bypasses the heuristic', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-tpp11-'));
  try {
    const input = JSON.stringify({ cwd, session_id: 'tpp11', prompt: VERBATIM_TRANSCRIPT });
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      input,
      encoding: 'utf8',
      env: { ...process.env, SMELTER_SKIP_TRANSCRIPT_HEURISTIC: '1' },
    });
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(
      /Skill: fix/.test(ctx) || /Skill:/.test(ctx),
      `env-var bypass must route to fix (or any skill) rather than passthrough; got ctx=${ctx}`,
    );
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Magic-keyword → target_type → pipeline dispatch (retained historical dispatch path).
// Verifies `/fix typo ...` resolves to the fix_simple pipeline, `/fix css ...`
// sets TDD exemption without shrinking the pipeline, and an unmatched /fix
// prompt falls through to the default fix pipeline.
// ---------------------------------------------------------------------------

test('MK1 /fix typo ... → target_type=text, fix_simple pipeline (4 skills), TDD+E2E exempt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-mk-typo-'));
  try {
    const out = runDetector({ cwd, sessionId: 'mk-typo', prompt: '/fix typo 오타 하나 있어요' });
    assert.equal(out.continue, true);

    const statePath = findStateFile(cwd);
    assert.ok(statePath, 'state file not seeded');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));

    assert.equal(state.mode, 'fix');
    assert.equal(state.target_type, 'text', 'magic keyword `typo` must set target_type=text (v3.3)');
    assert.deepEqual(
      state.allowed_skills,
      ['workflow-investigate', 'workflow-coding', 'workflow-e2e', 'workflow-human-check'],
      'text must resolve to fix_simple pipeline (4 skills)',
    );
    assert.equal(state.exempt?.tdd, true, 'text must set exempt.tdd');
    assert.equal(state.exempt?.e2e, true, 'text must set exempt.e2e');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('MK2 /fix css ... → target_type=design, fix_simple pipeline (4 skills), tdd exempt + e2e kept (v3.3)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-mk-css-'));
  try {
    const out = runDetector({ cwd, sessionId: 'mk-css', prompt: '/fix css 버튼 색상 좀 바꿔줘' });
    assert.equal(out.continue, true);

    const statePath = findStateFile(cwd);
    assert.ok(statePath, 'state file not seeded');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));

    assert.equal(state.mode, 'fix');
    assert.equal(state.target_type, 'design', 'css must set target_type=design (v3.3)');
    assert.equal(state.exempt?.tdd, true, 'design must set exempt.tdd');
    assert.equal(state.exempt?.e2e, false, 'design must NOT exempt e2e (visual surface)');
    assert.deepEqual(
      state.allowed_skills,
      ['workflow-investigate', 'workflow-coding', 'workflow-e2e', 'workflow-human-check'],
      'design must resolve to fix_simple pipeline (4 skills)',
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('MK3 /fix 버그 ... with no magic keyword → default fix pipeline, no exemption', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-mk-none-'));
  try {
    const out = runDetector({ cwd, sessionId: 'mk-none', prompt: '/fix 로그인 버그 고쳐줘' });
    assert.equal(out.continue, true);

    const statePath = findStateFile(cwd);
    assert.ok(statePath, 'state file not seeded');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));

    assert.equal(state.mode, 'fix');
    assert.equal(state.target_type, null, 'no magic keyword → target_type stays null');
    assert.equal(state.exempt?.tdd, false);
    assert.equal(state.exempt?.e2e, false);
    assert.equal(
      state.allowed_skills.length,
      8,
      `unmatched /fix must use default fix pipeline (8 skills); got ${state.allowed_skills.length}`,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 24 — classification forwarding, BRAINSTORM banner, no double Haiku call.
// ---------------------------------------------------------------------------

test('P24-2a detectNaturalLanguageCommand returns full classification object', () => {
  const result = detectNaturalLanguageCommand('버그 고쳐줘');
  assert.equal(result?.name, 'fix');
  assert.ok(result?.classification, 'classification field must be forwarded');
  assert.equal(result.classification.mode, 'fix');
  assert.equal(result.classification.target_type, 'bug_fix');
  // Non-passthrough case: wrapper omits the field rather than setting it to
  // false (see mode-classifier.mjs). Assert it is NOT true — that is what the
  // forward-path consumers rely on.
  assert.notEqual(result.classification.passthrough, true);
});

test('P24-2b seedWorkflowState uses forwarded classification — no second stub call', async () => {
  // Counter stub: every invocation bumps a file so the test can assert exactly
  // one classify pass even though keyword-detector.mjs previously called
  // classifyMode twice (once in detect, once in seedWorkflowState surface).
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-p24-2b-'));
  const counterPath = join(cwd, 'classify-calls.txt');
  const stubPath = join(cwd, 'counter-stub.mjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(counterPath, '0');
  writeFileSync(stubPath, `
    import { readFileSync, writeFileSync } from 'node:fs';
    export function classifyMode(prompt) {
      const n = parseInt(readFileSync(${JSON.stringify(counterPath)}, 'utf-8'), 10) + 1;
      writeFileSync(${JSON.stringify(counterPath)}, String(n));
      return {
        schema_version: 2,
        mode: 'fix',
        chained_modes: null,
        passthrough: false,
        trigger: 'llm:imperative:repair',
        target_type: 'bug_fix',
        exempt: null,
        skip_brainstorm: false,
      };
    }
  `, 'utf-8');
  try {
    const input = JSON.stringify({ cwd, session_id: 'p24-2b', prompt: 'some-bug-prompt' });
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      input,
      encoding: 'utf8',
      env: { ...process.env, SMELTER_MODE_CLASSIFIER_MODULE: stubPath },
    });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    const { readFileSync } = await import('node:fs');
    const calls = parseInt(readFileSync(counterPath, 'utf-8'), 10);
    assert.equal(calls, 1, `classifyMode must be called exactly once per prompt; got ${calls}`);

    const stateFile = findStateFile(cwd);
    assert.ok(stateFile, 'state.json must be seeded');
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    assert.equal(state.mode, 'fix', 'forwarded classification must seed mode');
    assert.equal(state.target_type, 'bug_fix', 'forwarded surface must reach state.json');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('P24-3 BRAINSTORM MODE banner emitted for brainstorm classification', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kwd-p24-3-'));
  try {
    const input = JSON.stringify({ cwd, session_id: 'p24-3', prompt: '설계해줘' });
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      input,
      encoding: 'utf8',
      env: { ...process.env, SMELTER_MODE_CLASSIFIER_MODULE: CLASSIFIER_STUB_PATH },
    });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /BRAINSTORM MODE/, `BRAINSTORM MODE tag must appear in stderr; got ${result.stderr}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
