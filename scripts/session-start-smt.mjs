#!/usr/bin/env node
// session-start-smt.mjs
// Injects TDD + caveman context + .smt/ feature task state at session start.
//
// Behavior:
//   - Reads features/*/task/_overview.md for feature plans
//   - Reads features/*/task/*.md (excluding _overview.md) for pending tasks
//   - If pending tasks exist → instruct Claude to notify the user

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { printTag } from './lib/yellow-tag.mjs';

printTag('Session Start');

let stdinData = {};
try { stdinData = JSON.parse(readFileSync('/dev/stdin', 'utf8')); } catch {}

const TDD_CONTEXT = `[SMELTER — TDD + E2E MODE]
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

// Find .smt/ directory from current dir upward (max 6 levels)
function findSmtDir(startDir) {
  let dir = resolve(startDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  for (let i = 0; i < 6; i++) {
    const smtPath = join(dir, '.smt');
    if (existsSync(smtPath)) return smtPath;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Returns { contextStr, pendingTasks }
function readSmtContext(smtDir) {
  const sections = [];
  const pendingTasks = [];

  const featuresDir = join(smtDir, 'features');
  if (existsSync(featuresDir)) {
    let slugs = [];
    try { slugs = readdirSync(featuresDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch {}

    for (const slug of slugs) {
      const taskDirPath = join(featuresDir, slug, 'task');
      if (!existsSync(taskDirPath)) continue;

      const overviewPath = join(taskDirPath, '_overview.md');
      if (existsSync(overviewPath)) {
        try {
          const content = readFileSync(overviewPath, 'utf8').slice(0, 2000);
          sections.push(`## Feature: ${slug} (.smt/features/${slug}/task/_overview.md)\n${content}`);
        } catch {}
      }

      let taskFiles = [];
      try { taskFiles = readdirSync(taskDirPath).filter(f => f.endsWith('.md') && f !== '_overview.md').sort(); } catch {}

      const taskLines = [];
      for (const f of taskFiles) {
        try {
          const content = readFileSync(join(taskDirPath, f), 'utf8').slice(0, 2000);
          const lines = content.split('\n');
          const filtered = lines.filter(l =>
            l.startsWith('# ') || l.startsWith('## ') ||
            l.includes('- [ ]') || l.includes('- [~]') || l.includes('- [!]')
          );
          for (const l of lines) {
            const m = l.match(/^[-*] \[[ ~!]\] (.+)$/);
            if (m) pendingTasks.push(m[1].trim());
          }
          if (filtered.length > 0) taskLines.push(`### ${f.replace(/\.md$/, '')}\n${filtered.join('\n')}`);
        } catch {}
      }
      if (taskLines.length > 0) {
        sections.push(`## Pending Tasks: ${slug}\n` + taskLines.join('\n\n'));
      }
    }
  }

  const contextStr = sections.length === 0 ? '' :
    `\n\n[SMELTER FILE-BASED MEMORY]\nAgents do not memorize — agents read files.\nStructure: .smt/features/<slug>/task/_overview.md + .smt/features/<slug>/task/<task-name>.md\n\n` +
    sections.join('\n\n');

  return { contextStr, pendingTasks };
}

function buildPendingNotification(pendingTasks) {
  const list = pendingTasks.map(t => `  - ${t}`).join('\n');
  return `

[SMELTER — PENDING TASKS DETECTED]
There are ${pendingTasks.length} incomplete or unstarted task(s) in .smt/:

${list}

INSTRUCTIONS FOR THIS SESSION START:
1. Immediately tell the user (in Korean if they communicate in Korean):
   "미완료 혹은 시작하지 않은 태스크가 있습니다 (${pendingTasks.length}개)."
2. List the pending tasks so the user can see them.
3. Do NOT start working on any task automatically — wait for explicit user instruction.`;
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
  const smtDir = findSmtDir();
  if (!smtDir) {
    emit(CAVEMAN_CONTEXT + '\n\n' + TDD_CONTEXT);
  } else {
    const { contextStr, pendingTasks } = readSmtContext(smtDir);
    let extra = contextStr;
    if (pendingTasks.length > 0) extra += buildPendingNotification(pendingTasks);
    emit(CAVEMAN_CONTEXT + '\n\n' + TDD_CONTEXT + extra);
  }
} catch (err) {
  process.stderr.write(`[session-start-smt] error: ${err.message}\n`);
  process.stdout.write(JSON.stringify({ continue: true }));
}
