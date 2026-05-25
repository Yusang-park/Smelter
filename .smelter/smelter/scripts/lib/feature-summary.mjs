import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function getActiveFeatureSlug(projectDir, sessionId = '') {
  const stateDir = join(projectDir, '.smt', 'state');
  const pointerPath = sessionId
    ? join(stateDir, `active-feature-${sessionId}.json`)
    : join(stateDir, 'active-feature.json');
  const pointer = readJsonFile(pointerPath);
  if (pointer?.slug) return pointer.slug;
  return null;
}

export function getFeatureSummary(projectDir, slug) {
  if (!slug) return null;
  return readJsonFile(join(projectDir, '.smt', 'features', slug, 'state', 'summary.json'));
}

export function getActiveFeatureSummary(projectDir, sessionId = '') {
  const slug = getActiveFeatureSlug(projectDir, sessionId);
  const summary = getFeatureSummary(projectDir, slug);
  if (!slug || !summary) return null;
  return { slug, ...summary };
}

export function writeFeatureSummary(projectDir, slug, patch) {
  const stateDir = join(projectDir, '.smt', 'features', slug, 'state');
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, 'summary.json');
  const current = readJsonFile(path) ?? {};
  const next = { ...current, ...patch };
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  return next;
}
