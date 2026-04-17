// Real-interface tests for scripts/auto-confirm.mjs (Stop hook) and
// scripts/auto-confirm-consumer.mjs (UserPromptSubmit hook).
//
// Exercises the queue-file drop + consume contract. No PATH neutering tricks.
// Run: node scripts/auto-confirm.test.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, 'auto-confirm.mjs');
const CONSUMER = join(__dirname, 'auto-confirm-consumer.mjs');
const SETTINGS_PATH = '/Users/yusang/smelter/settings.json';
const CLASSIFIER_PATH = HOOK.replace('auto-confirm.mjs', 'lib/subagent-classifier.mjs');

function readSettingsModel() {
  return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).model;
}

const originalSettingsModel = readSettingsModel();
process.on('exit', () => {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  settings.model = originalSettingsModel;
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
});

function setSettingsModel(model) {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  settings.model = model;
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

function inspectClassifierModel(settingsModel) {
  return spawnSync(process.execPath, ['-e', `
    import { inspectClassifierModel } from ${JSON.stringify(CLASSIFIER_PATH)};
    process.stdout.write(inspectClassifierModel(process.env.TEST_SETTINGS_MODEL));
  `], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      TEST_SETTINGS_MODEL: settingsModel,
    },
  }).stdout.trim();
}

function runScript(scriptPath, payload, { cwd, env } = {}) {
  const res = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, NO_COLOR: '1', SMELTER_TEST: '1', ...(env || {}) },
  });
  if (res.status !== 0) {
    throw new Error(`script failed: ${scriptPath}\nstatus=${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  }
  return res;
}

function runModelClassifier(prompt, { cwd, sessionId = 'test-session', env } = {}) {
  return spawnSync(process.execPath, ['-e', `
    import { classifyPrompt } from ${JSON.stringify(CLASSIFIER_PATH)};
    const result = classifyPrompt(${JSON.stringify('__PROMPT__')}.replace('__PROMPT__', process.env.TEST_PROMPT), { cwd: process.env.TEST_CWD, sessionId: process.env.TEST_SESSION_ID });
    process.stdout.write(JSON.stringify(result));
  `], {
    encoding: 'utf-8',
    cwd,
    env: {
      ...process.env,
      NO_COLOR: '1',
      SMELTER_TEST: '1',
      TEST_PROMPT: prompt,
      TEST_CWD: cwd || process.cwd(),
      TEST_SESSION_ID: sessionId,
      ...(env || {}),
    },
  });
}

function writeAutoConfirmStub(result) {
  const stubPath = join(tmpdir(), `smelter-auto-confirm-stub-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(stubPath, `export function classifyAutoConfirm(){ return ${JSON.stringify(result)}; }\n`);
  return stubPath;
}

function runAutoConfirmClassifier(messages, { cwd, sessionId = 'test-session', env } = {}) {
  return spawnSync(process.execPath, ['-e', `
    import { classifyAutoConfirm } from ${JSON.stringify(CLASSIFIER_PATH)};
    const result = classifyAutoConfirm(JSON.parse(process.env.TEST_MESSAGES), { cwd: process.env.TEST_CWD, sessionId: process.env.TEST_SESSION_ID });
    process.stdout.write(JSON.stringify(result));
  `], {
    encoding: 'utf-8',
    cwd,
    env: {
      ...process.env,
      NO_COLOR: '1',
      SMELTER_TEST: '1',
      TEST_MESSAGES: JSON.stringify(messages),
      TEST_CWD: cwd || process.cwd(),
      TEST_SESSION_ID: sessionId,
      ...(env || {}),
    },
  });
}

function parseJson(stdout, stderr = '') {
  const text = stdout.trim();
  if (!text) {
    throw new Error(`expected JSON stdout but got empty output. stderr=${stderr}`);
  }
  return JSON.parse(text);
}

assert.equal(inspectClassifierModel('claude-opus-4-6'), 'haiku', 'expected Claude-family main model to keep haiku classifier');
assert.equal(inspectClassifierModel('gpt-5.4'), 'gpt-5.4-mini', 'expected Codex-family main model to use gpt-5.4-mini classifier');
assert.equal(inspectClassifierModel('o4-mini'), 'gpt-5.4-mini', 'expected o-series main model to use gpt-5.4-mini classifier');

{
  const dir = mkdtempSync(join(tmpdir(), 'lh-ac-classifier-'));
  const stubPath = writeAutoConfirmStub({ action: 'continue', reason: 'offered next steps', prompt: '다음 제안된 작업을 즉시 수행하라' });
  const res = runAutoConfirmClassifier(['원하면 다음 중 하나로 이어가겠다.'], {
    cwd: dir,
    sessionId: 'sess-ac-classifier',
    env: {
      SMELTER_AUTO_CONFIRM_CLASSIFIER_MODULE: stubPath,
      SMELTER_AUTO_CONFIRM_MESSAGES: JSON.stringify(['원하면 다음 중 하나로 이어가겠다.']),
    },
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.action, 'continue');
  assert.match(out.prompt, /즉시 수행하라/);
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = mkdtempSync(join(tmpdir(), 'lh-ac-classifier-'));
  const stubPath = writeAutoConfirmStub({ action: 'risk_review', reason: 'ambiguous wrap-up', prompt: '남은 리스크 해결 및 테스트 및 검토 하라' });
  const res = runAutoConfirmClassifier(['정리했다.'], {
    cwd: dir,
    sessionId: 'sess-ac-risk-review',
    env: {
      SMELTER_AUTO_CONFIRM_CLASSIFIER_MODULE: stubPath,
      SMELTER_AUTO_CONFIRM_MESSAGES: JSON.stringify(['정리했다.']),
    },
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.action, 'risk_review');
  assert.equal(out.prompt, '남은 리스크 해결 및 테스트 및 검토 하라');
  rmSync(dir, { recursive: true, force: true });
}

setSettingsModel(originalSettingsModel);

setSettingsModel(originalSettingsModel);

function makeProject({ hasPending, sessionId = 'test-session', otherSessionHasPending = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'lh-ac-'));
  const stateRoot = join(dir, '.smt', 'state');
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(join(stateRoot, `active-feature-${sessionId}.json`), JSON.stringify({ slug: 'test-feature' }));

  const taskDir = join(dir, '.smt', 'features', 'test-feature', 'task');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'plan.md'), '# Test Feature\n');
  if (hasPending) {
    writeFileSync(join(taskDir, 'task-1.md'), '- [ ] Task 1: do the thing\n- [ ] Task 1b: verify CLI output\n');
    writeFileSync(join(taskDir, 'task-2.md'), '- [x] Task 2: done already\n');
  } else {
    writeFileSync(join(taskDir, 'task-1.md'), '- [x] Task 1: done\n');
  }

  const otherTaskDir = join(dir, '.smt', 'features', 'other-feature', 'task');
  mkdirSync(otherTaskDir, { recursive: true });
  writeFileSync(join(otherTaskDir, 'plan.md'), '# Other Feature\n');
  writeFileSync(
    join(otherTaskDir, 'task-1.md'),
    otherSessionHasPending ? '- [ ] Other session pending task\n' : '- [x] Other session done\n',
  );

  return dir;
}

