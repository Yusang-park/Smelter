import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    pass++;
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.message}`);
    fail++;
  }
}

function readProjectFile(relativePath) {
  return readFileSync(join(PROJECT_ROOT, relativePath), 'utf-8');
}

check('project CLAUDE.md is not a symlink to global CLAUDE.md', () => {
  const projectClaude = join(PROJECT_ROOT, 'CLAUDE.md');
  const globalClaude = join(homedir(), '.claude', 'CLAUDE.md');
  const stat = lstatSync(projectClaude);

  if (stat.isSymbolicLink()) {
    assert.equal(readlinkSync(projectClaude), 'AGENTS.md');
  }
  if (existsSync(globalClaude)) {
    assert.notEqual(projectClaude, globalClaude);
  }
});

check('hook configs do not invoke rule-injector', () => {
  const files = ['hooks/hooks.json', 'settings.json'];
  for (const file of files) {
    assert.doesNotMatch(readProjectFile(file), /rule-injector\.mjs/);
  }
});

check('tracked docs do not describe automatic rules-lib injection', () => {
  const files = [
    'CLAUDE.md',
    'AGENTS.md',
    'README.md',
    'document/index.md',
    'document/workflow.md',
    'document/workflow.ko.md',
    'document/implementation.md',
  ];

  for (const file of files) {
    const content = readProjectFile(file);
    assert.doesNotMatch(content, /rule-injector|Inject: rules-lib|auto-injected via `rules-lib|auto-injected\)/i, file);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
