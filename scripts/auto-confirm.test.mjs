// Real-interface tests for scripts/auto-confirm.mjs (Stop hook) and
// scripts/auto-confirm-consumer.mjs (UserPromptSubmit hook).
//
// Exercises the queue-file drop + consume contract. No PATH neutering tricks.
// Run: node scripts/auto-confirm.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, 'auto-confirm.mjs');
const CONSUMER = join(__dirname, 'auto-confirm-consumer.mjs');

function runScript(scriptPath, payload, { cwd, env } = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, NO_COLOR: '1', SMELTER_TEST: '1', ...(env || {}) },
  });
}

function makeProject({ hasPending }) {
  const dir = mkdtempSync(join(tmpdir(), 'lh-ac-'));
  const taskDir = join(dir, '.smt', 'features', 'test-feature', 'task');
  mkdirSync(taskDir, { recursive: true });
  if (hasPending) {
    writeFileSync(join(taskDir, 'plan.md'), '# Test Feature\n');
    writeFileSync(join(taskDir, 'task-1.md'), '- [ ] Task 1: do the thing\n');
    writeFileSync(join(taskDir, 'task-2.md'), '- [x] Task 2: done already\n');
  } else {
    writeFileSync(join(taskDir, 'plan.md'), '# Test Feature\n');
    writeFileSync(join(taskDir, 'task-1.md'), '- [x] Task 1: done\n');
  }
  return dir;
}

// Case 1: context-limit stop → always continue
{
  const dir = makeProject({ hasPending: true });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'max_tokens' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'context-limit stop must pass through');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 1 (context-limit) OK');
}

// Case 2a: user abort via user_cancel → continue + interrupt marker
{
  const dir = makeProject({ hasPending: true });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'user_cancel' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'user_cancel must pass through');
  assert.ok(
    existsSync(join(dir, '.smt', 'state', 'last-interrupt.json')),
    'interrupt marker must be written',
  );
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 2a (user_cancel) OK');
}

// Case 2b: user abort via user_aborted (NEW) → continue, no block
{
  const dir = makeProject({ hasPending: true });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'user_aborted' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'user_aborted must pass through');
  assert.ok(!out.decision, 'must NOT block on user_aborted');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 2b (user_aborted) OK');
}

// Case 3: no pending tasks → still block + queue (auto-confirm always fires on session end)
// Haiku/Sonnet reads the forwarded last message on the next prompt to decide if work remains.
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'Here is what I did.' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-none' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'no pending still blocks — model decides on next prompt');
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-none.json');
  assert.ok(existsSync(queuePath), 'queue file dropped even without pending tasks');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 3 (no-pending still forwards) OK');
}

// Case 4: pending + end_turn → block + queue file dropped (NO claude spawn)
{
  const dir = makeProject({ hasPending: true });
  const transcript = [
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: 'Shall I proceed with updating auth.ts?' },
  ];
  const start = Date.now();
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-case4' }, { cwd: dir });
  const elapsed = Date.now() - start;
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'pending task → must block');
  assert.match(out.reason, /\[AUTO-CONFIRM\]/, 'reason must carry AUTO-CONFIRM tag');
  assert.ok(elapsed < 2000, `Stop hook must complete fast (got ${elapsed}ms) — no sub-agent spawn`);

  const queuePath = join(dir, '.smt', 'state', 'queue-sess-case4.json');
  assert.ok(existsSync(queuePath), 'session-scoped queue file must be dropped');
  const queued = JSON.parse(readFileSync(queuePath, 'utf-8'));
  assert.ok(queued.last_message.includes('Shall I proceed'), 'queue must include verbatim last message');
  assert.equal(queued.session_id, 'sess-case4', 'queue must carry session_id');
  assert.ok(Array.isArray(queued.pending_tasks) && queued.pending_tasks.length > 0, 'queue must include pending tasks');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 4 (pending-block + queue drop) OK');
}

// Case 5: autoConfirm disabled via config → continue, no queue drop
{
  const dir = makeProject({ hasPending: true });
  const homeDir = mkdtempSync(join(tmpdir(), 'lh-ac-home-'));
  mkdirSync(join(homeDir, '.smt'), { recursive: true });
  writeFileSync(
    join(homeDir, '.smt', 'config.json'),
    JSON.stringify({ autoConfirm: false }),
  );
  const res = runScript(
    HOOK,
    { cwd: dir, stop_reason: 'end_turn', transcript: [], session_id: 'sess-disabled' },
    { cwd: dir, env: { HOME: homeDir, NO_COLOR: '1' } },
  );
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'autoConfirm=false must allow stop');
  const stateDir = join(dir, '.smt', 'state');
  if (existsSync(stateDir)) {
    const files = readdirSync(stateDir).filter(f => f.startsWith('queue-'));
    assert.equal(files.length, 0, 'disabled autoConfirm must not drop queue file');
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  console.log('  case 5 (disabled-config) OK');
}

