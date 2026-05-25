#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskArtifact, validateTaskReviewArtifact } from './task-artifact-contract.mjs';

const VALID_TASKS = `---
schema_version: "0.55"
target_type: bug_fix
surface: ["scripts/foo.mjs"]
---

# tasks

- [x] goal: fix foo behavior
- [x] approach: smallest guarded branch
- [ ] queue: add RED test, patch source, run checks
- [x] works: acceptance path named
- [x] omissions: no reviewed feature omitted
- [x] verified: test/typecheck/e2e commands listed
- [x] team_runtime: write-test=A, coding=A, agent-review=B, e2e=A
`;

const VALID_REVIEW = `---
schema_version: "0.55"
verdict: pass
consensus: 0.95
---

# tasks-review

- [x] works: queue covers expected behavior
- [x] omissions: no feature or review concern is missing
- [x] verified: validation commands are named
- [x] side_effects: none beyond scoped surface
- [x] decision: pass
`;

test('v0.55 tasks.md contract accepts compact checkbox artifact', () => {
  assert.deepEqual(validateTaskArtifact(VALID_TASKS), []);
});

test('v0.55 tasks.md contract rejects prose-only legacy artifact', () => {
  const errors = validateTaskArtifact('# Tasks\n\nLong markdown prose without checklist.\n');
  assert.ok(errors.some(e => /schema_version/.test(e)), errors.join('\n'));
  assert.ok(errors.some(e => /checkbox/.test(e)), errors.join('\n'));
  assert.ok(errors.some(e => /team_runtime/.test(e)), errors.join('\n'));
});

test('v0.55 tasks.md contract requires completed scope and verification checks', () => {
  const invalid = VALID_TASKS
    .replace('- [x] works:', '- [ ] works:')
    .replace('- [x] omissions:', '- [ ] omissions:')
    .replace('- [x] verified:', '- [ ] verified:')
    .replace('- [x] team_runtime:', '- [ ] team_runtime:');
  const errors = validateTaskArtifact(invalid);
  assert.ok(errors.some(e => /works/.test(e)), errors.join('\n'));
  assert.ok(errors.some(e => /omissions/.test(e)), errors.join('\n'));
  assert.ok(errors.some(e => /verified/.test(e)), errors.join('\n'));
  assert.ok(errors.some(e => /team_runtime/.test(e)), errors.join('\n'));
});

test('v0.55 tasks-review.md contract requires pass review checkboxes', () => {
  assert.deepEqual(validateTaskReviewArtifact(VALID_REVIEW), []);
});

test('v0.55 tasks-review.md contract rejects pass without omissions verification', () => {
  const invalid = VALID_REVIEW.replace('- [x] omissions: no feature or review concern is missing\n', '');
  const errors = validateTaskReviewArtifact(invalid);
  assert.ok(errors.some(e => /omissions/.test(e)), errors.join('\n'));
});
