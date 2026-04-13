#!/usr/bin/env node
// stop-e2e.mjs
// Runs E2E after Claude finishes. exit 0 = pass/skip, exit 2 = fail (Claude continues)

import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const cwd = process.cwd();

// Only run E2E if code files were changed
function hasCodeChanges() {
  try {
    const result = execSync('git diff --name-only HEAD 2>/dev/null || git status --short', {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
    });
    const files = result.split('\n').filter((f) => f.trim());
    return files.some((f) => /\.(ts|tsx|js|jsx|py|go|rs)$/.test(f));
  } catch {
    return false;
  }
}

// Check if playwright config exists
function hasPlaywright() {
  return (
    existsSync(join(cwd, 'playwright.config.ts')) ||
    existsSync(join(cwd, 'playwright.config.js'))
  );
}

if (!hasCodeChanges() || !hasPlaywright()) {
  process.exit(0); // Nothing to test
}

console.error('[linear-harness] Running E2E tests...');

const result = spawnSync('npx', ['playwright', 'test', '--reporter=json'], {
  cwd,
  encoding: 'utf8',
  timeout: 90000,
});

if (result.status === 0) {
  console.error('[linear-harness] E2E passed');
  process.exit(0);
} else {
  const output = (result.stdout || '') + (result.stderr || '');
  let failures = output;
  try {
    const json = JSON.parse(result.stdout || '{}');
    const failed = (json.suites || [])
      .flatMap((s) => s.specs || [])
      .filter((s) => (s.tests || []).some((t) => (t.results || []).some((r) => r.status === 'failed')));
    if (failed.length > 0) {
      failures = failed
        .map((s) => `- ${s.title}: ${s.tests[0]?.results[0]?.error?.message || 'failed'}`)
        .join('\n');
    }
  } catch {
    // keep raw output as failures
  }

  console.log(`[LINEAR-HARNESS E2E FAILED]\n\n${failures}\n\nFix the above E2E failures.`);
  process.exit(2);
}
