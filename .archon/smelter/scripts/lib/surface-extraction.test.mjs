#!/usr/bin/env node
/**
 * surface-extraction.test.mjs — RED tests for parseSlashArgs, validateSurfaceFields, mergeSurface.
 *
 * Written FIRST per TDD. Module does not yet exist — every case must fail with
 * ERR_MODULE_NOT_FOUND until T1 lands. After T1-3 (parseSlashArgs), T1-4 (validator),
 * T1-5 (merge) are implemented, these tests turn GREEN one-by-one.
 *
 * Distribution: happy=6, boundary=4, error=4, edge=5, integration=2 (total 21 ≥ 10).
 */
import assert from 'node:assert/strict';

const tests = [];
function test(label, fn) { tests.push({ label, fn }); }
let passed = 0, failed = 0;
const failures = [];

async function runAll() {
  for (const { label, fn } of tests) {
    try { await fn(); passed++; console.log(`  PASS  ${label}`); }
    catch (err) { failed++; failures.push({ label, message: err.message });
      console.log(`  FAIL  ${label}\n        ${err.message}`); }
  }
}

async function mod() {
  return import('./surface-extraction.mjs?' + Date.now());
}

// ─────────────────────────────── parseSlashArgs ────────────────────────────────

test('TDD-1 parseSlashArgs(fix, "typo foo") → target_type=text + both exempts [happy]', async () => {
  const { parseSlashArgs } = await mod();
  const r = parseSlashArgs('fix', 'typo foo');
  assert.equal(r.target_type, 'text');
  assert.deepEqual(r.exempt, { tdd: true, e2e: true });
});

test('TDD-2 parseSlashArgs(fix, "typos correct these") plural form matches [happy]', async () => {
  const { parseSlashArgs } = await mod();
  const r = parseSlashArgs('fix', 'typos correct these');
  assert.equal(r.target_type, 'text');
});

test('TDD-3 parseSlashArgs(fix, "typo and also css fix") first-wins + union [edge]', async () => {
  const { parseSlashArgs } = await mod();
  const r = parseSlashArgs('fix', 'typo and also css fix');
  assert.equal(r.target_type, 'text');              // first-match-wins (text before design)
  assert.equal(r.exempt.tdd, true);                 // union with css (design) row
  assert.equal(r.exempt.e2e, true);                 // kept from text row (union not overwrite)
});

test('TDD-4 parseSlashArgs(fix, "") → null [boundary]', async () => {
  const { parseSlashArgs } = await mod();
  assert.equal(parseSlashArgs('fix', ''), null);
});

test('TDD-5 parseSlashArgs(brainstorm, "anything") → null for non-scoped modes [boundary]', async () => {
  const { parseSlashArgs } = await mod();
  assert.equal(parseSlashArgs('brainstorm', 'anything'), null);
  assert.equal(parseSlashArgs('investigate', 'foo'), null);
  assert.equal(parseSlashArgs('verify', 'bar'), null);
});

test('TDD-6 parseSlashArgs(implement, "add-to auth") punctuation-joined matches [edge]', async () => {
  const { parseSlashArgs } = await mod();
  const r = parseSlashArgs('implement', 'add-to auth');
  assert.equal(r.skip_brainstorm, true);
});

test('TDD-7 parseSlashArgs(fix, "오타 있음") space-separated Korean matches [happy]', async () => {
  const { parseSlashArgs } = await mod();
  const r = parseSlashArgs('fix', '오타 있음');
  assert.equal(r.target_type, 'text');
});

test('parseSlashArgs(fix, "디자인 바꿔") Korean design keyword → target_type=design [happy]', async () => {
  const { parseSlashArgs, mergeSurface } = await mod();
  const r = parseSlashArgs('fix', '디자인 바꿔');
  assert.equal(r.target_type, 'design');
  assert.equal(r.exempt.tdd, true);
  // parseSlashArgs sets e2e only via union (true stays true); design row's e2e=false
  // is inherited via mergeSurface against mode default_exempt.
  const merged = mergeSurface(r, { default_exempt: { tdd: false, e2e: false } });
  assert.equal(merged.exempt.e2e, false);
});

test('parseSlashArgs(fix, "css tweak") → target_type=design [happy]', async () => {
  const { parseSlashArgs } = await mod();
  const r = parseSlashArgs('fix', 'css tweak');
  assert.equal(r.target_type, 'design');
  assert.equal(r.exempt.tdd, true);
});

test('TDD-8 parseSlashArgs(fix, "오타는 수정") particle-attached → null (parity) [edge]', async () => {
  const { parseSlashArgs } = await mod();
  assert.equal(parseSlashArgs('fix', '오타는 수정'), null);
});

test('parseSlashArgs(fix, undefined) no-crash [error]', async () => {
  const { parseSlashArgs } = await mod();
  assert.doesNotThrow(() => parseSlashArgs('fix', undefined));
  assert.equal(parseSlashArgs('fix', undefined), null);
});

test('parseSlashArgs(fix, null) no-crash [error]', async () => {
  const { parseSlashArgs } = await mod();
  assert.doesNotThrow(() => parseSlashArgs('fix', null));
  assert.equal(parseSlashArgs('fix', null), null);
});