// Case 1: context-limit stop → always continue
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'max_tokens' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'context-limit stop must pass through');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 1 (context-limit) OK');
}

// Case 2a: user abort via user_cancel → continue + interrupt marker
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
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
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'user_aborted' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'user_aborted must pass through');
  assert.ok(!out.decision, 'must NOT block on user_aborted');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 2b (user_aborted) OK');
}

// Case 3a: no pending + non-question completion message → allow stop
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'Done. All changes pushed.' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-none' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'completed non-question turn should allow stop');
  assert.ok(!out.decision, 'completed non-question turn must not block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 3a (no-pending completion stops) OK');
}

// Case 3a-2: wrap-up language without actionable next step → allow stop
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'Summary: I wrapped up the investigation and documented the result.' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-wrapup' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'wrap-up language with no pending work should allow stop');
  assert.ok(!out.decision, 'wrap-up language with no pending work must not block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 3a-2 (wrap-up stops cleanly) OK');
}

// Case 3a-3: explicit user question should still auto-confirm
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'Which approach do you prefer for the auto-confirm classifier?' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-ask-user' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'user-question turns should still block for follow-up');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 3a-3 (ask-user still auto-confirms) OK');
}

// Case 3a-4: repeated empty completion loops should stop when nothing is actionable
{
  const dir = makeProject({ hasPending: false });
  const transcript = [
    { role: 'assistant', content: 'Done.' },
    { role: 'assistant', content: 'Complete.' },
    { role: 'assistant', content: 'Stopped.' },
  ];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-empty-loop' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'empty completion loop should allow stop');
  assert.ok(!out.decision, 'empty completion loop must not block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 3a-4 (empty completion loop stops) OK');
}

// Case 3a-5: self-commitment should still auto-confirm even with no pending checklist items
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'I will now update the remaining hook logic.' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-self-commit' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'self-commitment should still continue automatically');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 3a-5 (self-commitment still auto-confirms) OK');
}

// Case 3a-4: queue redirect still wins over default auto-confirm
{
  const dir = makeProject({ hasPending: false });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'queue',
    timestamp: Date.now(),
    queued_intent: 'run queued follow-up',
    session_id: 'sess-queue-stop',
  }, null, 2));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [], session_id: 'sess-queue-stop' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'queued redirect should still block');
  assert.match(out.reason, /\[QUEUED REDIRECT\]/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 3a-4 (queue redirect still wins) OK');
}

// Case 3b: no pending + confirmation question → direct block with no queue
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'Tests written. Shall I proceed with implementation?' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-q' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'confirmation question triggers direct auto-confirm');
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-q.json');
  assert.ok(!existsSync(queuePath), 'direct mode must not write a queue file for confirmation questions');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 3b (no-pending, confirmation-question) OK');
}

// Case 4: pending + end_turn → direct block with exact session task payload, still fast
{
  const dir = makeProject({ hasPending: true, sessionId: 'sess-case4', otherSessionHasPending: true });
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
  assert.match(out.reason, /Task 1: do the thing/);
  assert.match(out.reason, /Task 1b: verify CLI output/);
  assert.doesNotMatch(out.reason, /Other session pending task/);
  assert.ok(elapsed < 2000, `Stop hook must complete fast (got ${elapsed}ms) — no sub-agent spawn`);
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-case4.json');
  assert.ok(!existsSync(queuePath), 'direct mode must not persist queue files for pending work');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 4 (pending-block direct mode) OK');
}


// Case 5: autoConfirm disabled via config → continue, no queue drop
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
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

