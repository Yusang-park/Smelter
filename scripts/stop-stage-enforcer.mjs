#!/usr/bin/env node
// stop-stage-enforcer.mjs
// Stop hook — workflow stage progression enforcer.
//
// Replaces the previous stop-e2e.mjs (E2E-only reminder) with a unified
// stage-enforcement layer:
//   1. Workflow modes cannot halt before reaching a terminal stage
//      (workflow-human-check, done, or the mode's last allowed_skill).
//      When current_stage is non-terminal we emit `decision: block` with a
//      "advance to <next>" reason so the agent resumes via the next workflow
//      skill.
//   2. Mid-flow stall detection: when session-tracked source files exist
//      AND the stage is non-terminal, the block reason is enriched with a
//      "mid-flow" hint so the agent knows to resume rather than report
//      "complete".
//   3. Legacy E2E reminder is preserved as a fallback / surface-aware text:
//      when the next stage is workflow-e2e and summary.json marks
//      e2e_required, the reason includes the changed-file count and type
//      so the prior UX is intact.
//   4. Non-Smelter project (no .smt) → SKIP.
//
// Source of truth: state.json.allowed_skills + state.json.completed_stages.
// summary.json is read only for surface-aware reminder enhancement.

import { existsSync, readFileSync, writeFileSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { printTag } from './lib/yellow-tag.mjs';

// Stuck-loop escape: if the SAME state signature triggers a block this many
// consecutive times with no progress, allow Stop to pass with a warning so
// the agent (and user) can break the loop. Without this, an agent stuck
// producing only text (no tool calls → no PostToolUse → no state change)
// will block forever — observed 2026-04-20 in another session.
export const STUCK_LOOP_THRESHOLD = 3;

const __filename = fileURLToPath(import.meta.url);

// Modes whose Stop must reach a terminal stage before halting. All Smelter
// workflow modes are included so each mode's workflow chain is properly
// enforced. Single-stage modes (simple_fix / verify) pass via
// isTerminalStage() because their only allowed_skill is the last.
export const WORKFLOW_MODES_FOR_STAGE_GUARD = new Set([
  'fix', 'implement', 'plan', 'investigate', 'verify', 'simple_fix',
]);

// Always-terminal stages — any mode reaching these may halt.
export const ALWAYS_TERMINAL_STAGES = new Set(['workflow-human-check', 'done']);

export function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function findActiveStatePath(cwd, sessionId) {
  // Session-isolated resolution. Per-session pointer is primary; non-scoped
  // pointer is the session-less fallback (legacy CLI / sim only). The global
  // `.smt/active_task` pointer was deprecated in the migration after
  // investigation 2026-04-20 — concurrent sessions would overwrite it and
  // strand each other's workflow chains.
  const candidates = [];
  if (sessionId) {
    candidates.push(join(cwd, '.smt', 'state', `active-feature-${sessionId}.json`));
  } else {
    candidates.push(join(cwd, '.smt', 'state', 'active-feature.json'));
  }
  for (const pointerPath of candidates) {
    if (!existsSync(pointerPath)) continue;
    try {
      const ptr = JSON.parse(readFileSync(pointerPath, 'utf-8'));
      if (!ptr?.slug) continue;
      const candidate = join(cwd, '.smt', 'features', ptr.slug, 'task', `${ptr.slug}.state.json`);
      if (existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

export function getActiveFeatureSummary(projectDir, sessionId) {
  const candidates = [];
  if (sessionId) {
    candidates.push(join(projectDir, '.smt', 'state', `active-feature-${sessionId}.json`));
  }
  candidates.push(join(projectDir, '.smt', 'state', 'active-feature.json'));

  for (const pointerPath of candidates) {
    const pointer = readJsonFile(pointerPath);
    if (!pointer?.slug) continue;
    const summary = readJsonFile(join(projectDir, '.smt', 'features', pointer.slug, 'state', 'summary.json'));
    if (!summary) continue;
    return { slug: pointer.slug, ...summary };
  }

  return null;
}

export function trackingPathFor(cwd) {
  const hash = createHash('md5').update(cwd).digest('hex').slice(0, 8);
  return `/tmp/smelter-session-files-${hash}.json`;
}

// Per-project + per-session loop counter so concurrent sessions don't
// share each other's stuck-loop state.
export function loopCounterPathFor(cwd, sessionId) {
  const projectHash = createHash('md5').update(cwd).digest('hex').slice(0, 8);
  const sessHash = sessionId
    ? createHash('md5').update(String(sessionId)).digest('hex').slice(0, 8)
    : 'no-session';
  return `/tmp/smelter-stop-loop-${projectHash}-${sessHash}.json`;
}

// Build a stable signature for the current "stuck position". When the state
// changes (stage advances, mode flips, slug swaps), the signature changes
// and the counter resets.
export function stateSignature(state) {
  if (!state) return 'no-state';
  const slug = state.task_id || '?';
  const stage = state.current_stage || 'null';
  const completed = (state.completed_stages || []).length;
  const mode = state.mode || '?';
  return `${slug}:${mode}:${stage}:${completed}`;
}

// Increment / reset the loop counter and return the current count for the
// signature. Resets when signature changes.
export function bumpLoopCounter(cwd, sessionId, signature) {
  const path = loopCounterPathFor(cwd, sessionId);
  let prior = null;
  try {
    if (existsSync(path)) {
      // Symlink rejection — mirrors auto-confirm.bumpAutoConfirmLoop. On a
      // shared /tmp, a pre-planted symlink could redirect writes. Session
      // UUIDs make exploitation impractical, but the lstat check is cheap
      // defense-in-depth.
      const lst = lstatSync(path);
      if (lst.isSymbolicLink() || !lst.isFile()) return 1;
      prior = JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {}
  const now = Date.now();
  const stale = prior && now - (prior.last_seen || 0) > 30 * 60 * 1000;
  if (!prior || stale || prior.signature !== signature) {
    const fresh = { signature, count: 1, first_seen: now, last_seen: now };
    try { writeFileSync(path, JSON.stringify(fresh), { mode: 0o600 }); } catch {}
    return 1;
  }
  const next = { ...prior, count: prior.count + 1, last_seen: now };
  try { writeFileSync(path, JSON.stringify(next), { mode: 0o600 }); } catch {}
  return next.count;
}

export function clearLoopCounter(cwd, sessionId) {
  try { unlinkSync(loopCounterPathFor(cwd, sessionId)); } catch {}
}

export function readTrackedFiles(cwd) {
  const path = trackingPathFor(cwd);
  if (!existsSync(path)) return null;
  try {
    const arr = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

const TEST_PATTERNS = [
  /\.test\./, /\.spec\./, /^test_/, /_test\./,
  /\/tests?\//, /\/spec\//, /\/e2e\//, /\/integration\//,
];
const DOC_CONFIG_PATTERNS = [
  /\.(md|json|yaml|yml|toml|lock|env)$/,
  /^\.github\//i, /^\.vscode\//i, /^docs?\//i,
];

export function isSourceFile(f) {
  const base = f.split('/').pop();
  const isTest = TEST_PATTERNS.some((p) => p.test(base) || p.test(f));
  const isDoc = DOC_CONFIG_PATTERNS.some((p) => p.test(f));
  return !isTest && !isDoc;
}

export function detectSurfaceTypes(files) {
  const types = new Set();
  for (const f of files) {
    if (/scripts\/|hooks\//.test(f)) types.add('hook');
    if (/\bbin\/|\bcli\b/i.test(f)) types.add('cli');
    if (/\b(routes?|handlers?|controllers?|api)\b/i.test(f)) types.add('api');
    if (/\.(tsx|jsx)$|\b(components?|pages?|ui)\b/i.test(f)) types.add('ui');
    if (/\b(lib|utils?|adapters?|services?)\b/i.test(f)) types.add('lib');
  }
  return [...types];
}

// Decide what next stage the agent should enter, based on the mode's
// allowed_skills minus completed_stages and the current_stage. Order-aware:
// when current_stage is in allowed_skills, prefer the next uncompleted stage
// AFTER it in chain order; otherwise fall back to the first uncompleted-and-
// not-current allowed skill, or 'workflow-human-check' if none remain.
export function pickNextStage(state) {
  const allowed = state?.allowed_skills || [];
  const completed = new Set(state?.completed_stages || []);
  const current = state?.current_stage || '';
  const currentIdx = allowed.indexOf(current);
  if (currentIdx >= 0) {
    for (let i = currentIdx + 1; i < allowed.length; i++) {
      if (!completed.has(allowed[i])) return allowed[i];
    }
  }
  const remaining = allowed.filter(s => !completed.has(s) && s !== current);
  return remaining[0] || 'workflow-human-check';
}

// Check whether current_stage is terminal for the active mode.
// A stage is terminal when:
//   - it is in ALWAYS_TERMINAL_STAGES, or
//   - it is the last entry of state.allowed_skills (mode's chain end)
export function isTerminalStage(state) {
  const stage = state?.current_stage;
  if (!stage) return false;
  if (ALWAYS_TERMINAL_STAGES.has(stage)) return true;
  const allowed = state?.allowed_skills || [];
  if (allowed.length > 0 && allowed[allowed.length - 1] === stage) return true;
  return false;
}

// Build the block reason. When the next stage is workflow-e2e AND
// summary.e2e_required is set, format like the legacy E2E reminder so
// surface-aware UX is preserved. Otherwise emit a generic [Stage] reason
// with optional mid-flow enrichment.
//
// When `current_stage` is a seeded entry that has NO pass event yet, the
// message should read as "enter the stage" rather than "advance to next".
// Otherwise the agent is told to move past a stage it never actually ran.
export function buildBlockReason({ state, nextStage, summary, sourceFiles }) {
  const slug = summary?.slug || state?.task_id || 'active';
  const surfaceLabel = sourceFiles && sourceFiles.length > 0
    ? `[${detectSurfaceTypes(sourceFiles).join(', ') || 'source'}]`
    : '';
  const trackedNote = sourceFiles && sourceFiles.length > 0
    ? `${sourceFiles.length} file(s) changed ${surfaceLabel}`
    : 'no tracked files';

  // Legacy E2E reminder pathway (surface-aware) — keep prior UX intact.
  if (
    nextStage === 'workflow-e2e' &&
    summary?.e2e_required &&
    !summary?.e2e_done &&
    summary?.status !== 'complete'
  ) {
    return `[E2E] ${trackedNote} on feature ${slug}. workflow-e2e stage required.`;
  }

  const midFlow = sourceFiles && sourceFiles.length > 0;
  const stageInfo = `mode=${state?.mode || '?'}, stage=${state?.current_stage || 'null'}`;
  const trackedInfo = midFlow ? ` (${trackedNote})` : '';

  // Entry-not-started detection: fresh seed with nothing done yet
  // (no completed_stages, no events). Tell the agent to ENTER the current
  // stage — not to advance past it. This avoids the misleading "advance to
  // workflow-investigate-review" when workflow-investigate itself has not
  // been invoked yet.
  const currentStage = state?.current_stage;
  const completedEmpty = !Array.isArray(state?.completed_stages) || state.completed_stages.length === 0;
  const eventsEmpty = !Array.isArray(state?.events) || state.events.length === 0;
  if (currentStage && completedEmpty && eventsEmpty) {
    const tag = midFlow ? '[Stage] mid-flow' : '[Stage] entry_not_started';
    return `${tag}: invoke Skill(skill: '${currentStage}') to execute the current stage — ${stageInfo}${trackedInfo}`;
  }

  const tag = midFlow ? '[Stage] mid-flow' : '[Stage] non-terminal';
  return `${tag}: advance to ${nextStage} — ${stageInfo}${trackedInfo}`;
}

export function evaluate({ state, summary, sourceFiles, cwd }) {
  // No state means non-Smelter or unseeded — don't block.
  if (!state) {
    // Legacy fallback: if summary says e2e_required and source files changed,
    // still emit the E2E reminder so old behavior holds for projects that
    // haven't been migrated to state-based stages.
    if (summary?.e2e_required && !summary?.e2e_done && summary?.status !== 'complete'
        && sourceFiles && sourceFiles.length > 0) {
      const surfaceLabel = `[${detectSurfaceTypes(sourceFiles).join(', ') || 'source'}]`;
      return {
        action: 'block',
        reason: `[E2E] ${sourceFiles.length} file(s) changed ${surfaceLabel} on feature ${summary.slug}. workflow-e2e stage required.`,
      };
    }
    return { action: 'continue' };
  }

  // Modes outside the workflow set (none currently, but guards against future
  // additions) → don't enforce stage progression; defer to legacy E2E reminder.
  if (!WORKFLOW_MODES_FOR_STAGE_GUARD.has(state.mode)) {
    if (summary?.e2e_required && !summary?.e2e_done && summary?.status !== 'complete'
        && sourceFiles && sourceFiles.length > 0) {
      const surfaceLabel = `[${detectSurfaceTypes(sourceFiles).join(', ') || 'source'}]`;
      return {
        action: 'block',
        reason: `[E2E] ${sourceFiles.length} file(s) changed ${surfaceLabel} on feature ${summary.slug}. workflow-e2e stage required.`,
      };
    }
    return { action: 'continue' };
  }

  // Workflow mode — enforce terminal stage.
  if (isTerminalStage(state)) return { action: 'continue' };

  const nextStage = pickNextStage(state);
  return {
    action: 'block',
    reason: buildBlockReason({ state, nextStage, summary, sourceFiles }),
  };
}

// CLI entry
function main() {
  printTag('Stage Enforcer');

  let stdinJson = {};
  try {
    stdinJson = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
  } catch {}
  const cwd = stdinJson.cwd || process.cwd();

  const SKIP = () => {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  };

  // Non-Smelter project bail
  if (!existsSync(join(cwd, '.smt'))) SKIP();

  const statePath = findActiveStatePath(cwd, stdinJson.session_id);
  const state = statePath ? readJsonFile(statePath) : null;
  const summary = getActiveFeatureSummary(cwd, stdinJson.session_id);
  const trackedRaw = readTrackedFiles(cwd) || [];
  const sourceFiles = trackedRaw.filter(isSourceFile);

  const result = evaluate({ state, summary, sourceFiles, cwd });

  if (result.action === 'continue') {
    clearLoopCounter(cwd, stdinJson.session_id);
    SKIP();
  }

  // Loop-detection: if the same state signature has triggered N consecutive
  // blocks (no PostToolUse:Skill advanced state in between), allow Stop with
  // a stuck-loop warning so the agent can escape and the user can intervene.
  const signature = stateSignature(state);
  const count = bumpLoopCounter(cwd, stdinJson.session_id, signature);
  if (count >= STUCK_LOOP_THRESHOLD) {
    clearLoopCounter(cwd, stdinJson.session_id);
    console.error(`\x1b[33m[smelter] Stop · stuck-loop escape (signature=${signature}, fired ${count}x)\x1b[0m`);
    console.log(JSON.stringify({
      continue: true,
      systemMessage: `[smelter] Stuck-loop escape: same state (${signature}) triggered Stop ${count} times with no progress. Allowing Stop. Inspect .smt/active_task or run /cancel to clear stale state.`,
    }));
    process.exit(0);
  }

  // Block: clear tracking file so the next round starts fresh once the agent
  // resumes (legacy stop-e2e.mjs cleared it on every block; preserve that).
  try { unlinkSync(trackingPathFor(cwd)); } catch {}

  console.error(`\x1b[33m[smelter] Stop · stage-enforcer (block ${count}/${STUCK_LOOP_THRESHOLD})\x1b[0m`);
  console.log(JSON.stringify({ decision: 'block', reason: result.reason }));
  process.exit(0);
}

if (process.argv[1] && process.argv[1] === __filename) {
  main();
}