test('parseSlashArgs(fix, "dialogue copy") → target_type=text (dialogue collapsed into text) [happy]', async () => {
  const { parseSlashArgs } = await mod();
  const r = parseSlashArgs('fix', 'dialogue copy');
  assert.equal(r.target_type, 'text');
});

test('parseSlashArgs(implement, "extend the auth module") → skip_brainstorm [happy]', async () => {
  const { parseSlashArgs } = await mod();
  const r = parseSlashArgs('implement', 'extend the auth module');
  assert.equal(r.skip_brainstorm, true);
});

test('parseSlashArgs(implement, "add auth to db") non-consecutive add/to → no match [edge]', async () => {
  const { parseSlashArgs } = await mod();
  const r = parseSlashArgs('implement', 'add auth to db');
  assert.ok(!r || r.skip_brainstorm !== true, 'non-consecutive tokens must not trigger add-to');
});

// ────────────────────────────── validateSurfaceFields ──────────────────────────

test('TDD-9 validateSurfaceFields drops out-of-enum target_type [error]', async () => {
  const { validateSurfaceFields } = await mod();
  const r = validateSurfaceFields({ mode: 'fix', target_type: 'style_change', schema_version: 2 });
  assert.equal(r.target_type, null);
});

test('TDD-10 validateSurfaceFields drops non-boolean exempt values [error]', async () => {
  const { validateSurfaceFields } = await mod();
  const r = validateSurfaceFields({ mode: 'fix', exempt: { tdd: 'true', e2e: 1 }, schema_version: 2 });
  assert.equal(r.exempt, null);
});

test('validateSurfaceFields missing schema_version drops all surface [error]', async () => {
  const { validateSurfaceFields } = await mod();
  const r = validateSurfaceFields({ mode: 'fix', target_type: 'text', exempt: { tdd: true } });
  assert.equal(r.target_type, null);
  assert.equal(r.exempt, null);
  assert.equal(r.skip_brainstorm, false);
});

test('validateSurfaceFields with valid v2 input passes through [happy]', async () => {
  const { validateSurfaceFields } = await mod();
  const r = validateSurfaceFields({
    mode: 'fix', schema_version: 2,
    target_type: 'text', exempt: { tdd: true, e2e: true }, skip_brainstorm: false,
  });
  assert.equal(r.target_type, 'text');
  assert.deepEqual(r.exempt, { tdd: true, e2e: true });
});

test('validateSurfaceFields drops legacy typo/dialogue [error]', async () => {
  const { validateSurfaceFields } = await mod();
  for (const legacy of ['typo', 'dialogue']) {
    const r = validateSurfaceFields({ mode: 'fix', schema_version: 2, target_type: legacy });
    assert.equal(r.target_type, null, `legacy target_type ${legacy} must be dropped`);
  }
});

// ─────────────────────────────── mergeSurface ──────────────────────────────────

test('TDD-11 mergeSurface with empty surface inherits default_exempt [boundary]', async () => {
  const { mergeSurface } = await mod();
  const r = mergeSurface({}, { default_exempt: { tdd: false, e2e: false } });
  assert.deepEqual(r.exempt, { tdd: false, e2e: false });
});

test('TDD-18 mergeSurface shallow-merges partial exempt per-field [boundary]', async () => {
  const { mergeSurface } = await mod();
  const r = mergeSurface(
    { exempt: { tdd: true } },
    { default_exempt: { tdd: false, e2e: false } }
  );
  assert.equal(r.exempt.tdd, true);   // from surface
  assert.equal(r.exempt.e2e, false);  // from default — NOT overwritten by partial
});

test('mergeSurface returns fresh object (immutability) [edge]', async () => {
  const { mergeSurface } = await mod();
  const surface = { exempt: { tdd: true, e2e: true } };
  const cfg = { default_exempt: { tdd: false, e2e: false } };
  const r = mergeSurface(surface, cfg);
  r.exempt.tdd = false;
  assert.equal(surface.exempt.tdd, true, 'original surface must not be mutated');
});

// ─────────────────────────────── integration ───────────────────────────────────

test('parse → validate → merge chain for /fix typo → text [integration]', async () => {
  const { parseSlashArgs, mergeSurface } = await mod();
  const parsed = parseSlashArgs('fix', 'typo bar');
  const merged = mergeSurface(parsed, { default_exempt: { tdd: false, e2e: false } });
  assert.equal(merged.target_type, 'text');
  assert.equal(merged.exempt.tdd, true);
  assert.equal(merged.exempt.e2e, true);
});

test('LLM classify → validate → merge chain [integration]', async () => {
  const { validateSurfaceFields, mergeSurface } = await mod();
  const classifier = {
    mode: 'fix', schema_version: 2,
    target_type: 'bug_fix', exempt: null, skip_brainstorm: false,
  };
  const validated = validateSurfaceFields(classifier);
  const merged = mergeSurface(validated, { default_exempt: { tdd: false, e2e: false } });
  assert.equal(merged.target_type, 'bug_fix');
  assert.deepEqual(merged.exempt, { tdd: false, e2e: false });
});

// ─────────────────────────────── run ───────────────────────────────────────────

await runAll();
console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) {
  for (const f of failures) console.log(` - ${f.label}: ${f.message}`);
  process.exit(1);
}
