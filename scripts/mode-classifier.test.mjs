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
  assert('/brainstorm → brainstorm', classify('/brainstorm redesign auth').mode, 'brainstorm');
  assert('/implement → implement', classify('/implement extend foo').mode, 'implement');
  assert('/infra → infra', classify('/infra remove aws stack').mode, 'infra');
  assert('/explore → explore', classify('/explore race cond').mode, 'explore');
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
section('Layer 1 — removed commands are not compatibility aliases');
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'mc-removed-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'fix', trigger: 'removed-command-fell-through', chained_modes: null };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    const r = classify('/think redesign auth', { cwd: dir, sessionId: 'removed1' });
    assert('/think is fail-closed', r.passthrough, true);
    assert('/think does not route to a workflow mode', r.mode, null);
    const inv = classify('/investigate auth flow', { cwd: dir, sessionId: 'removed2' });
    assert('/investigate is fail-closed', inv.passthrough, true);
    assert('/investigate does not route to a workflow mode', inv.mode, null);
    const plan = classify('/plan auth flow', { cwd: dir, sessionId: 'removed3' });
    assert('/plan is fail-closed', plan.passthrough, true);
    const simple = classify('/simple-fix copy', { cwd: dir, sessionId: 'removed4' });
    assert('/simple-fix is fail-closed', simple.passthrough, true);
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
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
section('Layer 3 — LLM infra mode (stub)');
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'mc-infra-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() {
      return { schema_version: 2, mode: 'infra', trigger: 'infra:teardown', chained_modes: null, passthrough: false, target_type: null, exempt: null, skip_brainstorm: false };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    const r = classify('AWS ChartmetricN 전부 내려줘', { cwd: dir, sessionId: 'infra1' });
    assert('LLM infra-mode → infra', r.mode, 'infra');
    assert('LLM infra trigger prefixed', r.trigger.startsWith('llm:'), true);
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
      return { mode: 'explore', trigger: 'chain:explore-then-fix', chained_modes: ['explore','fix'] };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    const r = classify('조사하고 수정해', { cwd: dir, sessionId: 'chain1' });
    assert('LLM chain primary mode', r.mode, 'explore');
    assert('LLM chain chained_modes', r.chained_modes, ['explore', 'fix']);
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
      return { mode: 'explore', trigger: 'lookup', chained_modes: null, passthrough: true };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    const r = classify('workflow-tasker가 뭐야?', { cwd: dir, sessionId: 'look1' });
    assert('LLM lookup passthrough=true', r.passthrough, true);
    assert('LLM lookup mode=explore', r.mode, 'explore');
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
section('Phase 24 — Trigger prefix handling (P24-4)');
// ---------------------------------------------------------------------------
// Regression: subagent-classifier normalizes cache trigger with `llm:` prefix,
// and this wrapper used to unconditionally prepend `llm:` again, producing
// `llm:llm:imperative:repair` in the Magic Keyword banner.
{
  const dir = mkdtempSync(join(tmpdir(), 'mc-p24-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'fix', trigger: 'llm:imperative:repair', chained_modes: null };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    const r = classify('고쳐줘', { cwd: dir, sessionId: 'p24-4' });
    assert('P24-4: no double llm: prefix', /^llm:llm:/.test(r.trigger), false);
    assert('P24-4: single llm: prefix preserved', r.trigger, 'llm:imperative:repair');
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), 'mc-p24b-'));
  try {
    // Legacy path: a stub (or old cache entry) that somehow returns a raw
    // trigger without any prefix — wrapper must still add exactly one `llm:`.
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'fix', trigger: 'raw-no-prefix', chained_modes: null };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classify } = await freshImport();
    const r = classify('prompt', { cwd: dir, sessionId: 'p24-4b' });
    // subagent-classifier normalizes to `llm:raw-no-prefix` on write; wrapper
    // must leave it as-is (already prefixed after normalization).
    assert('P24-4: raw trigger normalized exactly once', r.trigger, 'llm:raw-no-prefix');
    assert('P24-4: still no double prefix', /^llm:llm:/.test(r.trigger), false);
  } finally {
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