// Case 6: direct stop-hook mode must not write a queue file
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, {
    cwd: dir,
    session_id: 'sess-6',
    stop_reason: 'end_turn',
    transcript: [{ role: 'assistant', content: 'Shall I continue the migration?' }],
  }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-6.json');
  assert.ok(!existsSync(queuePath), 'direct stop-hook mode must not persist queue files');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 6 (no queue file in direct mode) OK');
}

// Case 7: consumer stays inert without a queue signal
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(CONSUMER, { cwd: dir, prompt: 'hi', session_id: 'sess-none' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'consumer should not inject context without a queue signal');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 7 (consumer inert) OK');
}

// Case 7b: consumer immediately redirects queued intent for same session
{
  const dir = makeProject({ hasPending: false });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'queue',
    timestamp: Date.now(),
    queued_intent: 'run queued follow-up',
    session_id: 'sess-queue-now',
  }, null, 2));
  const res = runScript(CONSUMER, { cwd: dir, prompt: 'hi', session_id: 'sess-queue-now' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.additionalContext, 'run queued follow-up');
  assert.ok(!existsSync(join(dir, '.smt', 'state', 'cancel-signal.json')), 'queue signal should be consumed');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 7b (consumer queued redirect) OK');
}

// Case 8: no queue files are written across repeated stop-hook invocations
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
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

  const stateDir = join(dir, '.smt', 'state');
  const queueFiles = existsSync(stateDir)
    ? readdirSync(stateDir).filter(name => name.startsWith('queue-') || name === 'auto-confirm-queue.json')
    : [];
  assert.deepEqual(queueFiles, [], 'direct stop-hook mode must not leave queue files behind');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 8 (no queue files after repeated stops) OK');
}

// Case 9: direct mode should use recent Claude turns from the same transcript only
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, {
    cwd: dir,
    session_id: 'sess-direct-history',
    stop_reason: 'end_turn',
    transcript: [
      { role: 'assistant', content: 'I inspected the hook flow first.' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'I updated the queue writer.' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'I will now finish the stop logic.' },
    ],
  }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'direct mode should still continue actionable work');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 9 (direct mode uses transcript history) OK');
}

// Case 10: legacy queue file remains ignored
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const stateDir = join(dir, '.smt', 'state');
  mkdirSync(stateDir, { recursive: true });
  const legacyPath = join(stateDir, 'auto-confirm-queue.json');
  writeFileSync(legacyPath, JSON.stringify({
    timestamp: Date.now(),
    last_message: 'legacy message',
    pending_tasks: [{ status: 'pending', title: 'x' }],
  }));
  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-consumer', prompt: 'continue' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'consumer should ignore legacy queue files');
  assert.ok(existsSync(legacyPath), 'legacy queue file should be left untouched');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 10 (legacy queue ignored) OK');
}

// Case 11: unrelated prompt remains a plain no-op for the consumer without queue signal
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-unrelated', prompt: 'Templates랑 dashboard에서 로딩 flicker 고쳐줘' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'consumer should remain inactive without queue signal');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 11 (consumer stays inactive) OK');
}

// Case 12: repeated wrap-up language still auto-confirms
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, {
    cwd: dir,
    session_id: 'sess-wrapup-direct',
    stop_reason: 'end_turn',
    transcript: [
      { role: 'assistant', content: 'Summary: I inspected the hook and identified the cause.' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'Summary: I outlined the changes and no further concrete action remains.' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'Summary: I wrapped up the investigation and documented the result.' },
    ],
  }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'repeated wrap-up language with no more work should stop cleanly');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12 (direct wrap-up stops cleanly) OK');
}

// Case 12b: hard user abort still bypasses always-on auto-confirm
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'interrupt', transcript: [], session_id: 'sess-hard-abort' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'user abort must still pass through');
  assert.ok(!out.decision, 'user abort must not block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12b (user abort bypass) OK');
}

// Case 12c: context-limit still bypasses always-on auto-confirm
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'max_tokens', transcript: [], session_id: 'sess-context-limit' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'context-limit must still pass through');
  assert.ok(!out.decision, 'context-limit must not block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12c (context-limit bypass) OK');
}

// Case 12d: disabled config still bypasses always-on auto-confirm
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const homeDir = mkdtempSync(join(tmpdir(), 'lh-ac-home-disabled-'));
  mkdirSync(join(homeDir, '.smt'), { recursive: true });
  writeFileSync(join(homeDir, '.smt', 'config.json'), JSON.stringify({ autoConfirm: false }));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [], session_id: 'sess-disabled' }, { cwd: dir, env: { HOME: homeDir, NO_COLOR: '1' } });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'disabled config must still bypass auto-confirm');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  console.log('  case 12d (disabled config bypass) OK');
}

// Case 12e: hard cancel signal still bypasses always-on auto-confirm
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'hard',
    timestamp: Date.now(),
    session_id: 'sess-hard-cancel',
  }, null, 2));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [], session_id: 'sess-hard-cancel' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'hard cancel signal must pass through');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12e (hard cancel bypass) OK');
}

// Case 12f: empty transcript with no actionable work should allow stop
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [], session_id: 'sess-empty' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'empty transcript with no actionable work should allow stop');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12f (empty transcript stops cleanly) OK');
}

