#!/usr/bin/env node
/**
 * mode-classifier.test.mjs — Unit tests for classify() and classifyChain().
 *
 * Rule-based detection only; run with `node scripts/mode-classifier.test.mjs`.
 */

import { classify, classifyChain } from './mode-classifier.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push({ label, actual, expected });
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
  }
}

function section(title) {
  console.log(`\n[${title}]`);
}

// ---------------------------------------------------------------------------
section('Single-mode investigate (5 new verification keywords)');
// ---------------------------------------------------------------------------
assert('검증해봐 -> investigate', classify('검증해봐').mode, 'investigate');
assert('확인 좀 해줘 -> investigate', classify('확인 좀 해줘').mode, 'investigate');
assert('체크해 -> investigate', classify('체크해').mode, 'investigate');
assert('verify this -> investigate', classify('verify this').mode, 'investigate');
assert('validate the config -> investigate', classify('validate the config').mode, 'investigate');

// ---------------------------------------------------------------------------
section('Chained intents (5 cases)');
// ---------------------------------------------------------------------------
assert(
  '검증하고 수정해 -> [investigate, fix]',
  classify('검증하고 수정해').chained_modes,
  ['investigate', 'fix'],
);
assert(
  '파악한 뒤 리팩토링할거야 -> [investigate, plan]',
  classify('파악한 뒤 리팩토링할거야').chained_modes,
  ['investigate', 'plan'],
);
assert(
  '분석하고 구현해줘 -> [investigate, implement]',
  classify('분석하고 구현해줘').chained_modes,
  ['investigate', 'implement'],
);
assert(
  '설계하고 구현해줘 -> [plan, implement]',
  classify('설계하고 구현해줘').chained_modes,
  ['plan', 'implement'],
);
assert(
  'validate and then fix -> [investigate, fix]',
  classify('validate and then fix').chained_modes,
  ['investigate', 'fix'],
);

// ---------------------------------------------------------------------------
section('Non-chain negatives (3 cases that look like a chain but are not)');
// ---------------------------------------------------------------------------

// (1) Single verb with a trailing connective but no second action verb.
assert(
  '검증하고 -> single investigate, no chain',
  classify('검증하고').chained_modes,
  undefined,
);

// (2) Two verbs mapping to the SAME mode — not a chain.
assert(
  '버그 고쳐줘 수정해줘 -> single fix, no chain',
  classify('버그 고쳐줘 수정해줘').chained_modes,
  undefined,
);

// (3) Two verbs with NO connective between them (e.g., "verify fix" = single token pair).
assert(
  'verify fix -> single investigate, no chain',
  classify('verify fix').chained_modes,
  undefined,
);

// ---------------------------------------------------------------------------
section('classifyChain() direct API');
// ---------------------------------------------------------------------------
assert(
  'classifyChain(검증하고 수정해) modes',
  classifyChain('검증하고 수정해').modes,
  ['investigate', 'fix'],
);
assert(
  'classifyChain(hello world) null',
  classifyChain('hello world'),
  null,
);

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}`);
  process.exit(1);
}
process.exit(0);
