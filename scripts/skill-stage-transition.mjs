#!/usr/bin/env node
/**
 * skill-stage-transition.mjs — PostToolUse hook for the `Skill` tool.
 *
 * Closes the "skill invocation ≠ stage completion" gap. Without this hook,
 * invoking `workflow-investigate` (or any other workflow skill) does not
 * advance state.json — the agent was able to forge completed_stages by
 * editing the file directly. This hook is the single legitimate writer for
 * skill-driven stage transitions.
 *
 * Security properties:
 *   - statePath must match the canonical /.smt/features/<slug>/task/<task>.state.json
 *     shape. Reject redirect attacks where active_task points elsewhere.
 *   - The state file cannot be a symlink (lstat check).
 *   - Evidence.path must point at a skill-specific artifact, not the state
 *     file itself (tautology guard). If the expected artifact does not
 *     exist yet, completed_stages is NOT appended — only current_stage is
 *     set. This gates genuine completion on real producer output.
 *   - All writes go through state-schema.writeState() so evidence integrity
 *     is re-validated on every transition.
 *
 * Registered in hooks/hooks.json under PostToolUse matcher "Skill".
 */

import { readFileSync, existsSync, lstatSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeState, appendEvent, markComplete } from './state-schema.mjs';
import { SKILL_ARTIFACT_BASENAME } from './state-validator.mjs';
import { detectReviewVerdict, detectReviewFailCause } from './auto-confirm.mjs';
import { loadWorkflowConfig, getMode as getV3Mode, selectPipeline as v3SelectPipeline } from './lib/workflow-loader.mjs';
import { transitionV4State } from './lib/workflow-v4-state.mjs';
import { resolveHookSessionId } from './lib/session-paths.mjs';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = dirname(__dirname);

// Entry-command skills (UserPromptSubmit routes `/fix`, `/explore`, etc.
// as `Skill(skill: '<command>')`). When the agent invokes one of these, the
// hook seeds `current_stage` from the mode's `entry_skill` so the Stop hook
// does not loop on a stale null/seeded stage, while `completed_stages` is
// kept empty (Iron Law #5 — no forged completion).
const COMMAND_TO_MODE_ENTRY = Object.freeze({
  brainstorm: 'brainstorm',
  fix: 'fix',
  infra: 'infra',
  explore: 'explore',
  implement: 'implement',
  verify: 'verify',
  dobby: 'dobby',
});

function normalizeSkillName(skill) {
  return String(skill || '').replace(/^\/+/, '');
}

function loadModeEntrySkill(mode) {
  try {
    const cfg = loadWorkflowConfig({ root: PLUGIN_ROOT });
    const m = getV3Mode(mode, cfg);
    return m && typeof m.entry_skill === 'string' ? m.entry_skill : null;
  } catch { return null; }
}

function readStdinJson() {
  try { return JSON.parse(readFileSync('/dev/stdin', 'utf-8')); } catch { return {}; }
}

function printTag(msg) {
  process.stderr.write(`\x1b[33m[smelter] skill-stage-transition · ${msg}\x1b[0m\n`);
}

// Skills whose invocation must NOT auto-mark completed — they produce multi-round
// output (E2E artifacts, review verdicts, human gate). Real completion is written
// separately by the skill's own pass event after artifacts are verified.
const COMPLETION_DEFERRED_SKILLS = new Set([
  'workflow-verify',
  'workflow-e2e',
  'workflow-e2e-review',
  'workflow-agent-review',
  'workflow-team-code-review',
  'workflow-human-check',
]);

// Skill → expected artifact filename inside the feature's task/ directory.
// Single source of truth: imported from state-validator.mjs (SKILL_ARTIFACT_BASENAME).
// Skills not present in that map (workflow-write-test, workflow-coding) evidence
// completion through other signals — test_cycles[] and git diff respectively —
// so resolveArtifactPath returns null for them.

// Canonical state.json shape: /.../.smt/features/<slug>/task/<slug-or-name>.state.json
const STATE_PATH_RE = /[\/\\]\.smt[\/\\]features[\/\\][^\/\\]+[\/\\]task[\/\\][^\/\\]+\.state\.json$/;