// Case 12f-2: empty transcript with pending work should still auto-confirm
{
  const dir = makeProject({ hasPending: true, sessionId: 'sess-empty-pending' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [], session_id: 'sess-empty-pending' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'pending work should still block even without transcript');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12f-2 (empty transcript + pending still auto-confirms) OK');
}

// Case 12f-3: explicit no-more-work message should allow stop
{
  const dir = makeProject({ hasPending: false, sessionId: 'sess-no-more-work' });
  const transcript = [{ role: 'assistant', content: '더 이상 진행할게 없습니다.' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-no-more-work' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'no-more-work response should allow stop');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12f-3 (no-more-work stops cleanly) OK');
}

// Case 12f-3b: explicit no-more-work message with pending tasks should still stop to avoid loops
{
  const dir = makeProject({ hasPending: true, sessionId: 'sess-no-more-work-pending' });
  const transcript = [{ role: 'assistant', content: '없다. 더 진행할게 없다.' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-no-more-work-pending' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'explicit no-more-work response should override pending-task auto-confirm');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12f-3b (no-more-work suppresses loop) OK');
}

// Case 12f-4: explicit stop-ready message should allow stop
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: '더 진행할 작업 없음.' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-stop-ready' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'stop-ready response should allow stop');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12f-4 (stop-ready stops cleanly) OK');
}

// Case 12g: current step gate pause language still auto-confirms
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: '현재 상태를 정리했습니다. 이 범위로 진행할까요?' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-gate-language' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'gate-like approval language must still auto-confirm');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12g (gate language still auto-confirms) OK');
}

// Case 12h: no .smt directory + done message should allow stop
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-ac-nosmt-'));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-no-smt' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'done message with no .smt should allow stop');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12h (no .smt stops cleanly) OK');
}

// Case 12h-2: no .smt directory + self-commitment should still auto-confirm
{
  const dir = mkdtempSync(join(tmpdir(), 'lh-ac-nosmt-'));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'I will continue with the hook refactor.' }], session_id: 'sess-no-smt-continue' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'self-commitment should still auto-confirm without .smt');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12h-2 (no .smt self-commitment still auto-confirms) OK');
}

// Case 12i: user_requested flag still bypasses always-on auto-confirm
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, user_requested: true, stop_reason: 'end_turn', transcript: [], session_id: 'sess-user-requested' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'user_requested flag must pass through');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12i (user_requested bypass) OK');
}

// Case 12j: user_aborted still bypasses always-on auto-confirm
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'user_aborted', transcript: [], session_id: 'sess-user-aborted' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'user_aborted must pass through');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12j (user_aborted bypass) OK');
}

// Case 12k: queued redirect takes precedence over always-on default block
{
  const dir = makeProject({ hasPending: false });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'queue',
    timestamp: Date.now(),
    queued_intent: 'switch to queued work',
    session_id: 'sess-queued-precedence',
  }, null, 2));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-queued-precedence' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /switch to queued work/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12k (queued redirect precedence) OK');
}

// Case 12l: normal generic reply with no actionable work should allow stop
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: '알겠습니다.' }], session_id: 'sess-generic' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'generic non-actionable replies should allow stop');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12l (generic reply stops cleanly) OK');
}

// Case 12m: stopReason alias should also allow stop on done message
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stopReason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-stopReason' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'stopReason alias should allow stop for done message');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12m (stopReason alias stops cleanly) OK');
}

// Case 12m-2: stopReason alias should still auto-confirm on self-commitment
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stopReason: 'end_turn', transcript: [{ role: 'assistant', content: 'I will continue with the remaining verification.' }], session_id: 'sess-stopReason-continue' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'stopReason alias should still auto-confirm on self-commitment');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12m-2 (stopReason alias self-commitment auto-confirms) OK');
}

// Case 12n: foreign-session queue signal should not bypass current session stop
{
  const dir = makeProject({ hasPending: false });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'queue',
    timestamp: Date.now(),
    queued_intent: 'other session only',
    session_id: 'other-session',
  }, null, 2));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-current' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'foreign-session queue signal should not force current session to continue');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12n (foreign queue signal ignored) OK');
}

// Case 12o: no transcript field with no actionable work should allow stop
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', session_id: 'sess-no-transcript' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'missing transcript with no work should allow stop');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12o (missing transcript stops cleanly) OK');
}

// Case 12p: messages alias should also allow stop on done message
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', messages: [{ role: 'assistant', content: 'Done via messages alias.' }], session_id: 'sess-messages' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'messages alias should allow stop for done message');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12p (messages alias stops cleanly) OK');
}

// Case 12q: queue signal without intent should not force continuation by itself
{
  const dir = makeProject({ hasPending: false });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'queue',
    timestamp: Date.now(),
    session_id: 'sess-queue-no-intent',
  }, null, 2));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-queue-no-intent' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'queue signal without intent should allow stop when there is no actionable work');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12q (queue-without-intent stops cleanly) OK');
}

// Case 12q-2: queue signal without intent still blocks if pending work exists
{
  const dir = makeProject({ hasPending: true, sessionId: 'sess-queue-no-intent-pending' });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'queue',
    timestamp: Date.now(),
    session_id: 'sess-queue-no-intent-pending',
  }, null, 2));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [], session_id: 'sess-queue-no-intent-pending' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'pending work should still block even when queue intent is missing');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12q-2 (queue-without-intent + pending still blocks) OK');
}

// Case 12r: userRequested alias still bypasses always-on auto-confirm
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, userRequested: true, stop_reason: 'end_turn', transcript: [], session_id: 'sess-userRequested' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'userRequested alias must pass through');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12r (userRequested alias bypass) OK');
}

// Case 12s: endTurnReason context_limit alias still bypasses always-on auto-confirm
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, endTurnReason: 'context_limit', transcript: [], session_id: 'sess-endTurnReason' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'endTurnReason context_limit must pass through');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12s (endTurnReason context-limit bypass) OK');
}

