#!/usr/bin/env node
// session-start-smt.mjs
// Injects response style + TDD context at session start.
// Feature/task state is NO LONGER injected here — read .smt/ files directly when needed.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { printTag } from './lib/yellow-tag.mjs';

printTag('Session Start');

try { readFileSync('/dev/stdin', 'utf8'); } catch {}

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAVEMAN_SKILL_PATH = join(HARNESS_ROOT, 'skills', 'caveman', 'SKILL.md');

function loadCavemanContext() {
  try {
    return readFileSync(CAVEMAN_SKILL_PATH, 'utf8');
  } catch {
    return '';
  }
}

// Auto-update check: compare local vs remote cached ref.
function checkAutoUpdate() {
  const gitDir = join(HARNESS_ROOT, '.git');
  if (!existsSync(gitDir)) return null;
  try {
    const status = execFileSync('git', ['rev-list', '--count', 'HEAD..@{u}'], { cwd: HARNESS_ROOT, timeout: 2000, encoding: 'utf-8', stdio: 'pipe' }).trim();
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
  if (!existsSync(join(HARNESS_ROOT, '.git'))) return;
  try {
    const p = spawn('git', ['fetch', '--quiet'], { cwd: HARNESS_ROOT, detached: true, stdio: 'ignore' });
    p.unref();
  } catch { /* ignore */ }
}

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(HARNESS_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

function syncCodexModeConfig() {
  const configPath = join(homedir(), '.smt', 'config.json');
  let current = {};
  try {
    if (existsSync(configPath)) {
      current = JSON.parse(readFileSync(configPath, 'utf8'));
    }
  } catch {
    current = {};
  }

  const codexMode = process.env.SMELTER_MODEL_MODE === 'codex' || process.env.CODEX_MODE === '1';
  if (current.codexMode === codexMode) return;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ ...current, codexMode }, null, 2) + '\n');
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
  syncCodexModeConfig();
  const updateNotice = checkAutoUpdate() || '';
  const cavemanContext = loadCavemanContext();
  backgroundFetch();
  emit(cavemanContext + (updateNotice ? `\n\n${updateNotice}` : ''));
} catch (err) {
  process.stderr.write(`[session-start-smt] error: ${err.message}\n`);
  process.stdout.write(JSON.stringify({ continue: true }));
}
