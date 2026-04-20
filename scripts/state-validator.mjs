#!/usr/bin/env node
/**
 * state-validator.mjs — Evidence integrity validation for state.json.
 *
 * Enforces Iron Law #5 "File is truth" by cross-checking that every
 * `completed_stages` entry has a matching `events[]` entry with
 *   - result === 'pass'
 *   - evidence.path pointing at a file that exists on disk
 *
 * Called from state-schema.writeState() before writeFileSync, so any state
 * with forged completed_stages (added without a real skill invocation
 * producing an artifact) throws at write time.
 *
 * Critic-watchdog R13 uses the same checker on PostToolUse so Bash-based
 * writes that bypass PreToolUse still get caught.
 */

import { existsSync, statSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve, basename } from 'node:path';

// Expected artifact basename per skill. When the skill is in this map,
// evidence.path must resolve to this exact basename — prevents forging
// evidence by pointing at an unrelated existing file (e.g. plan.md used as
// proof for workflow-investigate).
export const SKILL_ARTIFACT_BASENAME = Object.freeze({
  'workflow-brainstorm':        'brainstorm.md',
  'workflow-brainstorm-review': 'brainstorm-review.md',
  'workflow-investigate':       'investigation.md',
  'workflow-investigate-review': 'investigation-review.md',
  'workflow-tasker':            'tasks.md',
  'workflow-tasker-review':     'tasks-review.md',
});

/**
 * validateEvidenceIntegrity
 *
 * @param {object} state — parsed state.json
 * @param {string} statePath — absolute or relative path to the state.json file;
 *   used to resolve relative evidence.path entries.
 * @returns {string[]} — array of human-readable errors. Empty means valid.
 *
 * Behavior:
 *   - Empty completed_stages → pass (initial seed is trivially valid).
 *   - Each completed_stages entry must have a matching events[] with
 *     skill == entry, result == 'pass'. Missing pass event → "no pass event".
 *   - That pass event must carry evidence.path. Missing → "no evidence.path".
 *   - The evidence file must exist on disk (relative paths are resolved
 *     against the state.json's parent directory). Missing file →
 *     "evidence.path does not exist".
 *
 * Intentional non-checks (kept simple to avoid false positives):
 *   - mtime ≥ created_at is NOT enforced (artifacts may predate the task
 *     when a previous session's output is referenced).
 *   - Event ordering is not enforced.
 */
export function validateEvidenceIntegrity(state, statePath) {
  const errors = [];
  if (!state || typeof state !== 'object') return errors;

  const completed = Array.isArray(state.completed_stages) ? state.completed_stages : [];
  if (completed.length === 0) return errors;

  const events = Array.isArray(state.events) ? state.events : [];
  const baseDir = dirname(isAbsolute(statePath) ? statePath : resolve(statePath));

  const absStatePath = isAbsolute(statePath) ? statePath : resolve(statePath);

  for (const stage of completed) {
    const passEvents = events.filter(e => e && e.skill === stage && e.result === 'pass');
    if (passEvents.length === 0) {
      errors.push(`[Watchdog] Forged stage detected: ${stage} has no pass event in events[]`);
      continue;
    }

    // Evidence must: (a) exist, (b) be a regular file (not symlink/dir/device),
    // (c) be non-empty, (d) not equal the state file itself (tautology guard),
    // (e) for skills with a canonical artifact, match the expected basename
    //     so an attacker cannot cite an unrelated workflow artifact as proof.
    const expectedBasename = SKILL_ARTIFACT_BASENAME[stage];
    let hasValidEvidence = false;
    const defects = [];
    for (const ev of passEvents) {
      const path = ev.evidence?.path;
      if (!path) { defects.push('missing'); continue; }
      const abs = isAbsolute(path) ? path : resolve(baseDir, path);
      if (abs === absStatePath) { defects.push(`tautological (${path})`); continue; }
      if (!existsSync(abs)) { defects.push(`does not exist (${path})`); continue; }
      try {
        const lst = lstatSync(abs);
        if (lst.isSymbolicLink()) { defects.push(`symlink (${path})`); continue; }
        if (!lst.isFile()) { defects.push(`not a file (${path})`); continue; }
        if (lst.size === 0) { defects.push(`empty file (${path})`); continue; }
      } catch (e) { defects.push(`stat error (${path})`); continue; }
      if (expectedBasename && basename(abs) !== expectedBasename) {
        defects.push(`wrong basename for ${stage} — expected ${expectedBasename}, got ${basename(abs)}`);
        continue;
      }
      hasValidEvidence = true;
      break;
    }

    if (!hasValidEvidence) {
      errors.push(`[Watchdog] Forged stage detected: ${stage} — evidence.path defects: ${defects.join('; ')}`);
    }
  }

  return errors;
}

// CLI entry: validate a state.json file from disk.
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) { console.error('usage: state-validator.mjs <state.json>'); process.exit(2); }
  try {
    const { readFileSync } = await import('node:fs');
    const state = JSON.parse(readFileSync(target, 'utf-8'));
    const errs = validateEvidenceIntegrity(state, target);
    if (errs.length) {
      console.error('INVALID:\n  ' + errs.join('\n  '));
      process.exit(1);
    }
    console.log(`OK: ${target}`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}
