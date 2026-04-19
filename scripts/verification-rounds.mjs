#!/usr/bin/env node
/**
 * verification-rounds.mjs — Multi-Pass Verification (3-Round) enforcement engine.
 *
 * Implements workflow-v2.md section 9-3.
 *
 * Responsibilities:
 *   - Initialize rounds[] for a review skill entering execution.
 *   - Record round results (pass/fail per focus).
 *   - Gate skill-level pass: requires all 3 rounds pass (or min_verification_rounds).
 *   - Detect evasion: block pass declaration when completed_rounds < required.
 *
 * Principle: no retry, no self-skip. A failed round triggers producer-chain
 * routing (via route-on-fail.mjs) rather than local retry.
 */

import { appendEvent, VERIFICATION_FOCUS_ENUM } from './state-schema.mjs';

// Review skills that MUST run Multi-Pass Verification. Per spec §9-3.
export const REVIEW_SKILLS_WITH_VERIFICATION = Object.freeze([
  'workflow-brainstorm-review',
  'workflow-investigate-review',
  'workflow-tasker-review',
  'workflow-agent-review',
  'workflow-e2e-review',
  'workflow-team-code-review',
]);

export const DEFAULT_ROUNDS = Object.freeze([
  { n: 1, focus: 'omission' },
  { n: 2, focus: 'contradiction' },
  { n: 3, focus: 'edge_case' },
]);

export const ROUND_PROMPT_TEMPLATES = Object.freeze({
  omission: 'templates/verification/round-1-omission.md',
  contradiction: 'templates/verification/round-2-contradiction.md',
  edge_case: 'templates/verification/round-3-edge-case.md',
});

/**
 * Initialize team_runtime entry for a review skill with round scaffolding.
 * Idempotent: if rounds already initialized, returns existing entry unchanged.
 */
export function initRounds(state, skill, { pattern = 'A', assignedAgents = [], minRounds = 3 } = {}) {
  if (!REVIEW_SKILLS_WITH_VERIFICATION.includes(skill)) {
    throw new Error(`skill does not support Multi-Pass Verification: ${skill}`);
  }
  if (minRounds < 1 || minRounds > 3) {
    throw new Error(`min_verification_rounds out of range [1,3]: ${minRounds}`);
  }

  const existing = state.team_runtime?.[skill];
  if (existing && Array.isArray(existing.rounds) && existing.rounds.length > 0) {
    return existing;
  }

  const rounds = DEFAULT_ROUNDS.slice(0, minRounds).map((r) => ({
    n: r.n,
    focus: r.focus,
    result: null,
    agent_type: null,
    findings: [],
    started_at: null,
    completed_at: null,
  }));

  state.team_runtime = state.team_runtime || {};
  state.team_runtime[skill] = {
    pattern,
    assigned_agents: assignedAgents,
    rounds,
    min_verification_rounds: minRounds,
    completed_rounds: 0,
    status: 'pending',
  };
  return state.team_runtime[skill];
}

/**
 * Record the start of a round (agent assignment, timing).
 */
export function startRound(state, skill, roundN, agentType) {
  const entry = state.team_runtime?.[skill];
  if (!entry?.rounds) throw new Error(`rounds not initialized for ${skill}`);
  const round = entry.rounds.find((r) => r.n === roundN);
  if (!round) throw new Error(`round ${roundN} not found for ${skill}`);
  if (round.result !== null) throw new Error(`round ${roundN} already completed for ${skill}`);

  round.agent_type = agentType;
  round.started_at = new Date().toISOString();
  entry.status = 'in_progress';
  return round;
}

/**
 * Record the outcome of a round. Enforces strict sequencing: round N cannot
 * complete before N-1. Anti-evasion: a skill cannot declare pass with
 * completed_rounds < min_verification_rounds.
 */
