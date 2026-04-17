#!/usr/bin/env node
// session-start-smt.mjs
// Injects response style + TDD context at session start.
// Feature/task state is NO LONGER injected here — read .smt/ files directly when needed.

import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { printTag } from './lib/yellow-tag.mjs';

printTag('Session Start');

try { readFileSync('/dev/stdin', 'utf8'); } catch {}

const CAVEMAN_CONTEXT = `[RESPONSE STYLE: CONCISE]
Remove filler words, pleasantries, and hedging from all responses.
Keep articles, grammar, and complete sentences intact.
Technical terms, code blocks, and error messages must be exact and unchanged.
If safety warnings, security issues, or irreversible actions are involved, use full clear prose regardless.`;

// Auto-update check: compare local vs remote cached ref.
function checkAutoUpdate() {
  const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const gitDir = join(harnessRoot, '.git');
  if (!existsSync(gitDir)) return null;
  try {
    const status = execFileSync('git', ['rev-list', '--count', 'HEAD..@{u}'], { cwd: harnessRoot, timeout: 2000, encoding: 'utf-8', stdio: 'pipe' }).trim();
    const behind = parseInt(status, 10);
    if (behind > 0) {
      printTag(`Update: ${behind} commit(s) behind`);
      return `[SMELTER UPDATE AVAILABLE] ${behind} commit(s) behind origin. Run \`git pull && npm run build\` in the smelter directory.`;
    }
  } catch { /* offline or not a git repo — skip silently */ }
  return null;
}

// Background fetch — spawn and forget.
import { spawn } from 'child_process';
function backgroundFetch() {
  const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (!existsSync(join(harnessRoot, '.git'))) return;
  try {
    const p = spawn('git', ['fetch', '--quiet'], { cwd: harnessRoot, detached: true, stdio: 'ignore' });
    p.unref();
  } catch { /* ignore */ }
}

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

function emit(additionalContext) {
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
}

try {
  const version = getVersion();
  printTag(`Smelter v${version}`);
  const updateNotice = checkAutoUpdate() || '';
  backgroundFetch();
  emit(CAVEMAN_CONTEXT + (updateNotice ? `\n\n${updateNotice}` : ''));
} catch (err) {
  process.stderr.write(`[session-start-smt] error: ${err.message}\n`);
  process.stdout.write(JSON.stringify({ continue: true }));
}
