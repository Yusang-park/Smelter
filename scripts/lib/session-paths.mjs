/**
 * session-paths.mjs — Per-session state file path helpers.
 *
 * Centralizes the canonical naming rule: `.smt/state/<prefix>-<sid>.json` or
 * `.smt/state/<prefix>-<sid>.jsonl`. sessionId must pass sanitizeSessionId;
 * callers should fall back to the unscoped path if sanitization rejects the
 * input.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function sanitizeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return '';
  return /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : '';
}

function stateDir(cwd) {
  return join(cwd, '.smt', 'state');
}

export function activePointerPath(cwd, sessionId) {
  const sid = sanitizeSessionId(sessionId);
  return sid
    ? join(stateDir(cwd), `active-feature-${sid}.json`)
    : join(stateDir(cwd), 'active-feature.json');
}

export function loadedSkillsPath(cwd, sessionId) {
  const sid = sanitizeSessionId(sessionId);
  return sid
    ? join(stateDir(cwd), `loaded-skills-${sid}.jsonl`)
    : join(stateDir(cwd), 'loaded-skills.jsonl');
}

export function terminalReminderPath(cwd, sessionId) {
  const sid = sanitizeSessionId(sessionId);
  return sid
    ? join(stateDir(cwd), `terminal-reminder-${sid}.json`)
    : join(stateDir(cwd), 'terminal-reminder.json');
}

export function configSnapshotPath(sessionId) {
  const sid = sanitizeSessionId(sessionId);
  const base = sid ? `smelter-config-snapshot-${sid}.json` : 'smelter-config-snapshot.json';
  return join('/tmp', base);
}

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

export function isValidSlug(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 128) return false;
  if (!SLUG_RE.test(s)) return false;
  // Reject path-traversal segments even when only dotted chars are present.
  if (s === '.' || s === '..') return false;
  if (s.includes('..')) return false;
  return true;
}

/**
 * Resolve the active feature's state file via the per-session pointer.
 * Returns { slug, statePath, state } or null if any step is missing/invalid.
 * Rejects slugs failing SLUG_RE to prevent path traversal via a corrupt pointer.
 */
export function resolveActiveState(cwd, sessionId) {
  const ptr = activePointerPath(cwd, sessionId);
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(ptr, 'utf-8'));
  } catch {
    return null;
  }
  const slug = pointer?.slug;
  if (!isValidSlug(slug)) return null;
  const statePath = join(cwd, '.smt', 'features', slug, 'task', `${slug}.state.json`);
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return { slug, statePath, state: null, error: 'state-parse-failed' };
  }
  return { slug, statePath, state };
}
