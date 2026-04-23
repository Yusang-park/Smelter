#!/usr/bin/env node
/**
 * session-paths.test.mjs — canonical session-path helpers.
 * Focus of this revision: sessionId sanitizer hardened against DoS via
 * arbitrarily long sessionIds, after workflow-state-seeder and
 * state-contract-injector consolidated on this module as the single
 * source of truth for sessionId validation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const MODULE = './session-paths.mjs';

test('SP1: sanitizeSessionId accepts UUID-form sessionId', async () => {
  const { sanitizeSessionId } = await import(MODULE);
  assert.equal(sanitizeSessionId('3cf0d611-4ce4-44b5-a4c6-05b314b49b87'),
    '3cf0d611-4ce4-44b5-a4c6-05b314b49b87');
});

test('SP2: sanitizeSessionId rejects path traversal', async () => {
  const { sanitizeSessionId } = await import(MODULE);
  assert.equal(sanitizeSessionId('../../../tmp/evil'), '');
  assert.equal(sanitizeSessionId('/abs/path'), '');
  assert.equal(sanitizeSessionId('a\r\nb'), '');
  assert.equal(sanitizeSessionId('a\0b'), '');
});

test('SP3: sanitizeSessionId rejects strings longer than 128 chars (DoS cap)', async () => {
  const { sanitizeSessionId } = await import(MODULE);
  const long = 'a'.repeat(129);
  assert.equal(sanitizeSessionId(long), '', '>128 chars rejected');
  const maxOk = 'a'.repeat(128);
  assert.equal(sanitizeSessionId(maxOk), maxOk, 'exactly 128 accepted');
});

test('SP4: sanitizeSessionId returns empty on non-string / empty input', async () => {
  const { sanitizeSessionId } = await import(MODULE);
  assert.equal(sanitizeSessionId(null), '');
  assert.equal(sanitizeSessionId(undefined), '');
  assert.equal(sanitizeSessionId(''), '');
  assert.equal(sanitizeSessionId(123), '');
});
