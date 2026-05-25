import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CAVEMAN_SYSTEM_PROMPT } from './defaults.js';

const ROOT = process.cwd();
const UPSTREAM_SKILL = readFileSync(join(ROOT, 'skills', 'caveman', 'SKILL.md'), 'utf8');

test('CAVEMAN_SYSTEM_PROMPT matches vendored caveman skill', () => {
  assert.equal(CAVEMAN_SYSTEM_PROMPT, UPSTREAM_SKILL);
  assert.equal(CAVEMAN_SYSTEM_PROMPT.includes('[RESPONSE STYLE: CONCISE]'), false);
  assert.match(CAVEMAN_SYSTEM_PROMPT, /Respond terse like smart caveman\./);
});
