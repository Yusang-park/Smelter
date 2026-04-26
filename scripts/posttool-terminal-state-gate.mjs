#!/usr/bin/env node
/**
 * posttool-terminal-state-gate.mjs — PostToolUse hook that injects a reminder
 * when a review skill's in-turn work (Agent/Task returns or Skill calls) has
 * produced tool results but the canonical artifact write + next-skill dispatch
 * have not been performed.
 *
 * Only fires when current_stage is a review skill (workflow-*-review).
 * Skipped when:
 *  - state.json absent or current_stage null
 *  - the turn's tool-use log shows both canonical artifact Write AND
 *    Skill(<nextSkill>) invocation
 *  - a reminder for the same stage was already injected this turn (dedupe)
 *  - SMT_TERMINAL_GATE_MODE=off
 *
 * Emits Claude Code hook schema:
 *   { hookSpecificOutput: { additionalContext: "<reminder>" } }
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { resolveActiveState, resolveHookSessionId, terminalReminderPath } from './lib/session-paths.mjs';
import { nextSkillForState } from './lib/workflow-chain.mjs';

// Canonical artifact basenames + accepted variants per skill. Only review
// skills have a mandatory artifact. Non-review stages (coding, write-test,
// human-check, brainstorm, investigate, tasker) have next-skill dispatch
// requirements but no canonical md artifact the gate can check on disk.
const SKILL_ARTIFACTS = {
  'workflow-brainstorm':          ['brainstorm.md'],
  'workflow-brainstorm-review':   ['brainstorm_review.md', 'brainstorm-review.md'],
  'workflow-investigate':         ['investigation.md'],
  'workflow-investigate-review':  ['investigate_review.md', 'investigation-review.md', 'investigation_review.md'],
  'workflow-implementation-plan': ['implementation-plan.md'],
  'workflow-implementation-plan-review': ['implementation-plan-review.md'],
  'workflow-infra-plan':          ['infra-plan.md'],
  'workflow-infra-plan-review':   ['infra-plan-review.md'],
  'workflow-infra-execute':       ['infra-execute.md'],
  'workflow-tasker':              ['plan.md', 'tasks.md'],
  'workflow-tasker-review':       ['tasker_review.md', 'tasks-review.md'],
  'workflow-agent-review':        ['agent_review.md', 'agent-review.md'],
  'workflow-e2e-review':          ['e2e_review.md', 'e2e-review.md'],
  'workflow-team-code-review':    ['team_code_review.md', 'team-code-review.md']
};

// Stages where artifact presence is not gated (source-code producing stages
// or user-checkpoint stages). These still require next-skill dispatch.
const NO_ARTIFACT_STAGES = new Set([
  'workflow-write-test',
  'workflow-coding',
  'workflow-e2e'
]);

function stageUnderEnforcement(state, stage) {
  return Boolean(nextSkillForState(state, stage) || SKILL_ARTIFACTS[stage]);
}

function getMode() {
  const m = (process.env.SMT_TERMINAL_GATE_MODE || 'enforce').toLowerCase();
  return m === 'off' ? 'off' : 'enforce';
}

function logStderr(tag, obj) {
  try { process.stderr.write(`[PostTool Terminal Gate] ${tag} ${JSON.stringify(obj)}\n`); }
  catch { /* non-fatal */ }
}

function emitNoOp() { process.exit(0); }

function emitReminder(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: text } }));
  process.exit(0);
}

function recentlyReminded(cwd, sessionId, stage, windowMs = 60 * 1000) {
  const p = terminalReminderPath(cwd, sessionId);
  try {
    const s = JSON.parse(readFileSync(p, 'utf-8'));
    return s && s.last_reminded_stage === stage && (Date.now() - (s.ts || 0)) < windowMs;
  } catch { return false; }
}

function markReminded(cwd, sessionId, stage) {
  const p = terminalReminderPath(cwd, sessionId);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ last_reminded_stage: stage, ts: Date.now() }, null, 2), 'utf-8');
  } catch (e) { logStderr('mark-error', { error: String(e && e.message || e) }); }
}

