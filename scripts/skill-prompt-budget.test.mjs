#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function readSkill(name) {
  return readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf-8');
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

test('high-traffic workflow skill prompts stay compact without losing gates', () => {
  const cases = [
    {
      name: 'workflow-coding',
      maxWords: 650,
      required: ['workflow-agent-review', 'RED', 'typecheck', 'scoped tests', 'workflow-human-check'],
    },
    {
      name: 'workflow-e2e',
      maxWords: 900,
      required: ['real interface', 'artifacts', 'effect', 'workflow-e2e-review', 'no mocks'],
    },
    {
      name: 'workflow-human-check',
      maxWords: 900,
      required: ['AskUserQuestion', 'results.md', 'finalize-human-check.mjs', 'git commit', 'complete', 'rework', 'hold', 'upgrade'],
    },
  ];

  for (const c of cases) {
    const text = readSkill(c.name);
    assert.ok(wordCount(text) <= c.maxWords, `${c.name} exceeds ${c.maxWords} words: ${wordCount(text)}`);
    for (const token of c.required) {
      assert.match(text, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${c.name} missing ${token}`);
    }
  }
});

test('workflow-human-check complete path uses native choice with explicit git actions', () => {
  const text = readSkill('workflow-human-check');
  assert.match(text, /AskUserQuestion/);
  assert.match(text, /Plain-text menus.*invalid/i);
  assert.match(text, /Do not render the options as Markdown\/plain text/i);
  assert.match(text, /complete-commit-current[\s\S]*git commit/i);
  assert.match(text, /complete-new-branch-pr[\s\S]*gh pr create/i);
  assert.match(text, /Do not ask a second git-options question/i);
  assert.doesNotMatch(text, /If unavailable, present the exact labels/i, 'human-check must not allow prose fallback menus');
});