// Case 12t: explicit Korean approval question still auto-confirms
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: '현재 상태입니다. 이 범위로 진행할까요?' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-korean-question' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'Korean approval question must still auto-confirm');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12t (Korean approval question auto-confirms) OK');
}

// Case 12u: repeated generic completion history with no actionable work should allow stop
{
  const dir = makeProject({ hasPending: false });
  const transcript = [
    { role: 'assistant', content: '정리했습니다.' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: '마무리했습니다.' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: '문서화했습니다.' },
  ];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-generic-history' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'generic repeated completion history should allow stop');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12u (generic history stops cleanly) OK');
}

// Case 12v: missing session id should still allow stop on done message
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }] }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'missing session id should allow stop for done message');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12v (missing session id stops cleanly) OK');
}

// Case 12v-2: missing session id with self-commitment should still auto-confirm
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'I will continue with the remaining task.' }] }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'missing session id should still auto-confirm on self-commitment');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12v-2 (missing session id self-commitment auto-confirms) OK');
}

// Case 12w: user abort exact cancel still bypasses
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'cancel', transcript: [], session_id: 'sess-cancel' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'cancel must pass through');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12w (cancel bypass) OK');
}

// Case 12x: user abort manual_stop still bypasses
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'manual_stop', transcript: [], session_id: 'sess-manual-stop' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'manual_stop must pass through');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12x (manual_stop bypass) OK');
}

// Case 12y: context_window alias still bypasses
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'context_window', transcript: [], session_id: 'sess-context-window' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'context_window must pass through');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12y (context_window bypass) OK');
}

// Case 12z: no cwd falls back to process cwd and still allows stop on done message
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-no-cwd' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'cwd fallback should still allow stop for done message');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12z (cwd fallback stops cleanly) OK');
}

// Case 12aa: pending tasks still auto-confirm as before
{
  const dir = makeProject({ hasPending: true, sessionId: 'sess-pending-still' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-pending-still' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'pending tasks should still auto-confirm');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12aa (pending tasks still auto-confirms) OK');
}

// Case 12ab: no pending + empty assistant content should allow stop
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: '' }], session_id: 'sess-empty-content' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'empty assistant content should allow stop when no work is actionable');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ab (empty content stops cleanly) OK');
}

// Case 12ac: generic transcript noise with non-actionable final assistant turn should allow stop
{
  const dir = makeProject({ hasPending: false });
  const transcript = [
    { role: 'assistant', content: 'first' },
    { role: 'user', content: 'noise' },
    { role: 'assistant', content: 'second' },
  ];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-noise' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'generic non-actionable final assistant turn should allow stop');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ac (generic final turn stops cleanly) OK');
}

// Case 12ac-2: final self-commitment in noisy transcript should still auto-confirm
{
  const dir = makeProject({ hasPending: false });
  const transcript = [
    { role: 'assistant', content: 'first' },
    { role: 'user', content: 'noise' },
    { role: 'assistant', content: 'I will continue with the final fix.' },
  ];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-noise-continue' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'final self-commitment in noisy transcript should still auto-confirm');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ac-2 (noisy final self-commitment auto-confirms) OK');
}

// Case 12ad: queued redirect with pending tasks still uses queued intent
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'queue',
    timestamp: Date.now(),
    queued_intent: 'queued beats pending',
    session_id: 'sess-queue-pending',
  }, null, 2));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-queue-pending' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /queued beats pending/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ad (queued redirect beats pending) OK');
}

// Case 12ae: missing stop_reason should still allow stop on done message
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-no-stop-reason' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'missing stop_reason should allow stop for done message');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ae (missing stop_reason stops cleanly) OK');
}

// Case 12af: pending tasks with no transcript still auto-confirms
{
  const dir = makeProject({ hasPending: true, sessionId: 'sess-pending-no-transcript' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', session_id: 'sess-pending-no-transcript' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'pending tasks with no transcript must still auto-confirm');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12af (pending no transcript auto-confirms) OK');
}

// Case 12ag: one wrap-up turn in history with non-actionable final turn should allow stop
{
  const dir = makeProject({ hasPending: false });
  const transcript = [
    { role: 'assistant', content: 'Summary: wrapped up the investigation.' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'Done.' },
  ];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-single-wrapup' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'single wrap-up history with non-actionable final turn should allow stop');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ag (single wrap-up stops cleanly) OK');
}

// Case 12ah: no assistant messages and no pending work should allow stop
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'user', content: 'hi' }], session_id: 'sess-no-assistant' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'no assistant messages with no pending work should allow stop');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ah (no assistant stops cleanly) OK');
}

// Case 12ah-2: no assistant messages with pending work should still auto-confirm
{
  const dir = makeProject({ hasPending: true, sessionId: 'sess-no-assistant-pending' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'user', content: 'hi' }], session_id: 'sess-no-assistant-pending' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'pending work should still auto-confirm even without assistant messages');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ah-2 (no assistant + pending still auto-confirms) OK');
}

// Case 12ai: question mark-less self commitment still auto-confirms
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Next I will continue with the queued workflow.' }], session_id: 'sess-self-commit-2' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ai (self-commitment still auto-confirms) OK');
}

// Case 12aj: alternate directory key should still allow stop on done message
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { directory: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-directory-key' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12aj (directory key stops cleanly) OK');
}