function resolveActiveState(cwd, sessionId) {
  // Session-isolated: per-session pointer primary, non-scoped fallback only
  // when session_id is absent. Global `.smt/active_task` deprecated — see
  // session-isolation migration 2026-04-20.
  const pointerPath = sessionId
    ? join(cwd, '.smt', 'state', `active-feature-${sessionId}.json`)
    : join(cwd, '.smt', 'state', 'active-feature.json');
  if (!existsSync(pointerPath)) return null;
  let target = null;
  try {
    const ptr = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    if (ptr?.slug) {
      target = join(cwd, '.smt', 'features', ptr.slug, 'task', `${ptr.slug}.state.json`);
    }
  } catch { return null; }
  if (!target || !existsSync(target)) return null;

  // Shape validation — reject arbitrary paths (redirect attack).
  if (!STATE_PATH_RE.test(target)) {
    printTag(`rejected non-canonical active_task pointer: ${target}`);
    return null;
  }

  // Symlink rejection — target must be a regular file.
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) {
      printTag(`rejected symlink/non-file statePath: ${target}`);
      return null;
    }
  } catch { return null; }

  // Containment — statePath must be strictly inside cwd. path.relative handles
  // separator ambiguity and the "same-path" edge case cleanly: a non-escape
  // path yields a relative with no leading ".." segment.
  const rel = relative(resolve(cwd), resolve(target));
  if (!rel || rel.startsWith('..') || resolve(target) === resolve(cwd)) {
    printTag(`statePath escapes project root: ${target}`);
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(target, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.mode !== 'string' || !Array.isArray(parsed.allowed_skills)) {
      printTag(`statePath has no valid state shape: ${target}`);
      return null;
    }
    return { path: target, state: parsed };
  } catch { return null; }
}

function resolveArtifactPath(statePath, skill) {
  const artifactName = SKILL_ARTIFACT_BASENAME[skill];
  if (artifactName === null || artifactName === undefined) return null;
  const taskDir = dirname(statePath);
  return join(taskDir, artifactName);
}

function stepForWorkflowSkill(skill) {
  if (skill === 'workflow-brainstorm' || skill === 'workflow-brainstorm-review' || skill === 'workflow-tasker' || skill === 'workflow-tasker-review' || skill === 'workflow-implementation-plan' || skill === 'workflow-implementation-plan-review' || skill === 'workflow-infra-plan' || skill === 'workflow-infra-plan-review') {
    return 'PLAN';
  }
  if (skill === 'workflow-investigate' || skill === 'workflow-investigate-review') return 'DISCOVERY';
  if (skill === 'workflow-write-test') return 'TEST_DESIGN';
  if (skill === 'workflow-coding' || skill === 'workflow-infra-execute') return 'EXECUTE';
  if (skill === 'workflow-verify' || skill === 'workflow-e2e' || skill === 'workflow-e2e-review' || skill === 'workflow-agent-review' || skill === 'workflow-team-code-review') {
    return 'VERIFY';
  }
  if (skill === 'workflow-human-check') return 'HUMAN_CHECK';
  return null;
}

function transitionBridgedV4Step(state, skill) {
  if (!state || typeof state.task_type !== 'string' || !Array.isArray(state.step_flow)) return;
  const nextStep = stepForWorkflowSkill(skill);
  if (!nextStep || !state.step_flow.includes(nextStep)) return;
  transitionV4State(state, nextStep);
}

