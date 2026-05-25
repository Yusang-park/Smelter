/** Shared helpers for UserPromptSubmit hook scripts. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { sanitizeSessionId } from './session-paths.mjs';

const DEFAULT_TTL_MS = 60_000;

function detectionFile(cwd, sessionId) {
  return join(cwd, '.smt', 'state', `last-detection-${sessionId}.json`);
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export function checkReentrancyOrBail(processLike = process) {
  if (process.env.SMELTER_CLASSIFIER_SUBPROCESS !== '1') return false;
  processLike.stdout.write(JSON.stringify({ continue: true }));
  return true;
}

export function writeLastDetection({ cwd, sessionId: sessionIdRaw, payload }) {
  const sessionId = sanitizeSessionId(sessionIdRaw);
  if (!sessionId) return null;
  const stateDir = join(cwd, '.smt', 'state');
  mkdirSync(stateDir, { recursive: true });
  const record = {
    session_id: sessionId,
    ts: Date.now(),
    detection: payload,
  };
  const file = detectionFile(cwd, sessionId);
  writeAtomic(file, JSON.stringify(record, null, 2));
  return file;
}

export function readLastDetection({ cwd, sessionId: sessionIdRaw, ttlMs = DEFAULT_TTL_MS }) {
  const sessionId = sanitizeSessionId(sessionIdRaw);
  if (!sessionId) return null;
  const file = detectionFile(cwd, sessionId);
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, 'utf-8'));
    if (record.session_id !== sessionId) return null;
    if (typeof record.ts !== 'number') return null;
    if (Date.now() - record.ts > ttlMs) return null;
    return record;
  } catch {
    return null;
  }
}
