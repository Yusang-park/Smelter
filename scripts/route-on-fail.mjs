#!/usr/bin/env node
/**
 * route-on-fail.mjs — Producer chain router.
 *
 * Code implementation of the producer chain from workflow-v2.md section 5-1.
 * Accepts a fail event and determines the next skill (or action).
 *
 * Principle: no retries — only advance the producer chain.
 */

import { WORKFLOW_SKILLS } from './state-schema.mjs';

// workflow-v2.md §5-1 Producer Chain
const PRODUCER_CHAIN = Object.freeze({
  'workflow-brainstorm-review':   { onFail: 'workflow-brainstorm' },
  'workflow-investigate-review':  { onFail: 'workflow-investigate' },
  'workflow-tasker-review':       { onFail: 'workflow-tasker' },
  'workflow-write-test':          { onFail: 'workflow-tasker' },
  'workflow-coding': {
    // branch by cause
    onFailByCase: {
      tdd_cycle:       'workflow-write-test',
      scope_mismatch:  'workflow-tasker',
      typecheck:       'workflow-coding',  // self-rerun (state differs)
      lint:            'workflow-coding',
      test_run:        'workflow-coding',
    },
    onFailDefault: 'workflow-coding',
  },
  'workflow-agent-review':        { onFail: 'workflow-coding' },
  'workflow-verify': {
    // verify mode is non-modifying; any cause = code is broken → /fix
    onFailByCase: {
      test_run:   'workflow-coding',
      typecheck:  'workflow-coding',
      lint:       'workflow-coding',
      build:      'workflow-coding',
      assertion:  'workflow-coding',
    },
    onFailDefault: 'workflow-coding',
  },
  'workflow-e2e': {
    onFailByCase: {
      // §8 real-interface violations: re-run e2e with the correct runner
      // and NO mocks on the interface under test.
      artifact_missing:  'workflow-e2e',
      mocked_interface:  'workflow-e2e',
      // Code failures route to coding as before.
      assertion:         'workflow-coding',
      typecheck:         'workflow-coding',
      build:             'workflow-coding',
      test_run:          'workflow-coding',
    },
    onFailDefault: 'workflow-coding',
  },
  'workflow-e2e-review': {
    // branch by cause: missing artifacts re-run e2e; thin scenarios go to coding
    onFailByCase: {
      file_absent:           'workflow-e2e',
      insufficient_scenario: 'workflow-coding',
    },
    onFailDefault: 'workflow-coding',
  },
  'workflow-team-code-review': {
    // branch by severity
    onFailBySeverity: {
      CRITICAL: 'workflow-tasker',
      HIGH:     'workflow-tasker',
      MEDIUM:   'workflow-coding',
      LOW:      null,  // log to Risks and treat as pass
    },
    onFailDefault: 'workflow-coding',
  },
  'workflow-human-check': {
    // determined by active_feedback.target_skill
    onFail: 'dynamic:active_feedback',
    onFailDefault: 'workflow-coding',
  },
  // origin points: no producer
  'workflow-brainstorm':    { onFail: 'workflow-brainstorm' },   // self-rerun
  'workflow-investigate':   { onFail: 'workflow-investigate' },  // self-rerun
  'workflow-tasker':        { onFail: 'workflow-tasker' },       // self-rerun
});

/**
 * Reshape edge: when a review skill declares reshape, route back to a higher-level skill.
 * Reshape requires an explicit target in the event (evidence required).
 */
const RESHAPE_TARGETS = Object.freeze({
  'workflow-brainstorm-review': ['workflow-brainstorm'],
  'workflow-investigate-review': ['workflow-brainstorm', 'workflow-investigate'],
  'workflow-tasker-review': ['workflow-investigate', 'workflow-brainstorm'],
});

/**
 * Routing result:
 *   { target: "workflow-x", reason: "producer|reshape|severity|feedback", info: "..." }
 *   { target: null, reason: "pass|terminal", info: "..." }
 *   { target: null, reason: "whitelist_violation", info: "mode upgrade required" }
 */
export function route({ event, state, allowedSkills }) {
  const { skill, result, cause, evidence, severity, reshape_target } = event;
  allowedSkills = allowedSkills || state?.allowed_skills || [];

  if (result === 'pass') {
    return { target: null, reason: 'pass', info: `${skill} passed` };
  }

  if (result !== 'fail') {
    return { target: null, reason: 'unknown_result', info: `unknown: ${result}` };
  }

  // Reshape: when a review skill declares reshape
  if (reshape_target) {
    const allowed = RESHAPE_TARGETS[skill] || [];
    if (!allowed.includes(reshape_target)) {
      return { target: null, reason: 'reshape_invalid', info: `${reshape_target} not in ${JSON.stringify(allowed)}` };
    }
    return checkWhitelist(reshape_target, allowedSkills, 'reshape');
  }

  const rule = PRODUCER_CHAIN[skill];
  if (!rule) {
    return { target: null, reason: 'unknown_skill', info: `no producer rule for ${skill}` };
  }

  // severity-based (team-code-review)
  if (rule.onFailBySeverity && severity) {
    const target = rule.onFailBySeverity[severity];
    if (target === null) return { target: null, reason: 'low_severity_pass', info: 'logged to Risks, continue' };
    if (target) return checkWhitelist(target, allowedSkills, 'severity');
  }

  // cause-based (coding)
  if (rule.onFailByCase && cause && rule.onFailByCase[cause]) {
    return checkWhitelist(rule.onFailByCase[cause], allowedSkills, 'producer:cause');
  }

  // dynamic feedback-based (human-check)
  if (rule.onFail === 'dynamic:active_feedback') {
    const fb = (state?.active_feedback || []).find(f => !f.resolved);
    const target = fb?.target_skill || rule.onFailDefault;
    return checkWhitelist(target, allowedSkills, 'active_feedback');
  }

  // default
  const target = rule.onFail || rule.onFailDefault;
  return checkWhitelist(target, allowedSkills, 'producer');
}

function checkWhitelist(target, allowedSkills, reasonPrefix) {
  if (!target) return { target: null, reason: 'no_target', info: 'producer chain terminated' };
  if (!WORKFLOW_SKILLS.includes(target)) {
    return { target: null, reason: 'unknown_target', info: `${target} not a valid workflow skill` };
  }
  if (!allowedSkills.includes(target)) {
    return {
      target: null,
      reason: 'whitelist_violation',
      info: `${target} not in mode's allowed_skills — mode upgrade required`,
      suggested_upgrade_target: target,
    };
  }
  return { target, reason: reasonPrefix, info: `routing to ${target}` };
}

// CLI entry: JSON stdin → JSON stdout
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const input = readFileSync('/dev/stdin', 'utf-8');
  try {
    const payload = JSON.parse(input);
    const result = route(payload);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.reason === 'whitelist_violation' ? 2 : 0);
  } catch (e) {
    console.error('parse error:', e.message);
    process.exit(1);
  }
}
