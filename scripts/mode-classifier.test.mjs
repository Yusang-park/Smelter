#!/usr/bin/env node
/**
 * mode-classifier.test.mjs — Unit tests for classify() and classifyChain().
 *
 * Rule-based detection only; run with `node scripts/mode-classifier.test.mjs`.
 */

import { classify, classifyChain, firstSentence } from './mode-classifier.mjs';

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
section('T1: Korean declarative 한다 suffix (feature: harness-integrity-4-fixes)');
// ---------------------------------------------------------------------------
assert('파악한다 -> investigate', classify('무엇이 문제인지 파악한다').mode, 'investigate');
assert('분석한다 -> investigate', classify('이 모듈을 분석한다').mode, 'investigate');
assert('조사한다 -> investigate', classify('코드를 조사한다').mode, 'investigate');
assert('파악했다 -> investigate', classify('이미 파악했다').mode, 'investigate');
assert('분석한다면 -> investigate', classify('그걸 분석한다면').mode, 'investigate');

// ---------------------------------------------------------------------------
section('T1-bis: bare-stem robustness');
// ---------------------------------------------------------------------------
assert('검증한답니다 -> investigate', classify('검증한답니다').mode, 'investigate');
assert('분석하세요 -> investigate', classify('분석하세요').mode, 'investigate');
assert('파악하시겠습니까 -> investigate', classify('파악하시겠습니까').mode, 'investigate');

// ---------------------------------------------------------------------------
section('T1: paste-pollution resistance (first-sentence extraction)');
// ---------------------------------------------------------------------------
assert(
  'paste-polluted 수정 block -> investigate',
  classify('파악한다.\n\n이전 대화 붙여넣기: 텍스트 수정 문구 수정 스타일 수정').mode,
  'investigate',
);
assert(
  'paste with ⏺ marker -> investigate',
  classify('파악해줘\n\n⏺ 수정 진행했습니다 텍스트 수정').mode,
  'investigate',
);
assert(
  'long multi-line with prior convo -> investigate',
  classify([
    '무엇이 문제인지 파악한다.',
    '',
    '⏺ 수정 진행했습니다. 텍스트 수정 / 스타일 수정.',
    '❯ 왜 안되지? 수정 필요.',
  ].join('\n')).mode,
  'investigate',
);

// ---------------------------------------------------------------------------
section('H1: simple_fix — doc/comment/guide add patterns');
// ---------------------------------------------------------------------------
// Pure documentation or comment-addition requests must route to simple_fix,
// not fall through to DEFAULT_MODE='fix' which triggers the full repair chain.
assert('가이드를 넣어줘 -> simple_fix', classify('Read 툴을 쓰도록 가이드를 넣어줘').mode, 'simple_fix');
assert('가이드 추가해 -> simple_fix', classify('사용 가이드 추가해').mode, 'simple_fix');
assert('주석 달아줘 -> simple_fix', classify('이 함수에 주석 달아줘').mode, 'simple_fix');
assert('주석 넣어 -> simple_fix', classify('주석 넣어').mode, 'simple_fix');
assert('문서 보강 -> simple_fix', classify('문서 보강').mode, 'simple_fix');
assert('문서화해 -> simple_fix', classify('이 모듈 문서화해').mode, 'simple_fix');
assert('docstring 추가 -> simple_fix', classify('add a docstring here').mode, 'simple_fix');
assert('add a comment -> simple_fix', classify('add a comment for this branch').mode, 'simple_fix');
// Negatives — prevent over-reach into fix/implement/plan.
assert('주석까지 해결해 -> fix', classify('주석까지 해결해').mode, 'fix');
assert('설명 넣어서 로직 추가해줘 -> implement (not simple_fix)',
  classify('이 함수에 설명 넣어서 로직 추가해줘').mode, 'implement');
assert('API 문서화 리팩토링해줘 -> plan (not simple_fix)',
  classify('API 문서화 리팩토링해줘').mode, 'plan');
assert('문서화 설계해 -> plan (not simple_fix)',
  classify('문서화 체계 설계해').mode, 'plan');
// Compound doc + implement — the noun+add should NOT absorb the implement verb.
assert('주석 추가하고 로직 구현해줘 -> implement (not simple_fix)',
  classify('주석 추가하고 로직 구현해줘').mode, 'implement');
assert('가이드 추가하고 기능 만들어줘 -> implement (not simple_fix)',
  classify('가이드 추가하고 기능 만들어줘').mode, 'implement');

// ---------------------------------------------------------------------------
section('T1: firstSentence helper');
// ---------------------------------------------------------------------------
assert('cuts at first blank line', firstSentence('파악한다.\n\n[paste]'), '파악한다.');
assert('cuts at chevron marker', firstSentence('파악한다 ⏺ 수정'), '파악한다');
assert('empty input -> empty', firstSentence(''), '');
assert('non-string -> empty', firstSentence(null), '');

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}`);
  process.exit(1);
}
process.exit(0);