function main() {
  printTag('enter');
  try {
    const input = readStdinJson();
    if (input.tool_name !== 'Skill') {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const skill = normalizeSkillName(input.tool_input?.skill || '');
    const isWorkflowSkill = skill.startsWith('workflow-');
    const isEntryCommand = Object.prototype.hasOwnProperty.call(COMMAND_TO_MODE_ENTRY, skill);
    if (!isWorkflowSkill && !isEntryCommand) {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const cwd = input.cwd || process.cwd();
    const active = resolveActiveState(cwd, resolveHookSessionId(input));
    if (!active) {
      printTag(`no valid active state — skipping`);
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const { path: statePath, state } = active;

    // Entry-command branch: seed current_stage from mode entry_skill and exit.
    // completed_stages is NOT touched — Iron Law #5 requires artifact-backed
    // completion which entry seeding cannot provide.
    if (isEntryCommand) {
      const expectedMode = COMMAND_TO_MODE_ENTRY[skill];
      if (state.mode !== expectedMode) {
        printTag(`entry-command ${skill} does not match state.mode=${state.mode} — no-op`);
        process.stdout.write(JSON.stringify({ continue: true }));
        return;
      }
      const entrySkill = loadModeEntrySkill(expectedMode);
      if (!entrySkill || !Array.isArray(state.allowed_skills) || !state.allowed_skills.includes(entrySkill)) {
        printTag(`entry_skill ${entrySkill} unavailable for mode ${expectedMode} — no-op`);
        process.stdout.write(JSON.stringify({ continue: true }));
        return;
      }
      const alreadyAtEntry = state.current_stage === entrySkill;
      state.current_stage = entrySkill;
      transitionBridgedV4Step(state, entrySkill);
      const prevFlag = process.env.SMT_HOOK_WRITE;
      process.env.SMT_HOOK_WRITE = '1';
      try {
        writeState(statePath, state);
      } finally {
        if (prevFlag === undefined) delete process.env.SMT_HOOK_WRITE;
        else process.env.SMT_HOOK_WRITE = prevFlag;
      }
      printTag(`entry-command ${skill} → current_stage=${entrySkill}${alreadyAtEntry ? ' (idempotent)' : ''}`);
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    if (!Array.isArray(state.allowed_skills) || !state.allowed_skills.includes(skill)) {
      printTag(`skill ${skill} not in allowed_skills of mode ${state.mode} — warn only`);
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const now = new Date().toISOString();
    state.current_stage = skill;
    transitionBridgedV4Step(state, skill);

    // Resolve genuine artifact path; if missing, defer completion but still
    // record current_stage. Tautological evidence (path === statePath) is
    // explicitly forbidden.
    const artifactPath = resolveArtifactPath(statePath, skill);
    const artifactExists = artifactPath ? (existsSync(artifactPath) && statSync(artifactPath).isFile() && statSync(artifactPath).size > 0) : false;

    // Only write a pass event when we have a real artifact to cite. Skills
    // without a canonical artifact (workflow-coding / workflow-write-test)
    // must produce their own pass event via separate mechanisms.
    const alreadyHasPass = (state.events || []).some(e => e.skill === skill && e.result === 'pass');
    const alreadyHasFail = (state.events || []).some(e => e.skill === skill && e.result === 'fail');
    if (artifactExists && !alreadyHasPass && !alreadyHasFail) {
      if (!Array.isArray(state.events)) state.events = [];
      // Review-skill verdict inspection: for *-review artifacts the stage's
      // canonical output is the verdict itself. If the review artifact
      // declares 'fail', the hook must write a fail event — NOT pass — so
      // decide()'s route-on-fail branch routes back to the upstream
      // producer instead of pickNextStage advancing forward.
      const isReviewSkill = /-review$/.test(skill);
      let result = 'pass';
      let cause = null;
      if (isReviewSkill) {
        try {
          const artifactText = readFileSync(artifactPath, 'utf-8');
          const verdict = detectReviewVerdict(artifactText);
          if (verdict === 'fail') {
            result = 'fail';
            cause = detectReviewFailCause(artifactText);
          }
        } catch { /* unreadable artifact → treat as pass (legacy behavior) */ }
      }
      const event = {
        t: now, skill, result, declarer: 'hook',
        evidence: { type: 'file_present', path: artifactPath },
      };
      if (cause) event.cause = cause;
      state.events.push(event);
    }

    // Historical pipeline re-selection behavior, retained in v0.4 for
    // target_type_dispatch modes after investigate.
    // After workflow-investigate-review passes, the investigation.md frontmatter
    // may declare target_type + file_count + surface. If the mode declares
    // target_type_dispatch, we re-run selectPipeline with those signals and, if
    // the resulting pipeline differs from the current allowed_skills, re-write
    // state.allowed_skills. This closes the gap where non-magic-keyword flows
    // stayed on the mode's default pipeline regardless of target_type. v0.4 keeps
    // /implement on full; target_type is implementation-plan context only.
    if (skill === 'workflow-investigate-review' || skill === 'workflow-tasker' || skill === 'workflow-implementation-plan') {
      try {
        const artifactForScope = skill === 'workflow-tasker'
          ? 'tasks.md'
          : skill === 'workflow-implementation-plan'
            ? 'implementation-plan.md'
            : 'investigation.md';
        const scopePath = join(dirname(statePath), artifactForScope);
        if (existsSync(scopePath)) {
          const raw = readFileSync(scopePath, 'utf-8');
          const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const fm = yaml.load(fmMatch[1]) ?? {};
            // Extract scope signals. Tolerate missing fields.
            if (typeof fm.target_type === 'string') state.target_type = fm.target_type;
            // Number.isFinite rejects NaN + Infinity + string coercions that `typeof === 'number'` would accept.
            if (Number.isFinite(fm.file_count) && fm.file_count >= 0) state.file_count = fm.file_count;
            if (Array.isArray(fm.surface)) state.surface = fm.surface;

            // Only re-select for target_type_dispatch modes with a resolved target_type.
            const modeCfg = getV3Mode(state.mode);
            if (modeCfg?.target_type_dispatch && state.target_type) {
              const cfg = loadWorkflowConfig();
              const newPipeline = v3SelectPipeline(state.mode, {
                target_type: state.target_type,
                file_count: state.file_count,
                surface_count: Array.isArray(state.surface) ? state.surface.length : 0,
              }, cfg);
              if (newPipeline && newPipeline !== 'upgrade_required' && cfg.pipelines[newPipeline]) {
                const newSkills = [...cfg.pipelines[newPipeline]];
                const cur = Array.isArray(state.allowed_skills) ? state.allowed_skills : [];
                // Preserve already-completed stages even if they're not in the new
                // pipeline. Preserve completed stages even when re-selection narrows
                // remaining work in a future mode-specific branch.
                // This is a one-way narrowing: remaining stages may shrink, but the
                // audit trail of what already ran stays complete.
                const completed = Array.isArray(state.completed_stages) ? state.completed_stages : [];
                // Preserve ALL already-completed stages (even those not in `cur`) so the
                // audit trail never loses history during repeated re-selections.
                const converged = Array.from(new Set([...completed, ...newSkills]));
                if (JSON.stringify(converged) !== JSON.stringify(cur)) {
                  state.allowed_skills = converged;
                  // No synthetic event — events[].skill is enum-constrained to
                  // WORKFLOW_SKILLS. The state change itself (allowed_skills
                  // narrowed) is the audit. Stderr tag records the decision.
                  printTag(`pipeline re-select: ${state.mode}/${state.target_type} → ${newPipeline} (${newSkills.length} skills)`);
                }
              }
            }
          }
        }
      } catch (err) {
        printTag(`pipeline-resolver warn: ${err.message}`);
      }
    }

    // completed_stages append rule:
    //   - Skill must NOT be in deferred set (e2e / reviews / human-check)
    //   - A matching pass event must exist (either pre-existing or just added)
    //   - Idempotent: don't double-append
    const hasValidPass = (state.events || []).some(
      e => e.skill === skill && e.result === 'pass' && e.evidence?.path && existsSync(
        /^(?:[a-zA-Z]:)?[\/\\]/.test(e.evidence.path) ? e.evidence.path : resolve(dirname(statePath), e.evidence.path)
      )
    );
    if (!COMPLETION_DEFERRED_SKILLS.has(skill) && hasValidPass) {
      if (!Array.isArray(state.completed_stages)) state.completed_stages = [];
      if (!state.completed_stages.includes(skill)) {
        state.completed_stages.push(skill);
      }
    }

    // Route through writeState() so evidence integrity is re-checked on every
    // write. Scope the escape-hatch env var to the single write call via
    // try/finally so children spawned by any future refactor don't inherit.
    const prevFlag = process.env.SMT_HOOK_WRITE;
    process.env.SMT_HOOK_WRITE = '1';
    try {
      writeState(statePath, state);
    } finally {
      if (prevFlag === undefined) delete process.env.SMT_HOOK_WRITE;
      else process.env.SMT_HOOK_WRITE = prevFlag;
    }
    printTag(`${skill} → current_stage${state.completed_stages?.includes(skill) ? ' + completed' : ' (deferred: ' + (!artifactExists ? 'no artifact' : 'deferred-list') + ')'}`);
    process.stdout.write(JSON.stringify({ continue: true }));
  } catch (err) {
    process.stderr.write(`[skill-stage-transition] self-error: ${err.message}\n`);
    process.stdout.write(JSON.stringify({ continue: true }));
  }
}

main();