// Case 6: consumer reads and deletes queue file, injects additionalContext
{
  const dir = makeProject({ hasPending: true });
  // Seed queue via Stop hook
  runScript(HOOK, {
    cwd: dir,
    session_id: 'sess-6',
    stop_reason: 'end_turn',
    transcript: [{ role: 'assistant', content: 'Shall I continue the migration?' }],
  }, { cwd: dir });
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-6.json');
  assert.ok(existsSync(queuePath), 'precondition: session-scoped queue file exists');

  // Consume with matching session id
  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-6', prompt: 'next step' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(out.hookSpecificOutput, 'consumer must emit hookSpecificOutput');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /AUTO-CONFIRM FORWARD/);
  assert.match(ctx, /Shall I continue the migration/);
  assert.match(ctx, /Pending tasks/);
  assert.ok(!existsSync(queuePath), 'consumer must delete queue file after reading');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 6 (consumer drop+consume) OK');
}

// Case 7: consumer with no queue file → plain continue
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(CONSUMER, { cwd: dir, prompt: 'hi' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'no queue → no additionalContext');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 7 (consumer no-queue) OK');
}

// Case 8: two producers (different sessions) → both payloads survive
{
  const dir = makeProject({ hasPending: true });
  runScript(HOOK, {
    cwd: dir, session_id: 'sess-A',
    stop_reason: 'end_turn',
    transcript: [{ role: 'assistant', content: 'Producer A message' }],
  }, { cwd: dir });
  runScript(HOOK, {
    cwd: dir, session_id: 'sess-B',
    stop_reason: 'end_turn',
    transcript: [{ role: 'assistant', content: 'Producer B message' }],
  }, { cwd: dir });

  const qA = join(dir, '.smt', 'state', 'queue-sess-A.json');
  const qB = join(dir, '.smt', 'state', 'queue-sess-B.json');
  assert.ok(existsSync(qA), 'producer A queue must survive');
  assert.ok(existsSync(qB), 'producer B queue must survive');
  const a = JSON.parse(readFileSync(qA, 'utf-8'));
  const b = JSON.parse(readFileSync(qB, 'utf-8'));
  assert.ok(a.last_message.includes('Producer A'));
  assert.ok(b.last_message.includes('Producer B'));
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 8 (race: two producers both survive) OK');
}

// Case 9: session-A producer, session-B consumer → B must NOT consume A's payload
{
  const dir = makeProject({ hasPending: true });
  runScript(HOOK, {
    cwd: dir, session_id: 'sess-prod',
    stop_reason: 'end_turn',
    transcript: [{ role: 'assistant', content: 'Message for producer session' }],
  }, { cwd: dir });
  const qProd = join(dir, '.smt', 'state', 'queue-sess-prod.json');
  assert.ok(existsSync(qProd), 'precondition: producer queue dropped');

  // Different session consumes — should NOT inject (file for a different session)
  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-other', prompt: 'hi' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'cross-session consumer must NOT inject peer session payload');
  // Producer file preserved for its own session
  assert.ok(existsSync(qProd), 'peer queue must be preserved for its own session');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 9 (session scoping on consume) OK');
}

// Case 10: legacy sid-less queue file younger than 5s → consumer must SKIP + leave intact
{
  const dir = makeProject({ hasPending: true });
  const stateDir = join(dir, '.smt', 'state');
  mkdirSync(stateDir, { recursive: true });
  const legacyPath = join(stateDir, 'auto-confirm-queue.json');
  // sid-less payload, just written → mtime is "now"
  writeFileSync(legacyPath, JSON.stringify({
    timestamp: Date.now(),
    last_message: 'legacy young message',
    pending_tasks: [{ status: 'pending', title: 'x' }],
  }));
  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-consumer', prompt: 'hi' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'young sid-less file must not be consumed');
  assert.ok(existsSync(legacyPath), 'young sid-less file must be preserved on disk');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 10 (legacy young-file skip) OK');
}

// Case 11: legacy sid-less queue file older than 5s → consumer adopts + deletes
{
  const dir = makeProject({ hasPending: true });
  const stateDir = join(dir, '.smt', 'state');
  mkdirSync(stateDir, { recursive: true });
  const legacyPath = join(stateDir, 'auto-confirm-queue.json');
  writeFileSync(legacyPath, JSON.stringify({
    timestamp: Date.now(),
    last_message: 'legacy old message',
    pending_tasks: [{ status: 'pending', title: 'x' }],
  }));
  // Backdate mtime to 10s ago via utimes
  const { utimesSync } = await import('node:fs');
  const past = (Date.now() - 10_000) / 1000;
  utimesSync(legacyPath, past, past);

  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-consumer', prompt: 'hi' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(out.hookSpecificOutput, 'old sid-less file must be adopted');
  assert.match(out.hookSpecificOutput.additionalContext, /legacy old message/);
  assert.ok(!existsSync(legacyPath), 'adopted legacy file must be deleted');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 11 (legacy old-file adopted) OK');
}

console.log('auto-confirm: OK');
