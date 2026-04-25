#!/usr/bin/env node
/**
 * posttool-terminal-state-gate.test.mjs — RED tests for PostToolUse terminal
 * state gate. Detects when a review skill's Agent/Task returns but the
 * canonical artifact + next-skill dispatch are missing, and injects a
 * reminder via hookSpecificOutput.additionalContext.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const failures = [];

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else {
    fail++;
    failures.push({ label, actual, expected });
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
  }
}

function section(t) { console.log(`\n[${t}]`); }

function runHook(payload, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(process.cwd(), 'scripts/posttool-terminal-state-gate.mjs')], {
    input: JSON.stringify(payload),
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8'
  });
  let out = null;
  try { out = r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null; } catch { out = { parseError: r.stdout }; }
  return { stdout: out, stderr: r.stderr, status: r.status };
}

function mkFixture(stage) {
  const dir = mkdtempSync(join(tmpdir(), 'smt-pt-'));
  mkdirSync(join(dir, '.smt/state'), { recursive: true });
  mkdirSync(join(dir, '.smt/features/fx/task'), { recursive: true });
  writeFileSync(join(dir, `.smt/state/active-feature-${SID}.json`), JSON.stringify({ slug: 'fx' }), 'utf-8');
  writeFileSync(join(dir, '.smt/features/fx/task/fx.state.json'), JSON.stringify({ task_id: 'fx', mode: 'implement', current_stage: stage, completed_stages: [] }), 'utf-8');
  return dir;
}

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REVIEW = 'workflow-brainstorm-review';

// [happy path — 2+]
section('happy path');
{
  const dir = mkFixture(REVIEW);
  // artifact written + next skill dispatched → no inject
  writeFileSync(join(dir, '.smt/features/fx/task/brainstorm_review.md'), '## Verdict\npass', 'utf-8');
  const r = runHook({
    tool_name: 'Skill', tool_input: { skill: 'workflow-investigate' },
    session_id: SID, cwd: dir,
    turn_tool_uses: [
      { tool: 'Agent', returned: true },
      { tool: 'Write', tool_input: { file_path: join(dir, '.smt/features/fx/task/brainstorm_review.md') } },
      { tool: 'Skill', tool_input: { skill: 'workflow-investigate' } }
    ]
  }, dir, { SMT_TERMINAL_GATE_MODE: 'enforce' });
  assert('artifact + next skill → no inject', r.stdout?.hookSpecificOutput?.additionalContext, undefined);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture('workflow-coding');  // coding stage now under enforcement — next-skill only
  const r = runHook({
    tool_name: 'Agent', tool_input: {}, session_id: SID, cwd: dir,
    turn_tool_uses: [
      { tool: 'Edit', tool_input: { file_path: '/tmp/x' } },
      { tool: 'Bash', tool_input: { command: 'node foo.test.mjs' } }
    ]
  }, dir, { SMT_TERMINAL_GATE_MODE: 'enforce' });
  assert('coding stage + mutation, no next skill → inject agent-review reminder', typeof r.stdout?.hookSpecificOutput?.additionalContext, 'string');
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture('workflow-coding');  // coding + Skill(agent-review) dispatched → no inject
  const r = runHook({
    tool_name: 'Skill', tool_input: { skill: 'workflow-agent-review' }, session_id: SID, cwd: dir,
    turn_tool_uses: [
      { tool: 'Edit', tool_input: { file_path: '/tmp/x' } },
      { tool: 'Skill', tool_input: { skill: 'workflow-agent-review' } }
    ]
  }, dir, { SMT_TERMINAL_GATE_MODE: 'enforce' });
  assert('coding + next-skill dispatched → no inject', r.stdout?.hookSpecificOutput?.additionalContext, undefined);
  rmSync(dir, { recursive: true, force: true });
}

// [boundary — 2+]
section('boundary');
{
  const dir = mkFixture(REVIEW);
  // artifact missing, 3 agent returns, no next-skill dispatch → inject
  const r = runHook({
    tool_name: 'Agent', tool_input: {}, session_id: SID, cwd: dir,
    turn_tool_uses: [{ tool: 'Agent', returned: true }, { tool: 'Agent', returned: true }, { tool: 'Agent', returned: true }]
  }, dir, { SMT_TERMINAL_GATE_MODE: 'enforce' });
  assert('3 agents, no artifact → inject', typeof r.stdout?.hookSpecificOutput?.additionalContext, 'string');
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture(REVIEW);
  // no state file would already return no-op; testing: state with only mode, no current_stage
  writeFileSync(join(dir, '.smt/features/fx/task/fx.state.json'), JSON.stringify({ task_id: 'fx', mode: 'implement', current_stage: null, completed_stages: [] }), 'utf-8');
  const r = runHook({ tool_name: 'Agent', tool_input: {}, session_id: SID, cwd: dir, turn_tool_uses: [{ tool: 'Agent', returned: true }] }, dir, { SMT_TERMINAL_GATE_MODE: 'enforce' });
  assert('null current_stage → no inject', r.stdout?.hookSpecificOutput?.additionalContext, undefined);
  rmSync(dir, { recursive: true, force: true });
}

// [error path — 2+]
section('error path');
{
  const dir = mkFixture(REVIEW);
  // artifact written but NEXT skill NOT dispatched → inject
  writeFileSync(join(dir, '.smt/features/fx/task/brainstorm_review.md'), '## Verdict\npass', 'utf-8');
  const r = runHook({
    tool_name: 'Write', tool_input: { file_path: join(dir, '.smt/features/fx/task/brainstorm_review.md') },
    session_id: SID, cwd: dir,
    turn_tool_uses: [{ tool: 'Agent', returned: true }, { tool: 'Write', tool_input: { file_path: join(dir, '.smt/features/fx/task/brainstorm_review.md') } }]
  }, dir, { SMT_TERMINAL_GATE_MODE: 'enforce' });
  assert('artifact written, no next skill → inject', typeof r.stdout?.hookSpecificOutput?.additionalContext, 'string');
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture(REVIEW);
  // dedupe — same-stage reminder within turn, second call should no-op
  writeFileSync(join(dir, '.smt/state/terminal-reminder-' + SID + '.json'), JSON.stringify({ last_reminded_stage: REVIEW, ts: Date.now() }), 'utf-8');
  const r = runHook({
    tool_name: 'Agent', tool_input: {}, session_id: SID, cwd: dir,
    turn_tool_uses: [{ tool: 'Agent', returned: true }]
  }, dir, { SMT_TERMINAL_GATE_MODE: 'enforce' });
  assert('dedupe: recent reminder → no re-inject', r.stdout?.hookSpecificOutput?.additionalContext, undefined);
  rmSync(dir, { recursive: true, force: true });
}

// [edge case — 2+]
section('edge case');
{
  const dir = mkFixture(REVIEW);
  const r = runHook({
    tool_name: 'Agent', tool_input: {}, session_id: SID, cwd: dir,
    turn_tool_uses: [{ tool: 'Agent', returned: true }]
  }, dir, { SMT_TERMINAL_GATE_MODE: 'shadow' });
  assert('removed shadow mode → inject', typeof r.stdout?.hookSpecificOutput?.additionalContext, 'string');
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture(REVIEW);
  const r = runHook({
    tool_name: 'Agent', tool_input: {}, session_id: SID, cwd: dir,
    turn_tool_uses: [{ tool: 'Agent', returned: true }]
  }, dir);
  assert('default mode → inject', typeof r.stdout?.hookSpecificOutput?.additionalContext, 'string');
  rmSync(dir, { recursive: true, force: true });
}
{
  // no state file → no-op
  const dir = mkdtempSync(join(tmpdir(), 'smt-pt-'));
  mkdirSync(join(dir, '.smt/state'), { recursive: true });
  const r = runHook({ tool_name: 'Agent', tool_input: {}, session_id: SID, cwd: dir, turn_tool_uses: [] }, dir, { SMT_TERMINAL_GATE_MODE: 'enforce' });
  assert('no state → no inject', r.stdout?.hookSpecificOutput?.additionalContext, undefined);
  rmSync(dir, { recursive: true, force: true });
}

// [integration — 1+]
section('integration');
{
  const dir = mkFixture('workflow-investigate-review');
  const r = runHook({
    tool_name: 'Agent', tool_input: {}, session_id: SID, cwd: dir,
    turn_tool_uses: [{ tool: 'Agent', returned: true }, { tool: 'Agent', returned: true }, { tool: 'Agent', returned: true }]
  }, dir, { SMT_TERMINAL_GATE_MODE: 'enforce' });
  const ctx = r.stdout?.hookSpecificOutput?.additionalContext ?? '';
  assert('investigate-review reminder mentions canonical artifact', ctx.includes('investigate_review.md') || ctx.includes('investigation'), true);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.label}`);
  process.exit(1);
}
