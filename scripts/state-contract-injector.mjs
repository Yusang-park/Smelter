#!/usr/bin/env node
/**
 * state-contract-injector.mjs — PreToolUse:Skill hook.
 *
 * Closes the long-standing contract gap: many workflow-* SKILL.md files
 * imply (or used to outright instruct) that the agent should append pass
 * events / completed_stages / current_stage transitions to `.state.json`
 * directly. In practice three layers refuse:
 *   1. `pre-tool-enforcer.mjs::PROTECTED_RE` blocks Claude Write/Edit on
 *      `.smt/**\/*.state.json`.
 *   2. The auto-mode permission classifier rejects the
 *      `SMT_HOOK_WRITE=1 node -e "appendEvent(...)"` workaround as
 *      Memory Poisoning.
 *   3. `skill-stage-transition.mjs::COMPLETION_DEFERRED_SKILLS` defers
 *      auto-pass for review / e2e / human-check skills.
 *
 * Net effect for the agent: state mutation is invisible from its tools'
 * perspective. The skill scripts + dedicated PostToolUse hooks
 * (skill-stage-transition.mjs, finalize-human-check.mjs, etc.) handle
 * every legitimate state write through fs.writeFileSync, which is exempt
 * from PreToolUse interception.
 *
 * This hook injects that contract verbatim as additionalContext into
 * every `Skill(workflow-*)` invocation, so the agent stops looping on
 * "I should write the pass event next" and instead proceeds immediately
 * to the skill's named artifact + the next required skill.
 *
 * Behavior:
 *   - Trigger: PreToolUse, tool_name === 'Skill', tool_input.skill matches
 *     /^workflow-/.
 *   - Output: JSON
 *       { continue: true,
 *         hookSpecificOutput: {
 *           hookEventName: 'PreToolUse',
 *           additionalContext: '<contract reminder>'
 *         } }
 *   - Never blocks; never errors fatally.
 *
 * Activation: requires Claude Code session restart after registering in
 * hooks/hooks.json (hook list is loaded once at session start).
 */

import { readFileSync } from 'node:fs';
import { seedWorkflowState } from './lib/workflow-state-seeder.mjs';
import { sanitizeSessionId, resolveActiveState } from './lib/session-paths.mjs';
import { NEXT_SKILL_ON_PASS, PRODUCER_OF, ALWAYS_ALLOWED, isTerminalStage } from './lib/workflow-chain.mjs';

const COMMAND_SKILLS = new Set(['fix', 'implement', 'investigate', 'verify', 'think']);

function isLastEventFail(events, stage) {
  if (!Array.isArray(events)) return false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.skill === stage) return e.result === 'fail';
  }
  return false;
}

// Returns null when the move is legal, or a human-readable reason string when
// it is not. Caller decides the emit shape.
function chainBlockReason(currentStage, requested, events) {
  if (currentStage == null) return null;              // no chain yet
  if (requested === currentStage) return null;        // idempotent re-entry
  if (ALWAYS_ALLOWED.has(requested)) return null;     // user escape
  // Terminal stages (no declared next) delegate the move to downstream
  // allowed_skills enforcement instead of rejecting here — the chain has no
  // opinion once the pipeline ends.
  if (isTerminalStage(currentStage)) return null;
  const expectedNext = NEXT_SKILL_ON_PASS[currentStage];
  if (requested === expectedNext) return null;        // forward on pass
  if (PRODUCER_OF[currentStage] === requested && isLastEventFail(events, currentStage)) {
    return null;                                      // fail-route to producer
  }
  return `[Smelter chain] Skill('${requested}') violates the declared pipeline from current stage '${currentStage}'. Expected one of: '${currentStage}' (re-entry), '${expectedNext}' (forward on pass), or 'workflow-human-check' (escape). Fix: dispatch the expected next skill, or invoke workflow-human-check to hand control back to the user.`;
}

