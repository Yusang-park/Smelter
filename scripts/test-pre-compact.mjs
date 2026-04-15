#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const output = execFileSync(
  'node',
  ['/Users/yusang/smelter/scripts/pre-compact.mjs'],
  {
    input: JSON.stringify({ session_id: 'test-session' }),
    encoding: 'utf8',
    env: { ...process.env, DISABLE_COMPACT: '1' },
  },
);

const lines = output.trim().split('\n');
const payload = JSON.parse(lines[lines.length - 1]);

assert.deepEqual(payload, { decision: 'block' });

console.log('pre-compact test passed');
