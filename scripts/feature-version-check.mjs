#!/usr/bin/env node
// feature-version-check.mjs — Feature-state integrity check.
//
// Scans `.smt/features/*/` and reports whether each feature's state layout
// matches the current v2.3.0 schema (`task/<task>.state.json`).
//
// Surfaces orphan `state/workflow.json` files so operators can remove them.
// Never silently advances an orphan.

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LEGACY_WORKFLOW_STATE = 'state/workflow.json';

export function detectVersion(featureDir) {
  if (!existsSync(featureDir)) return 'none';
  const versionFile = join(featureDir, 'VERSION');
  if (existsSync(versionFile)) {
    const v = readFileSync(versionFile, 'utf-8').trim();
    if (v === 'current' || v === 'orphan') return v;
  }
  const orphanState = join(featureDir, LEGACY_WORKFLOW_STATE);
  const taskDir = join(featureDir, 'task');
  const hasOrphan = existsSync(orphanState);
  const hasCurrentState = existsSync(taskDir) && readdirSync(taskDir).some(f => f.endsWith('.state.json'));

  if (hasCurrentState && hasOrphan) return 'mixed';
  if (hasCurrentState) return 'current';
  if (hasOrphan) return 'orphan';
  return 'none';
}

export function setFeatureVersion(featureDir, version) {
  if (!['current', 'orphan'].includes(version)) throw new Error(`invalid version: ${version}`);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'VERSION'), version + '\n', 'utf-8');
}

export function listFeatures(cwd) {
  const featuresRoot = join(cwd, '.smt', 'features');
  if (!existsSync(featuresRoot)) return [];
  const out = [];
  for (const slug of readdirSync(featuresRoot)) {
    const dir = join(featuresRoot, slug);
    if (!statSync(dir).isDirectory()) continue;
    out.push({
      slug,
      dir,
      version: detectVersion(dir),
    });
  }
  return out;
}

export function integrityReport(cwd) {
  const all = listFeatures(cwd);
  return {
    current: all.filter(f => f.version === 'current'),
    orphan:  all.filter(f => f.version === 'orphan'),
    mixed:   all.filter(f => f.version === 'mixed'),
    none:    all.filter(f => f.version === 'none'),
    total:   all.length,
  };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] || 'report';
  const cwd = process.argv[3] || process.cwd();

  if (cmd === 'report') {
    console.log(JSON.stringify(integrityReport(cwd), null, 2));
    process.exit(0);
  }
  console.error('commands: report [cwd]');
  process.exit(2);
}