// Case 12aj-2: alternate directory key should still auto-confirm on self-commitment
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { directory: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'I will continue with the remaining work.' }], session_id: 'sess-directory-key-continue' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12aj-2 (directory key self-commitment auto-confirms) OK');
}

// Case 12ak: queue redirect clears signal and blocks
{
  const dir = makeProject({ hasPending: false });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'queue',
    timestamp: Date.now(),
    queued_intent: 'clear me',
    session_id: 'sess-clear-queue',
  }, null, 2));
  runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-clear-queue' }, { cwd: dir });
  assert.ok(!existsSync(join(dir, '.smt', 'state', 'cancel-signal.json')), 'queue signal should clear on stop hook queued redirect');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ak (queue signal cleared) OK');
}

// Case 12al: hard cancel clears signal and passes through
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'hard',
    timestamp: Date.now(),
    session_id: 'sess-clear-hard',
  }, null, 2));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-clear-hard' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!existsSync(join(dir, '.smt', 'state', 'cancel-signal.json')), 'hard cancel signal should clear');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12al (hard cancel cleared) OK');
}

// Case 12am: AUTO-CONFIRM reason carries tag on continue path
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'I will continue with the remaining changes.' }], session_id: 'sess-reason' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.match(out.reason, /\[AUTO-CONFIRM\]/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12am (continue reason carries tag) OK');
}

// Case 12an: queue redirect reason overrides generic AUTO-CONFIRM reason
{
  const dir = makeProject({ hasPending: false });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'queue',
    timestamp: Date.now(),
    queued_intent: 'override reason',
    session_id: 'sess-override-reason',
  }, null, 2));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-override-reason' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.match(out.reason, /override reason/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12an (queue reason override) OK');
}

// Case 12ao: interrupt marker still written on user abort
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  runScript(HOOK, { cwd: dir, stop_reason: 'interrupt', transcript: [], session_id: 'sess-interrupt-marker' }, { cwd: dir });
  assert.ok(existsSync(join(dir, '.smt', 'state', 'last-interrupt.json')));
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ao (interrupt marker still written) OK');
}

// Case 12ap: auto-confirm stays fast on clean stop path
{
  const dir = makeProject({ hasPending: false });
  const start = Date.now();
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-fast' }, { cwd: dir });
  const elapsed = Date.now() - start;
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  assert.ok(elapsed < 2000, `auto-confirm stop path must stay fast (got ${elapsed}ms)`);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ap (clean stop remains fast) OK');
}

// Case 12ap-2: auto-confirm stays fast on continue path too
{
  const dir = makeProject({ hasPending: false });
  const start = Date.now();
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'I will continue with the hook changes.' }], session_id: 'sess-fast-continue' }, { cwd: dir });
  const elapsed = Date.now() - start;
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.ok(elapsed < 2000, `auto-confirm continue path must stay fast (got ${elapsed}ms)`);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ap-2 (continue path remains fast) OK');
}

// Case 12aq: stopReason user_interrupt alias still bypasses
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, stopReason: 'user_interrupt', transcript: [], session_id: 'sess-stopReason-user-interrupt' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12aq (stopReason user_interrupt bypass) OK');
}

// Case 12ar: end_turn_reason max_tokens alias still bypasses
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, end_turn_reason: 'max_tokens', transcript: [], session_id: 'sess-end-turn-reason-max' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ar (end_turn_reason max_tokens bypass) OK');
}

// Case 12as: unknown stop reason should still allow stop on done message
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'weird_reason', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-weird-reason' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12as (unknown stop reason stops cleanly) OK');
}

// Case 12at: multiple pending tasks still auto-confirm with AUTO-CONFIRM reason
{
  const dir = makeProject({ hasPending: true, sessionId: 'sess-multi-pending' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-multi-pending' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Session tasks:/);
  assert.match(out.reason, /Task 1: do the thing/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12at (pending reason still mentions tasks) OK');
}

// Case 12au: assistant array text content should allow stop on done message
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: [{ type: 'text', text: 'Done from array content.' }] }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-array-content' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12au (array content stops cleanly) OK');
}

// Case 12au-2: assistant array self-commitment should still auto-confirm
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: [{ type: 'text', text: 'I will continue from array content.' }] }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-array-content-continue' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12au-2 (array self-commitment auto-confirms) OK');
}

// Case 12av: queue redirect clears signal and blocks
{
  const dir = makeProject({ hasPending: false });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'queue',
    timestamp: Date.now(),
    queued_intent: 'clear me',
    session_id: 'sess-clear-queue',
  }, null, 2));
  runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-clear-queue' }, { cwd: dir });
  assert.ok(!existsSync(join(dir, '.smt', 'state', 'cancel-signal.json')), 'queue signal should clear on stop hook queued redirect');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12av (queue signal cleared) OK');
}

// Case 12aw: hard cancel clears signal and passes through
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'hard',
    timestamp: Date.now(),
    session_id: 'sess-clear-hard',
  }, null, 2));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-clear-hard' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!existsSync(join(dir, '.smt', 'state', 'cancel-signal.json')), 'hard cancel signal should clear');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12aw (hard cancel cleared) OK');
}

// Case 12an: queue redirect reason overrides generic AUTO-CONFIRM reason
{
  const dir = makeProject({ hasPending: false });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'queue',
    timestamp: Date.now(),
    queued_intent: 'override reason',
    session_id: 'sess-override-reason',
  }, null, 2));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-override-reason' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.match(out.reason, /override reason/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12an (queue reason override) OK');
}

