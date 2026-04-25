#!/usr/bin/env node
/**
 * subagent-mode-classifier.test.mjs — Unit tests for classifyMode().
 *
 * Uses SMELTER_MODE_CLASSIFIER_MODULE env-var injection to mock the LLM
 * response in tests. Real OAuth-based Claude CLI path is exercised only
 * in workflow-scenarios / manual QA, not here.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

const tests = [];
function test(label, fn) { tests.push({ label, fn }); }

async function runAll() {
  for (const { label, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${label}`);
    } catch (err) {
      failed++;
      failures.push({ label, message: err.message });
      console.log(`  FAIL  ${label}`);
      console.log(`        ${err.message}`);
    }
  }
}

function mkStub(dir, body) {
  const stubPath = join(dir, 'mode-classifier-stub.mjs');
  writeFileSync(stubPath, body, 'utf-8');
  return stubPath;
}

async function freshImport() {
  // Force re-import so env-var side effects (cached binary path, etc.) are
  // picked up between tests.
  const mod = await import('./subagent-classifier.mjs?' + Date.now());
  return mod;
}

test('classifyMode returns single-mode result when stub returns fix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-'));
  try {
    const stub = mkStub(dir, `export function classifyMode(prompt) {
      return { mode: 'fix', trigger: 'llm:bug-intent', chained_modes: null };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classifyMode } = await freshImport();
    const res = classifyMode('버그 고쳐줘', { cwd: dir, sessionId: 's1' });
    assert.equal(res.mode, 'fix');
    assert.equal(res.trigger, 'llm:bug-intent');
    assert.equal(res.chained_modes, null);
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyMode returns chained_modes array when stub emits chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-'));
  try {
    const stub = mkStub(dir, `export function classifyMode(prompt) {
      return { mode: 'explore', chained_modes: ['explore', 'fix'], trigger: 'llm:chain' };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classifyMode } = await freshImport();
    const res = classifyMode('조사하고 수정해', { cwd: dir, sessionId: 's2' });
    assert.equal(res.mode, 'explore');
    assert.deepEqual(res.chained_modes, ['explore', 'fix']);
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyMode rejects unknown mode from stub', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-'));
  try {
    const stub = mkStub(dir, `export function classifyMode(prompt) {
      return { mode: 'garbage', trigger: 'llm:bad' };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classifyMode } = await freshImport();
    assert.throws(
      () => classifyMode('whatever', { cwd: dir, sessionId: 's3' }),
      /Invalid mode classifier response/,
    );
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyMode caches repeated prompts per session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-'));
  try {
    const counterPath = join(dir, 'count.json');
    writeFileSync(counterPath, '0');
    const stub = mkStub(dir, `
      import { readFileSync, writeFileSync } from 'node:fs';
      export function classifyMode(prompt) {
        const n = Number(readFileSync('${counterPath}', 'utf-8')) + 1;
        writeFileSync('${counterPath}', String(n));
        return { mode: 'brainstorm', trigger: 'llm:call-' + n };
      }
    `);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classifyMode } = await freshImport();
    const r1 = classifyMode('리팩토링 계획 세워', { cwd: dir, sessionId: 'cache-s' });
    const r2 = classifyMode('리팩토링 계획 세워', { cwd: dir, sessionId: 'cache-s' });
    assert.equal(r1.mode, 'brainstorm');
    assert.equal(r2.mode, 'brainstorm');
    const callCount = Number(readFileSync(counterPath, 'utf-8'));
    assert.equal(callCount, 1, 'stub invoked once — second read served from cache');
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyMode rejects poisoned non-passthrough cache entry with command: trigger', async () => {
  // Closes the gap where a poisoned entry with `passthrough:false,
  // trigger:"command:/fix"` previously validated because the prefix guard
  // only applied to passthrough=true entries.
  const dir = mkdtempSync(join(tmpdir(), 'mc-poison2-'));
  try {
    const stateDir = join(dir, '.smt', 'state');
    mkdirSync(stateDir, { recursive: true });
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'fix', trigger: 'llm:real', chained_modes: null };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;

    const { classifyMode } = await freshImport();
    const prompt = 'poison-nonpass-target';
    const r1 = classifyMode(prompt, { cwd: dir, sessionId: 'poison2' });
    assert.equal(r1.mode, 'fix');

    const cachePath = join(stateDir, 'mode-classifier-cache.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const hashKey = Object.keys(cache).find((k) => k !== '_session');
    // Poison: claim a non-LLM provenance prefix.
    cache[hashKey] = { mode: 'brainstorm', passthrough: false, trigger: 'command:/think', chained_modes: null };
    writeFileSync(cachePath, JSON.stringify(cache));

    const r2 = classifyMode(prompt, { cwd: dir, sessionId: 'poison2' });
    assert.equal(r2.mode, 'fix', 'poisoned non-passthrough entry must be rejected');
    assert.notEqual(r2.mode, 'brainstorm');
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyMode rejects poisoned cache entry with non-whitelisted trigger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-poison-'));
  try {
    // Seed a poisoned cache file BEFORE calling classifyMode: an adversary
    // with FS write could plant `passthrough:true` with an arbitrary trigger
    // to divert any future prompt of the same hash.
    const stateDir = join(dir, '.smt', 'state');
    mkdirSync(stateDir, { recursive: true });
    const poisoned = {
      _session: 'poison-s',
      // sha256 of "burger" prefix 16 chars is required — easiest is to match
      // what classifyMode itself would compute for a sentinel prompt.
    };
    // Use the same promptHash by importing the module once to derive the key.
    const prompt = 'poison-target';
    // Force stub-mode so no real LLM call; stub returns fix — if the cache is
    // poisoned and NOT revalidated, classifyMode would return the poisoned
    // passthrough entry instead of the stub's fix response.
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'fix', trigger: 'llm:post-poison', chained_modes: null };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;

    const { classifyMode } = await freshImport();
    // First call: primes the cache via the stub path.
    const r1 = classifyMode(prompt, { cwd: dir, sessionId: 'poison-s' });
    assert.equal(r1.mode, 'fix');

    // Now overwrite the cache with a poisoned entry for the same prompt hash.
    const cachePath = join(stateDir, 'mode-classifier-cache.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const hashKey = Object.keys(cache).find((k) => k !== '_session');
    cache[hashKey] = { mode: 'verify', passthrough: true, trigger: 'arbitrary-attacker-string', chained_modes: null };
    writeFileSync(cachePath, JSON.stringify(cache));

    // Second call must NOT return the poisoned entry — it should drop it and
    // fall through to the stub, returning fix again.
    const r2 = classifyMode(prompt, { cwd: dir, sessionId: 'poison-s' });
    assert.equal(r2.mode, 'fix', 'poisoned cache must be rejected');
    assert.notEqual(r2.mode, 'verify', 'attacker-planted mode must not leak');
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 24 — trigger normalization on cache write (P24-1).
// Without llm:/stub: prefix, isValidModeCacheEntry rejects the entry on read
// and every classify call round-trips the subprocess.
// ---------------------------------------------------------------------------
test('P24-1: raw trigger gets llm: prefix on cache write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-'));
  try {
    const stateDir = join(dir, '.smt', 'state');
    mkdirSync(stateDir, { recursive: true });
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'fix', trigger: 'imperative:repair', chained_modes: null };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classifyMode } = await freshImport();
    const r = classifyMode('고쳐줘', { cwd: dir, sessionId: 'p24-1' });
    assert.equal(r.trigger, 'llm:imperative:repair', 'raw trigger must carry llm: prefix');

    const cachePath = join(stateDir, 'mode-classifier-cache.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const entry = Object.values(cache).find((v) => v && typeof v === 'object' && v.mode);
    assert.ok(entry, 'cache entry must exist');
    assert.match(entry.trigger, /^(llm:|stub:)/, 'cached trigger must start with llm:/stub: so it passes the validator');
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P24-1: existing llm: prefix is preserved, not doubled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-'));
  try {
    const stub = mkStub(dir, `export function classifyMode() {
      return { mode: 'fix', trigger: 'llm:already-prefixed', chained_modes: null };
    }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classifyMode } = await freshImport();
    const r = classifyMode('prompt', { cwd: dir, sessionId: 'p24-1b' });
    assert.equal(r.trigger, 'llm:already-prefixed', 'must not double-prefix');
    assert.doesNotMatch(r.trigger, /^llm:llm:/);
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P24-1: cache hit on second call — no re-invocation (counter stays at 1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-'));
  try {
    const counterPath = join(dir, 'counter.txt');
    writeFileSync(counterPath, '0');
    const stub = mkStub(dir, `import { readFileSync, writeFileSync } from 'node:fs';
      export function classifyMode() {
        const n = parseInt(readFileSync(${JSON.stringify(counterPath)}, 'utf-8'), 10) + 1;
        writeFileSync(${JSON.stringify(counterPath)}, String(n));
        return { mode: 'fix', trigger: 'imperative:repair', chained_modes: null };
      }`);
    process.env.SMELTER_MODE_CLASSIFIER_MODULE = stub;
    const { classifyMode } = await freshImport();
    classifyMode('same-prompt', { cwd: dir, sessionId: 'p24-1c' });
    classifyMode('same-prompt', { cwd: dir, sessionId: 'p24-1c' });
    const calls = parseInt(readFileSync(counterPath, 'utf-8'), 10);
    assert.equal(calls, 1, 'cache normalization must make second call a cache hit');
  } finally {
    delete process.env.SMELTER_MODE_CLASSIFIER_MODULE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifier model selection ignores stale Codex active model in explicit Claude mode', async () => {
  const prevMode = process.env.SMELTER_MODEL_MODE;
  const prevActiveModel = process.env.SMELTER_ACTIVE_MODEL;
  const prevCodexMode = process.env.CODEX_MODE;
  try {
    process.env.SMELTER_MODEL_MODE = 'claude';
    process.env.SMELTER_ACTIVE_MODEL = 'gpt-5.4';
    process.env.CODEX_MODE = '1';
    const { selectClassifierModel } = await freshImport();
    assert.equal(selectClassifierModel(), 'haiku');
  } finally {
    if (prevMode === undefined) delete process.env.SMELTER_MODEL_MODE;
    else process.env.SMELTER_MODEL_MODE = prevMode;
    if (prevActiveModel === undefined) delete process.env.SMELTER_ACTIVE_MODEL;
    else process.env.SMELTER_ACTIVE_MODEL = prevActiveModel;
    if (prevCodexMode === undefined) delete process.env.CODEX_MODE;
    else process.env.CODEX_MODE = prevCodexMode;
  }
});

test('classifier prompt exposes v0.4 command surface only', async () => {
  const { CLASSIFICATION_PROMPT } = await freshImport();
  assert.match(CLASSIFICATION_PROMPT, /Commands available: brainstorm[\s\S]*implement[\s\S]*fix[\s\S]*explore[\s\S]*verify[\s\S]*dobby/);
  assert.match(CLASSIFICATION_PROMPT, /command:brainstorm/);
  assert.match(CLASSIFICATION_PROMPT, /command:explore/);
  assert.match(CLASSIFICATION_PROMPT, /command:implement/);
  assert.doesNotMatch(CLASSIFICATION_PROMPT, /command:plan\b/);
  assert.doesNotMatch(CLASSIFICATION_PROMPT, /command:build\b/);
  assert.doesNotMatch(CLASSIFICATION_PROMPT, /Commands available: plan/);
});

await runAll();
console.log('');
console.log(`subagent-mode-classifier: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}: ${f.message}`);
  process.exit(1);
}
