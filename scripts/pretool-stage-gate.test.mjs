#!/usr/bin/env node
/**
 * pretool-stage-gate.test.mjs — RED tests for PreToolUse stage-skill gate.
 *
 * Tests the hook as a process: pipes payload JSON via stdin and asserts
 * decision JSON on stdout. The target script does not yet exist.
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
  const r = spawnSync(process.execPath, [join(process.cwd(), 'scripts/pretool-stage-gate.mjs')], {
    input: JSON.stringify(payload),
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8'
  });
  let out = null;
  try { out = r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null; } catch { out = { parseError: r.stdout }; }
  return { stdout: out, stderr: r.stderr, status: r.status };
}

function mkFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'smt-gate-'));
  mkdirSync(join(dir, '.smt/state'), { recursive: true });
  mkdirSync(join(dir, '.smt/features/fx/task'), { recursive: true });
  return dir;
}

function writePointer(dir, sid, slug) {
  writeFileSync(join(dir, `.smt/state/active-feature-${sid}.json`), JSON.stringify({ slug }), 'utf-8');
}

function writeState(dir, slug, state) {
  writeFileSync(join(dir, `.smt/features/${slug}/task/${slug}.state.json`), JSON.stringify(state, null, 2), 'utf-8');
}

const SID = '11111111-2222-3333-4444-555555555555';

// [happy path — 2+]
section('happy path');
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: 'workflow-brainstorm', completed_stages: [] });
  // no loaded skills → deny
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('Write w/o skill → block', r.stdout?.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: 'workflow-investigate', completed_stages: [] });
  const r0 = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce', SMELTER_SESSION_ID: SID });
  assert('missing input session_id + env state w/o skill → block', r0.stdout?.decision, 'block');
  runHook({ tool_name: 'Skill', tool_input: { skill: 'workflow-investigate' }, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce', SMELTER_SESSION_ID: SID });
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce', SMELTER_SESSION_ID: SID });
  assert('missing input session_id uses SMELTER_SESSION_ID for loaded skill', r.stdout === null || r.stdout?.decision !== 'block', true);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: 'workflow-brainstorm', completed_stages: [] });
  // record skill load via Skill tool
  runHook({ tool_name: 'Skill', tool_input: { skill: 'workflow-brainstorm' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('Write after Skill load → allow', r.stdout === null || r.stdout?.decision !== 'block', true);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: 'workflow-investigate', completed_stages: [] });
  runHook({ tool_name: 'Skill', tool_input: { skill: '/implement' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('Write after slash entry command load → allow current entry stage', r.stdout === null || r.stdout?.decision !== 'block', true);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: 'workflow-investigate', completed_stages: [] });
  runHook({ tool_name: 'Skill', tool_input: { skill: '/fix' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('mismatched slash entry command does not load current stage', r.stdout?.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
}

// [boundary — 2+]
section('boundary');
{
  const dir = mkFixture();
  // no state file → pass-through
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('no state → pass-through', r.stdout === null || r.stdout?.decision !== 'block', true);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: null, completed_stages: [] });
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('state + current_stage=null → block', r.stdout?.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
}

// [error path — 2+]
section('error path');
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: 'workflow-brainstorm', completed_stages: [] });
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('Bash rm w/o skill → block', r.stdout?.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  // broken state.json → deny-by-default (fail-closed)
  writePointer(dir, SID, 'fx');
  writeFileSync(join(dir, '.smt/features/fx/task/fx.state.json'), '{BROKEN JSON', 'utf-8');
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('corrupt state → block (fail-closed)', r.stdout?.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
}

// [edge case — 2+]
section('edge case');
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: 'workflow-brainstorm', completed_stages: [] });
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'ls -la' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('Bash ls read-only → allow', r.stdout === null || r.stdout?.decision !== 'block', true);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: 'workflow-brainstorm', completed_stages: [] });
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'shadow' });
  assert('removed shadow mode → enforce block', r.stdout?.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: 'workflow-brainstorm', completed_stages: [] });
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, session_id: SID, cwd: dir }, dir);
  assert('default mode → enforce block', r.stdout?.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: 'workflow-brainstorm', completed_stages: [] });
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'off' });
  assert('off mode → pass-through', r.stdout === null || r.stdout?.decision !== 'block', true);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'dobby', user_mode: 'dobby', task_type: 'freeform', current_stage: 'workflow-human-check', completed_stages: [] });
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'git checkout -- src/hooks/account/use-account-query.test.ts' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('dobby active state → mutating git pass-through', r.stdout === null || r.stdout?.decision !== 'block', true);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: 'workflow-brainstorm', completed_stages: [] });
  const r = runHook({ tool_name: 'mcp__serena__replace_symbol_body', tool_input: {}, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('retired Serena MCP tool is not stage-gated', r.stdout === null || r.stdout?.decision !== 'block', true);
  rmSync(dir, { recursive: true, force: true });
}

// [integration — 1+]
section('integration');
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  writeState(dir, 'fx', { task_id: 'fx', mode: 'implement', current_stage: 'workflow-coding', completed_stages: ['workflow-brainstorm','workflow-investigate','workflow-tasker','workflow-write-test'] });
  // record coding skill load
  runHook({ tool_name: 'Skill', tool_input: { skill: 'workflow-coding' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  const r = runHook({ tool_name: 'Edit', tool_input: { file_path: '/tmp/x' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('full flow: coding stage + loaded → Edit allowed', r.stdout === null || r.stdout?.decision !== 'block', true);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  const allowed = ['workflow-e2e-review', 'workflow-human-check'];
  writeState(dir, 'fx', { task_id: 'fx', mode: 'fix', current_stage: 'workflow-e2e-review', allowed_skills: allowed, completed_stages: [] });
  runHook({ tool_name: 'Skill', tool_input: { skill: 'workflow-human-check' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  writeState(dir, 'fx', { task_id: 'fx', mode: 'fix', current_stage: 'workflow-human-check', allowed_skills: allowed, completed_stages: [] });
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: join(dir, '.smt/features/fx/task/results.md') }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('human-check target epoch load → results.md Write allowed after transition', r.stdout === null || r.stdout?.decision !== 'block', true);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkFixture();
  writePointer(dir, SID, 'fx');
  const allowed = ['workflow-e2e-review', 'workflow-human-check'];
  writeState(dir, 'fx', { task_id: 'fx', mode: 'fix', current_stage: 'workflow-e2e-review', allowed_skills: allowed, completed_stages: [] });
  runHook({ tool_name: 'Skill', tool_input: { skill: 'workflow-e2e-review' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  runHook({ tool_name: 'Skill', tool_input: { skill: 'workflow-human-check' }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: join(dir, '.smt/features/fx/task/results.md') }, session_id: SID, cwd: dir }, dir, { SMT_STAGE_GATE_MODE: 'enforce' });
  assert('target epoch load does not allow results.md Write while prior stage remains loaded', r.stdout?.decision, 'block');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.label}`);
  process.exit(1);
}