// Case 12ao: interrupt marker still written on user abort
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  runScript(HOOK, { cwd: dir, stop_reason: 'interrupt', transcript: [], session_id: 'sess-interrupt-marker' }, { cwd: dir });
  assert.ok(existsSync(join(dir, '.smt', 'state', 'last-interrupt.json')));
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ao (interrupt marker still written) OK');
}

// Case 12ap: auto-confirm stays fast on clean stop path
{
  const dir = makeProject({ hasPending: false });
  const start = Date.now();
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-fast' }, { cwd: dir });
  const elapsed = Date.now() - start;
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  assert.ok(elapsed < 2000, `auto-confirm stop path must stay fast (got ${elapsed}ms)`);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ap (clean stop remains fast) OK');
}

// Case 12ap-2: auto-confirm stays fast on continue path too
{
  const dir = makeProject({ hasPending: false });
  const start = Date.now();
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'I will continue with the hook changes.' }], session_id: 'sess-fast-continue' }, { cwd: dir });
  const elapsed = Date.now() - start;
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.ok(elapsed < 2000, `auto-confirm continue path must stay fast (got ${elapsed}ms)`);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ap-2 (continue path remains fast) OK');
}

// Case 12aq: stopReason user_interrupt alias still bypasses
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, stopReason: 'user_interrupt', transcript: [], session_id: 'sess-stopReason-user-interrupt' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12aq (stopReason user_interrupt bypass) OK');
}

// Case 12ar: end_turn_reason max_tokens alias still bypasses
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, end_turn_reason: 'max_tokens', transcript: [], session_id: 'sess-end-turn-reason-max' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ar (end_turn_reason max_tokens bypass) OK');
}

// Case 12as: unknown stop reason should still allow stop on done message
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'weird_reason', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-weird-reason' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12as (unknown stop reason stops cleanly) OK');
}

// Case 12at: multiple pending tasks still auto-confirm with AUTO-CONFIRM reason
{
  const dir = makeProject({ hasPending: true, sessionId: 'sess-multi-pending' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-multi-pending' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Session tasks:/);
  assert.match(out.reason, /Task 1: do the thing/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12at (pending reason still mentions tasks) OK');
}

// Case 12au: assistant array text content should allow stop on done message
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: [{ type: 'text', text: 'Done from array content.' }] }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-array-content' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12au (array content stops cleanly) OK');
}

// Case 12au-2: assistant array self-commitment should still auto-confirm
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: [{ type: 'text', text: 'I will continue from array content.' }] }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-array-content-continue' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12au-2 (array self-commitment auto-confirms) OK');
}

// Case 12aq: stopReason user_interrupt alias still bypasses
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, stopReason: 'user_interrupt', transcript: [], session_id: 'sess-stopReason-user-interrupt' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12aq (stopReason user_interrupt bypass) OK');
}

// Case 12ar: end_turn_reason max_tokens alias still bypasses
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, { cwd: dir, end_turn_reason: 'max_tokens', transcript: [], session_id: 'sess-end-turn-reason-max' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ar (end_turn_reason max_tokens bypass) OK');
}

// Case 12as: unknown stop reason should still allow stop on done message
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'weird_reason', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-weird-reason' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12as (unknown stop reason stops cleanly) OK');
}

// Case 12at: multiple pending tasks still auto-confirm with AUTO-CONFIRM reason
{
  const dir = makeProject({ hasPending: true, sessionId: 'sess-multi-pending' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-multi-pending' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Session tasks:/);
  assert.match(out.reason, /Task 1: do the thing/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12at (pending reason still mentions tasks) OK');
}

// Case 12au: assistant array text content should allow stop on done message
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: [{ type: 'text', text: 'Done from array content.' }] }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-array-content' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12au (array content stops cleanly) OK');
}

// Case 12av: assistant non-text array content with no text and no pending work should allow stop
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-nontext-array' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12av (non-text array stops cleanly) OK');
}

// Case 12av-2: assistant non-text array with pending work should still auto-confirm
{
  const dir = makeProject({ hasPending: true, sessionId: 'sess-nontext-array-pending' });
  const transcript = [{ role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-nontext-array-pending' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12av-2 (non-text array + pending still auto-confirms) OK');
}

// Case 12aw: missing transcript and messages with no pending work should allow stop
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', session_id: 'sess-no-history-anywhere' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12aw (no history anywhere stops cleanly) OK');
}

// Case 12ax: queue signal with mismatched session should be ignored and stop cleanly
{
  const dir = makeProject({ hasPending: false });
  mkdirSync(join(dir, '.smt', 'state'), { recursive: true });
  writeFileSync(join(dir, '.smt', 'state', 'cancel-signal.json'), JSON.stringify({
    type: 'queue',
    timestamp: Date.now(),
    queued_intent: 'other session intent',
    session_id: 'other-session',
  }, null, 2));
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript: [{ role: 'assistant', content: 'Done.' }], session_id: 'sess-current-queue-ignore' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ax (foreign queue signal ignored) OK');
}

// Case 12ay: plain end_turn without transcript should allow stop when nothing is actionable
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', session_id: 'sess-plain-end-turn' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ay (plain end_turn stops cleanly) OK');
}