function extractTurnToolUses(input) {
  if (Array.isArray(input.turn_tool_uses)) return input.turn_tool_uses;
  return [];
}

function canonicalArtifactWritten(turnToolUses, featureSlug, cwd, currentStage) {
  const expected = SKILL_ARTIFACTS[currentStage] || [];
  if (expected.length === 0) return false;
  for (const use of turnToolUses) {
    if (use.tool !== 'Write') continue;
    const p = use.tool_input && use.tool_input.file_path;
    if (typeof p !== 'string') continue;
    const b = basename(p);
    if (expected.includes(b)) return true;
  }
  // Also accept pre-existing file on disk (written earlier in the session)
  for (const name of expected) {
    const full = `${cwd}/.smt/features/${featureSlug}/task/${name}`;
    try {
      statSync(full);
      return true;
    } catch { /* try next variant */ }
  }
  return false;
}

function nextSkillDispatched(turnToolUses, nextSkill) {
  if (!nextSkill) return true;
  for (const use of turnToolUses) {
    if (use.tool !== 'Skill') continue;
    const s = use.tool_input && use.tool_input.skill;
    if (s === nextSkill) return true;
  }
  return false;
}

function agentReturnedThisTurn(turnToolUses) {
  return turnToolUses.some((u) => u.tool === 'Agent' || u.tool === 'Task');
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
  } catch (e) {
    logStderr('stdin-parse-error', { error: String(e && e.message || e) });
    emitNoOp(); return;
  }

  const mode = getMode();
  if (mode === 'off') emitNoOp();

  const { cwd } = input;
  const sessionId = resolveHookSessionId(input);
  if (!cwd || !sessionId) emitNoOp();

  const active = resolveActiveState(cwd, sessionId);
  if (!active || !active.state) emitNoOp();

  const currentStage = active.state.current_stage;
  if (currentStage == null) emitNoOp();

  // All workflow stages with a defined next-skill are under enforcement.
  if (!stageUnderEnforcement(active.state, currentStage)) emitNoOp();

  const turn = extractTurnToolUses(input);
  const agentReturned = agentReturnedThisTurn(turn);
  const hasMutation = turn.some((u) => u.tool === 'Write' || u.tool === 'Edit' || u.tool === 'Bash' || u.tool === 'NotebookEdit');
  if (!agentReturned && !hasMutation && turn.length === 0) emitNoOp(); // nothing to judge

  const nextSkill = nextSkillForState(active.state, currentStage);
  const dispatched = nextSkillDispatched(turn, nextSkill);
  // Source-code stages (coding / write-test / e2e) check ONLY next-skill dispatch.
  const skipArtifactCheck = NO_ARTIFACT_STAGES.has(currentStage);
  const artifactOk = skipArtifactCheck ? true : canonicalArtifactWritten(turn, active.slug, cwd, currentStage);

  if (artifactOk && dispatched) { emitNoOp(); return; }

  if (recentlyReminded(cwd, sessionId, currentStage)) {
    logStderr('dedupe', { stage: currentStage });
    emitNoOp(); return;
  }

  // Build reminder
  const missing = [];
  if (!skipArtifactCheck && !artifactOk && SKILL_ARTIFACTS[currentStage]) {
    missing.push(`Write .smt/features/${active.slug}/task/${SKILL_ARTIFACTS[currentStage][0]}`);
  }
  if (!dispatched && nextSkill) missing.push(`Skill(skill: '${nextSkill}')`);
  if (missing.length === 0) { emitNoOp(); return; } // nothing actionable
  const reminder = `[${currentStage}] Missing: ${missing.join('; ')}. Continue now; no user question.`;

  markReminded(cwd, sessionId, currentStage);
  logStderr('inject', { stage: currentStage, missing });
  emitReminder(reminder);
}

process.on('uncaughtException', (e) => {
  process.stderr.write(`[PostTool Terminal Gate] crash ${String(e && e.stack || e)}\n`);
  // fail-open: never block on gate crash
  process.exit(0);
});

main();