const CONTRACT = [
  '[Smelter state-write contract]',
  '',
  'You do NOT write `.state.json` directly. The protected-path rule in pre-tool-enforcer.mjs',
  'blocks Write/Edit on those files, and the auto-mode permission classifier rejects the',
  '`SMT_HOOK_WRITE=1 node -e "appendEvent/markComplete/writeState"` workaround as memory poisoning.',
  '',
  'Hook scripts mutate state on your behalf:',
  '  - skill-stage-transition.mjs (PostToolUse:Skill) — writes pass / fail events for every',
  '    workflow skill NOT in COMPLETION_DEFERRED_SKILLS once its named artifact',
  '    (investigation.md, tasks.md, tasks-review.md, etc.) exists on disk. Deferred set:',
  '    {workflow-verify, workflow-e2e, workflow-e2e-review, workflow-agent-review,',
  '    workflow-team-code-review, workflow-human-check} — these need the named hook below',
  '    or self-record by reaching their terminal artifact.',
  '  - finalize-human-check.mjs (PostToolUse:Write) — when results.md is written under a',
  '    canonical task dir AND current_stage === workflow-human-check AND mode ∈ {fix, implement},',
  '    it writes the workflow-human-check pass event + completed_stages append automatically.',
  '',
  'What this means for you in this skill invocation:',
  '  1. Produce the skill\'s named artifact (per its SKILL.md `produces:` field).',
  '  2. Do NOT attempt to append to state.events, state.completed_stages, or set state.current_stage.',
  '  3. Do NOT run inline `node -e` / `node --input-type` to touch state.json. The classifier',
  '     refuses these even with SMT_HOOK_WRITE=1.',
  '  4. Proceed directly to the skill\'s required next step (per its "Terminal State" section).',
  '  5. If a stop-hook complaint about "stage incomplete" fires after the artifact exists, the',
  '     PostToolUse hook write is in flight or deferred — re-invoke the same Skill once and',
  '     advance; do not loop trying to write state yourself.',
  '',
  'workflow-human-check is special: write `results.md` and the finalize hook handles the rest.',
  'Older SKILL.md sections that instruct manual `appendEvent + markComplete + writeState` are',
  'obsolete (superseded by v3.3.3 and the related v3.3.2 ungate).',
].join('\n');

function readStdinJson() {
  try { return JSON.parse(readFileSync('/dev/stdin', 'utf-8')); } catch { return {}; }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function main() {
  try {
    const input = readStdinJson();
    if (input.tool_name !== 'Skill') { emit({ continue: true }); return; }

    // Re-entrancy guard — skip every side effect when this hook runs inside
    // the Haiku classifier subprocess spawned by keyword-detector.mjs.
    // Without this, Skill invocations issued by the classifier's own
    // child-process tree would double-seed.
    if (process.env.SMELTER_CLASSIFIER_SUBPROCESS === '1') {
      // Silent early-return previously made env-bleed bugs invisible — if a
      // wrapper script leaks this env into a non-classifier flow, the seed is
      // skipped and the code-file gate blocks every subsequent Edit/Write.
      // Emit a one-line diagnostic so the inheritance path is traceable.
      // Early-return semantics (continue:true) are unchanged.
      process.stderr.write('[state-contract-injector] SMELTER_CLASSIFIER_SUBPROCESS re-entrancy guard active — seed skipped\n');
      emit({ continue: true });
      return;
    }

    const skill = String(input.tool_input?.skill || input.toolInput?.skill || '');
    const args = String(input.tool_input?.args || input.toolInput?.args || '');
    const cwd = input.cwd || input.directory || process.cwd();
    const sessionId = sanitizeSessionId(input.session_id || input.sessionId || '');

    // Branch 1 — command-level skill invoked via the Skill tool.
    // UserPromptSubmit's keyword-detector never ran, so `.state.json`
    // would otherwise be missing and pre-tool-enforcer would block
    // every subsequent code edit. Seed inline, silently.
    if (COMMAND_SKILLS.has(skill)) {
      try {
        seedWorkflowState({
          directory: cwd,
          commandName: skill,
          prompt: '',
          sessionId,
          args,
          source: 'skill-tool',
          silent: true,
        });
      } catch (err) {
        process.stderr.write(`[state-contract-injector] seed error: ${err.message}\n`);
      }
      emit({ continue: true });
      return;
    }

    // Branch 2 — workflow-* skill. Inject the state-write contract.
    if (!/^workflow-/.test(skill)) { emit({ continue: true }); return; }

    // Branch 2a — chain enforcement. Block forward skips before the skill
    // loads, so the Skill tool never advances current_stage to an illegal
    // target. Absent state / null current_stage falls through to the
    // contract-injection branch (no chain to enforce yet); a *present but
    // unparseable* state file fails closed — we refuse the call rather than
    // let a corrupted-state attack silently disable enforcement.
    try {
      const active = resolveActiveState(cwd, sessionId);
      if (active && active.error === 'state-parse-failed') {
        const reason = `[Smelter chain] Active state file is present but unparseable. Refusing Skill('${skill}') to avoid a corrupted-state bypass. Invoke workflow-human-check to recover.`;
        emit({
          continue: false,
          stopReason: reason,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        });
        return;
      }
      if (active && active.state && typeof active.state === 'object') {
        const reason = chainBlockReason(active.state.current_stage, skill, active.state.events);
        if (reason) {
          emit({
            continue: false,
            stopReason: reason,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason,
            },
          });
          return;
        }
      }
    } catch (err) {
      process.stderr.write(`[state-contract-injector] chain-check error: ${err.message}\n`);
      // fail-open: never block on self-error.
    }

    emit({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: CONTRACT,
      },
    });
  } catch (err) {
    process.stderr.write(`[state-contract-injector] self-error: ${err.message}\n`);
    emit({ continue: true });
  }
}

main();
