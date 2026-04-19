#!/usr/bin/env node
/**
 * stall-detector.mjs — Workflow v2 stall detection (§11-7).
 *
 * 6 signals + 4-Level internal resolution cascade.
 * Levels 1-3 resolve without user; Level 4 escalates.
 */

import { readFileSync, statSync, existsSync } from 'node:fs';

// §11-7 Stall signals with thresholds
const STALL_THRESHOLDS = Object.freeze({
  parallel_tool_inactive_ms:    5 * 60 * 1000,      // 5 min
  parallel_tool_inactive_calls: 10,
  same_skill_fail_repeats:      3,
  sync_point_wait_ms:           3 * 60 * 1000,      // 3 min after others done
  test_cycles_no_pass:          10,
  active_feedback_unresolved:   3,
  state_not_updated_ms:         10 * 60 * 1000,     // 10 min
});

/**
 * Detect stall signals in the current state.
 * Returns array of detected signals (empty if none).
 */
export function detectStall(state, { now = Date.now() } = {}) {
  const signals = [];
  if (!state) return signals;

  // Signal 6: updated_at too old
  if (state.updated_at) {
    const age = now - new Date(state.updated_at).getTime();
    if (age > STALL_THRESHOLDS.state_not_updated_ms) {
      signals.push({ kind: 'state_stale', age_ms: age });
    }
  }

  // Signal 2: same skill@fail repeats
  const events = state.events || [];
  if (events.length >= STALL_THRESHOLDS.same_skill_fail_repeats) {
    const recent = events.slice(-STALL_THRESHOLDS.same_skill_fail_repeats);
    if (recent.every(e => e.result === 'fail') &&
        new Set(recent.map(e => e.skill)).size === 1) {
      signals.push({ kind: 'repeated_fail', skill: recent[0].skill, count: recent.length });
    }
  }

  // Signal 4: test_cycles accumulated without pass
  const cycles = state.test_cycles || [];
  const withoutPass = cycles.filter(c => c.run_result === 'fail').length;
  const anyPass = cycles.some(c => c.run_result === 'pass');
  if (withoutPass >= STALL_THRESHOLDS.test_cycles_no_pass && !anyPass) {
    signals.push({ kind: 'tdd_no_green', count: withoutPass });
  }

  // Signal 5: active_feedback unresolved accumulated
  const unresolved = (state.active_feedback || []).filter(f => !f.resolved);
  if (unresolved.length >= STALL_THRESHOLDS.active_feedback_unresolved) {
    signals.push({ kind: 'feedback_backlog', count: unresolved.length });
  }

  // Signals 1 & 3: parallel agent inactivity + sync point wait
  // Both approximated via team_runtime status (tool-call log not tracked here).
  const teamRuntime = state.team_runtime || {};
  for (const [skill, cfg] of Object.entries(teamRuntime)) {
    if (cfg.pattern !== 'C') continue;
    const agents = cfg.assigned_agents || [];
    if (agents.length === 0) continue;
    const inProgress = agents.filter(a => a.status === 'in_progress');
    const done = agents.filter(a => a.status === 'done');

    // Signal 3: sync-point wait — some agents stuck while peers are done
    if (inProgress.length > 0 && done.length > 0 && done.length >= inProgress.length * 2) {
      signals.push({ kind: 'sync_point_wait', skill, stuck: inProgress.map(a => a.id) });
    }

    // Signal 1: parallel agent tool-inactive — per-agent last_tool_at timestamp
    // or tool_calls counter threshold. Emit when either exceeds threshold.
    for (const a of inProgress) {
      if (a.last_tool_at) {
        const inactive = now - new Date(a.last_tool_at).getTime();
        if (inactive > STALL_THRESHOLDS.parallel_tool_inactive_ms) {
          signals.push({
            kind: 'parallel_tool_inactive',
            skill,
            agent_id: a.id,
            inactive_ms: inactive,
          });
        }
      }
      if (typeof a.tool_calls_since_progress === 'number' &&
          a.tool_calls_since_progress >= STALL_THRESHOLDS.parallel_tool_inactive_calls) {
        signals.push({
          kind: 'parallel_tool_inactive',
          skill,
          agent_id: a.id,
          calls_since_progress: a.tool_calls_since_progress,
        });
      }
    }
  }

  return signals;
}

/**
 * 4-Level Cascade: returns the next level action given detected signals and current level.
 * Each level has max 2 attempts.
 */
export function nextCascadeLevel(currentLevel, attemptsAtLevel) {
  if (attemptsAtLevel < 2) return { level: currentLevel, action: 'retry_same_level' };
  const next = currentLevel + 1;
  if (next > 4) return { level: 4, action: 'user_notification' };
  return { level: next, action: cascadeActionForLevel(next) };
}

export function cascadeActionForLevel(level) {
  switch (level) {
    case 1: return 'spawn_debugger';
    case 2: return 'producer_chain_reroute';
    case 3: return 'sub_tasker_extract_blocker';
    case 4: return 'request_mode_upgrade';
    default: return 'user_notification';
  }
}

/**
 * Build cascade event to append to state.json.events
 */
export function buildCascadeEvent(level, signal) {
  return {
    t: new Date().toISOString(),
    skill: 'stall-cascade',
    result: 'fail',
    declarer: 'hook',
    cause: 'stall_cascade',
    evidence: {
      type: 'parse',
      detail: `level=${level}, signals=${JSON.stringify(signal)}`,
    },
    level,
  };
}

/**
 * Summary for external hooks/loggers.
 */
export function summarize(state, { now = Date.now() } = {}) {
  const signals = detectStall(state, { now });
  const lastCascadeLevel = findLastCascadeLevel(state);
  return {
    stalled: signals.length > 0,
    signals,
    last_cascade_level: lastCascadeLevel,
    suggested_next_action: signals.length > 0
      ? cascadeActionForLevel(Math.min(4, lastCascadeLevel + 1))
      : null,
  };
}

function findLastCascadeLevel(state) {
  const events = (state?.events || []).slice().reverse();
  for (const e of events) {
    if (e.skill === 'stall-cascade' && typeof e.level === 'number') return e.level;
  }
  return 0;
}

// CLI entry: pass state.json path
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) { console.error('usage: stall-detector.mjs <state.json>'); process.exit(2); }
  if (!existsSync(target)) { console.error(`not found: ${target}`); process.exit(1); }
  const state = JSON.parse(readFileSync(target, 'utf-8'));
  const summary = summarize(state);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.stalled ? 3 : 0);
}
