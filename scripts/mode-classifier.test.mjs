#!/usr/bin/env node
/**
 * mode-classifier.test.mjs — Unit tests for the 4-layer classify().
 *
 * Layer 3 (LLM) is mocked via SMELTER_MODE_CLASSIFIER_MODULE to avoid hitting
 * the real Claude CLI. Layer 1 (explicit slash) and Layer 2 (passthrough) are
 * deterministic and tested without mocking. Layer 4 (fallback) is exercised
 * by stubbing the LLM to throw.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
const failures = [];

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push({ label, actual, expected });
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
  }
}

function section(title) {
  console.log(`\n[${title}]`);
}

function mkStub(dir, body) {
  const stubPath = join(dir, 'mode-classifier-stub.mjs');
  writeFileSync(stubPath, body, 'utf-8');
  return stubPath;
}

async function freshImport() {
  // Force fresh module state so env-var side effects in the classifier-lib are
  // observed between stubs.
  return import('./mode-classifier.mjs?' + Date.now() + Math.random());
}

// ---------------------------------------------------------------------------
section('Layer 1 — Explicit slash commands (no LLM call)');
// ---------------------------------------------------------------------------
{
  const { classify } = await freshImport();
  assert('/fix → fix', classify('/fix login bug').mode, 'fix');
  assert('/fix overridden=true', classify('/fix login bug').overridden, true);
  assert('/think → think', classify('/think redesign auth').mode, 'think');
  assert('/implement → implement', classify('/implement extend foo').mode, 'implement');
  assert('/investigate → investigate', classify('/investigate race cond').mode, 'investigate');
  assert('/verify → verify', classify('/verify suite').mode, 'verify');
  assert('slash trigger prefix', classify('/fix x').trigger.startsWith('command:/fix'), true);
}

// ---------------------------------------------------------------------------
section('Layer 2 — Passthrough (pure git/shell verb-first only)');
// ---------------------------------------------------------------------------
{
  const { classify } = await freshImport();
  assert('git commit → passthrough', classify('git commit').passthrough, true);
  assert('git push origin main → passthrough', classify('git push origin main').passthrough, true);
  assert('gh pr list → passthrough', classify('gh pr list').passthrough, true);
  assert('커밋해 → passthrough', classify('커밋해').passthrough, true);
  assert('push 좀 → passthrough', classify('push 좀').passthrough, true);
  assert('stash 해 → passthrough', classify('stash 해').passthrough, true);
  assert('passthrough mode=null', classify('git commit').mode, null);
  assert('passthrough trigger prefix', classify('git commit').trigger.startsWith('passthrough:'), true);
}

// ---------------------------------------------------------------------------
section('Layer 2 — Mixed-intent NOT passthrough (falls to LLM)');
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'mc-mixed-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'fix', trigger: 'llm:mixed-intent', chained_modes: null };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    const r = classify('git log 후 고쳐줘', { cwd: dir, sessionId: 'mix1' });
    assert('mixed "git log 후 고쳐줘" NOT passthrough', r.passthrough, undefined);
    assert('mixed routes to LLM (fix)', r.mode, 'fix');
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
section('Layer 3 — LLM single-mode (stub)');
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'mc-llm-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'fix', trigger: 'bug-intent', chained_modes: null };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    const r = classify('버그 고쳐줘', { cwd: dir, sessionId: 'llm1' });
    assert('LLM single-mode → fix', r.mode, 'fix');
    assert('LLM trigger prefixed with llm:', r.trigger.startsWith('llm:'), true);
    assert('LLM single-mode no chained_modes', r.chained_modes, undefined);
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
section('Layer 3 — LLM chain emits chained_modes');
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'mc-chain-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'investigate', trigger: 'chain:inv-then-fix', chained_modes: ['investigate','fix'] };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    const r = classify('조사하고 수정해', { cwd: dir, sessionId: 'chain1' });
    assert('LLM chain primary mode', r.mode, 'investigate');
    assert('LLM chain chained_modes', r.chained_modes, ['investigate', 'fix']);
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
section('Layer 3 — LLM passthrough hint flows through');
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'mc-lookup-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'investigate', trigger: 'lookup', chained_modes: null, passthrough: true };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    const r = classify('workflow-tasker가 뭐야?', { cwd: dir, sessionId: 'look1' });
    assert('LLM lookup passthrough=true', r.passthrough, true);
    assert('LLM lookup mode=investigate', r.mode, 'investigate');
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
section('No-fallback policy — LLM throw propagates');
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'mc-nofb1-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() { throw new Error('classifier down'); }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    let threw = false;
    try { classify('이게 정상인지?', { cwd: dir, sessionId: 'nofb1' }); }
    catch (e) { threw = e.message.includes('classifier down'); }
    assert('LLM throw propagates (no interrogative fallback)', threw, true);
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
section('No-fallback policy — LLM invalid mode throws');
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'mc-nofb2-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'garbage', trigger: 'bad' };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    // classifyMode in subagent-classifier.mjs already throws on invalid mode,
    // so classify() re-throws up through the caller with no mask.
    let threw = false;
    try { classify('do something', { cwd: dir, sessionId: 'nofb2' }); }
    catch { threw = true; }
    assert('invalid mode throws (no default:fix fallback)', threw, true);
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
section('Empty / nullish inputs — return null, no classification');
// ---------------------------------------------------------------------------
{
  const { classify } = await freshImport();
  assert('empty string → null', classify(''), null);
  assert('null → null', classify(null), null);
  assert('whitespace → null', classify('   '), null);
}

// ---------------------------------------------------------------------------
// classifyMagicKeywords section removed in v3.2 — surface extraction now
// lives in scripts/lib/surface-extraction.mjs (see surface-extraction.test.mjs).
// ---------------------------------------------------------------------------
section('Layer 1 — word boundary: /fixture must NOT match /fix');
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'mc-wb-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'implement', trigger: 'llm:fixture-not-fix', chained_modes: null };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    // Deliberately non-command, prefix-colliding input. Must reach Layer 3.
    const r = classify('/fixture something', { cwd: dir, sessionId: 'wb1' });
    assert('/fixture does NOT resolve to /fix', r.trigger.startsWith('command:'), false);
    assert('/fixture reaches LLM layer', r.mode, 'implement');
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
section('Layer 3 — invalid chained_modes dropped, primary mode kept');
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'mc-badchain-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'fix', trigger: 'bad-chain', chained_modes: ['fix', 'garbage'] };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    const r = classify('do a thing', { cwd: dir, sessionId: 'bc1' });
    assert('invalid chained_modes dropped', r.chained_modes, undefined);
    assert('invalid chain still returns primary mode', r.mode, 'fix');
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
section('Layer 2 — SMT_CLASSIFIER_NO_PASSTHROUGH=1 kill switch');
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'mc-killswitch-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'fix', trigger: 'fallthrough', chained_modes: null };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    process.env.SMT_CLASSIFIER_NO_PASSTHROUGH = '1';
    const { classify } = await freshImport();
    const r = classify('git commit', { cwd: dir, sessionId: 'ks1' });
    assert('passthrough disabled → LLM', r.passthrough, undefined);
    assert('passthrough disabled → mode from LLM', r.mode, 'fix');
  } finally {
    delete process.env.SMT_CLASSIFIER_NO_PASSTHROUGH;
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}`);
  process.exit(1);
}
process.exit(0);
