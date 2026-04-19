#!/usr/bin/env node
// stop-e2e.mjs
// Session-scoped E2E reminder.
// Only checks files that Claude actually modified this session (tracked by post-tool-verifier).
// Outputs a minimal prompt to avoid token waste.
// E2E execution itself is Step 8 of the workflow — this hook only reminds, not enforces.

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { printTag } from './lib/yellow-tag.mjs';

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function getActiveFeatureSummary(projectDir) {
  const pointer = readJsonFile(join(projectDir, '.smt', 'state', 'active-feature.json'));
  if (!pointer?.slug) return null;
  const summary = readJsonFile(join(projectDir, '.smt', 'features', pointer.slug, 'state', 'summary.json'));
  if (!summary) return null;
  return { slug: pointer.slug, ...summary };
}

printTag('Run E2E');

const cwd = process.cwd();
const SKIP = () => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
};

const projectHash = createHash('md5').update(cwd).digest('hex').slice(0, 8);
const trackingFile = `/tmp/smelter-session-files-${projectHash}.json`;
if (!existsSync(trackingFile)) SKIP();

let sessionFiles;
try {
  sessionFiles = JSON.parse(readFileSync(trackingFile, 'utf-8'));
} catch {
  SKIP();
}
if (!Array.isArray(sessionFiles) || sessionFiles.length === 0) SKIP();

const TEST_PATTERNS = [
  /\.test\./, /\.spec\./, /^test_/, /_test\./,
  /\/tests?\//, /\/spec\//, /\/e2e\//, /\/integration\//,
];
const DOC_CONFIG_PATTERNS = [
  /\.(md|json|yaml|yml|toml|lock|env)$/,
  /^\.github\//i, /^\.vscode\//i, /^docs?\//i,
];

function isSourceFile(f) {
  const base = f.split('/').pop();
  const isTest = TEST_PATTERNS.some((p) => p.test(base) || p.test(f));
  const isDoc = DOC_CONFIG_PATTERNS.some((p) => p.test(f));
  return !isTest && !isDoc;
}

const sourceFiles = sessionFiles.filter(isSourceFile);
if (sourceFiles.length === 0) SKIP();

try { unlinkSync(trackingFile); } catch {}

function detectTypes(files) {
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

const types = detectTypes(sourceFiles);
const typeStr = types.length > 0 ? types.join(', ') : 'source';

const summary = getActiveFeatureSummary(cwd);
if (!summary) SKIP();
if (!summary.e2e_required || summary.e2e_done) SKIP();
if (summary.status === 'complete') SKIP();

const prompt = `[E2E] ${sourceFiles.length} file(s) changed [${typeStr}] on feature ${summary.slug}. Step 8 E2E required.`;

console.error('\x1b[33m[smelter] Stop · Step 8: E2E Validation\x1b[0m');
console.log(JSON.stringify({ decision: 'block', reason: prompt }));
process.exit(0);