export function recordRoundResult(state, skill, roundN, { result, findings = [] }) {
  if (!['pass', 'fail'].includes(result)) {
    throw new Error(`result must be pass|fail: ${result}`);
  }
  const entry = state.team_runtime?.[skill];
  if (!entry?.rounds) throw new Error(`rounds not initialized for ${skill}`);

  const round = entry.rounds.find((r) => r.n === roundN);
  if (!round) throw new Error(`round ${roundN} not found for ${skill}`);

  // Enforce strict ordering: previous round must have result.
  if (roundN > 1) {
    const prev = entry.rounds.find((r) => r.n === roundN - 1);
    if (!prev || prev.result === null) {
      throw new Error(`round ${roundN - 1} must complete before round ${roundN}`);
    }
  }

  round.result = result;
  round.findings = findings;
  round.completed_at = new Date().toISOString();

  if (result === 'pass') {
    entry.completed_rounds += 1;
  }

  // Determine overall skill-level status.
  if (result === 'fail') {
    entry.status = 'failed';
    appendEvent(state, {
      skill,
      result: 'fail',
      declarer: 'hook',
      cause: 'verification_failed',
      evidence: {
        type: 'parse',
        detail: `round ${roundN} (${round.focus}) failed: ${findings.length} findings`,
      },
      round: roundN,
      focus: round.focus,
    });
  } else if (entry.completed_rounds >= entry.min_verification_rounds) {
    entry.status = 'passed';
    appendEvent(state, {
      skill,
      result: 'pass',
      declarer: 'hook',
      cause: null,
      evidence: {
        type: 'parse',
        detail: `all ${entry.min_verification_rounds} rounds passed`,
      },
    });
  }

  return { round, entryStatus: entry.status };
}

/**
 * Can the skill declare pass right now? Gate for auto-confirm / skill completion.
 */
export function canDeclarePass(state, skill) {
  const entry = state.team_runtime?.[skill];
  if (!entry) return { allowed: false, reason: 'not_initialized' };
  if (entry.status !== 'passed') {
    return {
      allowed: false,
      reason: 'rounds_incomplete',
      detail: `${entry.completed_rounds}/${entry.min_verification_rounds} rounds passed`,
    };
  }
  return { allowed: true };
}

/**
 * On re-entry after upstream fix, reset all rounds. Per spec §9-3:
 * "ALL 3 rounds re-run (not just failed ones)".
 */
export function resetRounds(state, skill) {
  const entry = state.team_runtime?.[skill];
  if (!entry?.rounds) return;
  for (const r of entry.rounds) {
    r.result = null;
    r.agent_type = null;
    r.findings = [];
    r.started_at = null;
    r.completed_at = null;
  }
  entry.completed_rounds = 0;
  entry.status = 'pending';
}

/**
 * Evasion detector: warn when same agent type runs 3 consecutive rounds.
 * Pattern A should mix >=2 types per spec §9-3.
 */
export function detectAgentReuse(state, skill) {
  const entry = state.team_runtime?.[skill];
  if (!entry?.rounds || entry.rounds.length < 3) return { reused: false };
  const types = entry.rounds.filter((r) => r.agent_type).map((r) => r.agent_type);
  if (types.length < 3) return { reused: false };
  const unique = new Set(types);
  if (unique.size === 1 && entry.pattern === 'A') {
    return { reused: true, agent_type: [...unique][0], warning: 'Pattern A should mix >=2 agent types across rounds' };
  }
  return { reused: false };
}

// CLI entry: inspect state.json round status for a given skill.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [statePath, skill] = process.argv.slice(2);
  if (!statePath || !skill) {
    console.error('usage: verification-rounds.mjs <state.json path> <skill>');
    process.exit(2);
  }
  const { readState } = await import('./state-schema.mjs');
  const state = readState(statePath);
  if (!state) { console.error(`cannot read: ${statePath}`); process.exit(1); }
  const entry = state.team_runtime?.[skill];
  if (!entry) { console.log(`no team_runtime entry for ${skill}`); process.exit(0); }
  console.log(JSON.stringify({
    skill,
    pattern: entry.pattern,
    status: entry.status,
    completed_rounds: entry.completed_rounds,
    min_required: entry.min_verification_rounds,
    rounds: entry.rounds,
  }, null, 2));
}
