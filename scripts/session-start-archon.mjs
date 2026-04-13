#!/usr/bin/env node
// session-start-archon.mjs
// Injects TDD + caveman context + .archon/ plan at session start

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const TDD_CONTEXT = `[ARCHON HARNESS — TDD + E2E MODE]
You MUST follow Test-Driven Development:
1. Write tests FIRST (RED) — before any implementation code
2. Run tests — they MUST fail initially
3. Write minimal code to pass tests (GREEN)
4. Refactor (IMPROVE)
5. After all code changes, E2E tests will run automatically

CRITICAL RULES:
- NEVER write implementation before tests
- ALWAYS create test file before source file
- If tests don't exist for a feature, write them first
- E2E tests are mandatory — they will run automatically after your changes`;

const CAVEMAN_CONTEXT = `[RESPONSE STYLE: CONCISE]
Remove filler words, pleasantries, and hedging from all responses.
Keep articles, grammar, and complete sentences intact.
Technical terms, code blocks, and error messages must be exact and unchanged.
If safety warnings, security issues, or irreversible actions are involved, use full clear prose regardless.`;

// Load .archon/ context if present in working directory or parents
function findArchonDir(startDir) {
  let dir = resolve(startDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  for (let i = 0; i < 6; i++) {
    const archonPath = join(dir, '.archon');
    if (existsSync(join(archonPath, 'plan.md'))) return archonPath;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readArchonContext(archonDir) {
  const sections = [];
  const planPath = join(archonDir, 'plan.md');
  const tasksPath = join(archonDir, 'tasks.md');

  if (existsSync(planPath)) {
    sections.push('## Current Plan\n' + readFileSync(planPath, 'utf8').slice(0, 2000));
  }
  if (existsSync(tasksPath)) {
    const tasks = readFileSync(tasksPath, 'utf8');
    // Only show pending/in-progress tasks to keep context lean
    const lines = tasks.split('\n').filter(l =>
      l.startsWith('# ') || l.startsWith('## ') || l.includes('- [ ]') || l.includes('- [~]') || l.includes('- [!]')
    );
    if (lines.length > 0) {
      sections.push('## Pending Tasks (.archon/tasks.md)\n' + lines.join('\n'));
    }
  }

  if (sections.length === 0) return '';
  return `\n\n[ARCHON FILE-BASED MEMORY]\nAgents do not memorize — agents read files.\nThe following .archon/ context was loaded from disk:\n\n` + sections.join('\n\n');
}

const archonDir = findArchonDir();
const archonContext = archonDir ? readArchonContext(archonDir) : '';

process.stdout.write(JSON.stringify({
  type: 'system_prompt_prefix',
  content: CAVEMAN_CONTEXT + '\n\n' + TDD_CONTEXT + archonContext,
}));