// Case 12ay-2: plain end_turn with pending tasks should still auto-confirm
{
  const dir = makeProject({ hasPending: true, sessionId: 'sess-plain-end-turn-pending' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', session_id: 'sess-plain-end-turn-pending' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 12ay-2 (plain end_turn + pending auto-confirms) OK');
}

// Case 12az: non-json stdin path stays non-fatal via runScript guard indirectly covered by all cases

// Case 13: no pending tasks + self-commitment should still direct-block without queue state
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'Next I will update auto-confirm to use conversation history and then run the hook tests.' }];
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-self-commit' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'self-commitment should trigger auto-confirm even without .smt pending tasks');
  const queuePath = join(dir, '.smt', 'state', 'queue-sess-self-commit.json');
  assert.ok(!existsSync(queuePath), 'direct mode must not write queue state for self-commitment');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 13 (self-commitment direct block) OK');
}

// Case 14: consumer remains inert even after a direct stop-hook block
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  runScript(HOOK, {
    cwd: dir,
    session_id: 'sess-mark-done',
    stop_reason: 'end_turn',
    transcript: [{ role: 'assistant', content: 'Next I will finish the remaining docs cleanup.' }],
  }, { cwd: dir });

  const res = runScript(CONSUMER, { cwd: dir, session_id: 'sess-mark-done', prompt: 'mark done!' }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.hookSpecificOutput, 'consumer should remain inert after direct stop-hook handling');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 14 (consumer inert after direct block) OK');
}

// Case 15: ambiguous summary-only turn should trigger risk review
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: 'Summary: I inspected the hooks and documented the likely cause.' }];
  const stubPath = writeAutoConfirmStub({ action: 'risk_review', reason: 'ambiguous wrap-up', prompt: '남은 리스크 해결 및 테스트 및 검토 하라' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-summary-only' }, {
    cwd: dir,
    env: {
      SMELTER_AUTO_CONFIRM_CLASSIFIER_MODULE: stubPath,
      SMELTER_AUTO_CONFIRM_MESSAGES: JSON.stringify(['Summary: I inspected the hooks and documented the likely cause.']),
    },
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'ambiguous summary turns should trigger risk review');
  assert.match(out.reason, /남은 리스크 해결 및 테스트 및 검토 하라/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 15 (summary-only turn triggers risk review) OK');
}

// Case 16: explicit offered next-step message should auto-confirm via classifier
{
  const dir = makeProject({ hasPending: false });
  const transcript = [{ role: 'assistant', content: '원하면 다음 중 하나로 이어가겠다. 1) 테스트 보강 2) 남은 리스크 정리' }];
  const stubPath = writeAutoConfirmStub({ action: 'continue', reason: 'offered next steps', prompt: '제안한 다음 작업 중 가장 직접적인 작업을 즉시 수행하라' });
  const res = runScript(HOOK, { cwd: dir, stop_reason: 'end_turn', transcript, session_id: 'sess-ask-user' }, {
    cwd: dir,
    env: {
      SMELTER_AUTO_CONFIRM_CLASSIFIER_MODULE: stubPath,
      SMELTER_AUTO_CONFIRM_MESSAGES: JSON.stringify(['원하면 다음 중 하나로 이어가겠다. 1) 테스트 보강 2) 남은 리스크 정리']),
      SMELTER_DISABLE_PENDING_TASKS_FOR_TEST: '1',
    },
  });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block', 'offered next-step turns should auto-confirm');
  assert.match(out.reason, /Session tasks:/);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 16 (classifier continue path) OK');
}

// Case 17: direct mode should still inspect accumulated Claude-only turns from the transcript
{
  const dir = makeProject({ hasPending: true, sessionId: 'matched-in-test' });
  const res = runScript(HOOK, {
    cwd: dir,
    stop_reason: 'end_turn',
    session_id: 'sess-history',
    transcript: [
      { role: 'assistant', content: 'I inspected the stop hook.' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'I will now finish the continuation transport.' },
    ],
  }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 17 (history still inspected) OK');
}

// Case 18: done message with no pending work should not auto-confirm
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, {
    cwd: dir,
    stop_reason: 'end_turn',
    session_id: 'sess-done-no-pending',
    transcript: [{ role: 'assistant', content: 'Done.' }],
  }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true);
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 18 (done no pending passes through) OK');
}

// Case 19: committed next step still auto-confirms
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, {
    cwd: dir,
    stop_reason: 'end_turn',
    session_id: 'sess-next-step',
    transcript: [{ role: 'assistant', content: 'I will continue with the next step now.' }],
  }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 19 (committed next step auto-confirms) OK');
}

// Case 20: confirmation question still auto-confirms
{
  const dir = makeProject({ hasPending: false });
  const res = runScript(HOOK, {
    cwd: dir,
    stop_reason: 'end_turn',
    session_id: 'sess-confirmation',
    transcript: [{ role: 'assistant', content: 'Shall I proceed with the implementation?' }],
  }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 20 (confirmation question auto-confirms) OK');
}

// Case 21: task lookup must be session-id only and ignore workflow fallback
{
  const dir = makeProject({ hasPending: false, sessionId: 'sess-session-only', otherSessionHasPending: true });
  const res = runScript(HOOK, {
    cwd: dir,
    stop_reason: 'end_turn',
    session_id: 'sess-session-only',
    transcript: [{ role: 'assistant', content: 'Done.' }],
  }, { cwd: dir });
  const out = JSON.parse(res.stdout);
  assert.equal(out.continue, true, 'session pointer should prevent reading unrelated feature tasks');
  assert.ok(!out.decision);
  rmSync(dir, { recursive: true, force: true });
  console.log('  case 21 (session-id only task lookup) OK');
}

console.log('auto-confirm: OK');
