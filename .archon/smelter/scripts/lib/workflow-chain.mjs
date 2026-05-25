/**
 * workflow-chain.mjs — Single source of truth for the workflow skill
 * pipeline chain. Consumed by PreToolUse:Skill chain enforcer
 * (state-contract-injector.mjs) and PostToolUse terminal-state gate
 * (posttool-terminal-state-gate.mjs). Keeping both in one module closes
 * the drift window a rename would open.
 */

// Forward moves on pass. Ordered by pipeline position so the object
// also doubles as documentation of the full chain.
export const NEXT_SKILL_ON_PASS = Object.freeze({
  'workflow-brainstorm':          'workflow-brainstorm-review',
  'workflow-brainstorm-review':   'workflow-investigate',
  'workflow-investigate':         'workflow-investigate-review',
  'workflow-investigate-review':  'workflow-implementation-plan',
  'workflow-implementation-plan': 'workflow-implementation-plan-review',
  'workflow-implementation-plan-review': 'workflow-write-test',
  // Planning-only /brainstorm keeps tasker in its mode-specific allowed_skills;
  // nextSkillForState uses that order instead of this fallback.
  'workflow-tasker':              'workflow-tasker-review',
  'workflow-tasker-review':       'workflow-write-test',
  'workflow-write-test':          'workflow-coding',
  'workflow-coding':              'workflow-agent-review',
  'workflow-agent-review':        'workflow-e2e',
  'workflow-e2e':                 'workflow-e2e-review',
  'workflow-e2e-review':          'workflow-team-code-review',
  'workflow-team-code-review':    'workflow-human-check',
});

// Reverse producer map — derived, never hand-written, to eliminate the
// drift surface within this module.
export const PRODUCER_OF = Object.freeze(
  Object.fromEntries(
    Object.entries(NEXT_SKILL_ON_PASS).map(([producer, consumer]) => [consumer, producer])
  )
);

export function nextSkillForState(state, currentStage = state?.current_stage) {
  const allowed = Array.isArray(state?.allowed_skills) ? state.allowed_skills : [];
  const idx = allowed.indexOf(currentStage);
  if (idx >= 0 && idx < allowed.length - 1) return allowed[idx + 1];
  return NEXT_SKILL_ON_PASS[currentStage] ?? null;
}

export function producerForState(state, currentStage = state?.current_stage) {
  const allowed = Array.isArray(state?.allowed_skills) ? state.allowed_skills : [];
  const idx = allowed.indexOf(currentStage);
  if (idx > 0) return allowed[idx - 1];
  return PRODUCER_OF[currentStage] ?? null;
}

// Stages the user may always invoke, regardless of current_stage. The set
// is kept tiny — widening it weakens the chain.
export const ALWAYS_ALLOWED = Object.freeze(new Set(['workflow-human-check']));

// Terminal stages have no NEXT_SKILL_ON_PASS successor. Callers may use
// this to decide whether to let downstream gates (allowed_skills etc.)
// handle the move instead of rejecting at chain level.
export function isTerminalStage(stage) {
  return typeof stage === 'string' && !(stage in NEXT_SKILL_ON_PASS);
}
