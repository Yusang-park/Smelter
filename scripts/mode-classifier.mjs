#!/usr/bin/env node
/**
 * mode-classifier.mjs — Classify natural-language input into a v2 mode.
 *
 * Principle (workflow-v2.md Iron Law #2 — no avoidance):
 *   - Rule-based pattern matching only. Do not delegate to LLM inference.
 *   - Explicit commands (/fix, /plan, etc.) always override.
 *   - Ambiguous input falls back to the safe default `fix`.
 *
 * Usage:
 *   import { classify } from './mode-classifier.mjs';
 *   const { mode, trigger, overridden } = classify('버그 고쳐줘');
 *   // → { mode: 'fix', trigger: 'keyword:버그', overridden: false }
 *
 * CLI:
 *   echo "리팩토링할거야" | node mode-classifier.mjs
 */

import { readFileSync } from 'node:fs';

const EXPLICIT_COMMANDS = {
  '/simple-fix': 'simple_fix',
  '/fix': 'fix',
  '/investigate': 'investigate',
  '/plan': 'plan',
  '/implement': 'implement',
};

// Order matters: more specific patterns first.
// Korean characters are outside \w, so avoid \b for Korean tokens.
// Priority: lower number = higher precedence (matched first).
const RULES = [
  {
    mode: 'simple_fix',
    priority: 5,
    patterns: [
      /텍스트\s*수정/,
      /이름\s*(?:바꿔|변경)/,
      /색(?:깔)?\s*(?:변경|바꿔)/,
      /\bcss\b/i,
      /스타일\s*(?:수정|변경)/,
      /오타/,
      /번역(?:\s*수정|\s*변경)?/,
      /문구\s*(?:수정|변경)/,
    ],
  },
  {
    mode: 'plan',
    priority: 8,
    patterns: [
      /만들\s*거야/,
      /만들려고/,
      /만들\s*예정/,
      /리팩토링(?:\s*할\s*거야|\s*할\s*예정|\s*할거야)?/,
      /설계해/,
      /기획해/,
      // "새 기능" (noun) alone is ambiguous — avoid matching without a planning verb,
      // otherwise "새 기능 추가해줘" wrongly routes to plan instead of implement.
      /새\s*(?:기능|피처|feature)\s*(?:만들|설계|기획)/i,
      /\brefactor\b/i,
    ],
  },
  {
    mode: 'implement',
    priority: 8,
    patterns: [
      /만들어줘/,
      /추가해줘/,
      /구현해줘/,
      /구현해/,
      /덧붙여/,           // spec §1-2 magic keyword for implement (skip brainstorm)
      /확장(?:해줘|해|할)?/, // ko: extend
      /\bimplement\b/i,
      /\bextend\b/i,       // spec §1-2 magic keyword for implement
      /\badd\s+to\b/i,     // spec §1-2 "add to" pattern
    ],
  },
  {
    // verify mode — dynamic: run tests + inspect + E2E. Priority above investigate
    // so "테스트"/"점검"/"run tests" take precedence over static-read verbs.
    mode: 'verify',
    priority: 7,
    patterns: [
      // Korean — "test" / "run" / "health-check" tokens
      /테스트\s*(?:해|돌려|실행|해봐|돌려봐|실행해봐)/,
      /돌려\s*(?:봐|봐요|보자)?/,
      /실행\s*(?:해|해봐|해보자)/,
      /점검(?:\s*해|\s*좀|해봐|해보자)?/,
      /헬스\s*체크/,
      // English
      /\brun\s+(?:the\s+)?tests?\b/i,
      /\brun\s+verification\b/i,
      /\bhealth\s*check\b/i,
      /\bsanity\s*check\b/i,
      /\btest\s+it\b/i,
    ],
  },
  {
    mode: 'investigate',
    priority: 9,
    patterns: [
      /파악해/,
      /파악한/,
      /분석해/,
      /분석한/,
      /조사해/,
      /조사한/,
      /알아봐/,
      /어떻게\s*되어\s*(?:있어|있나)/,
      /어떤\s*구조/,
      // Static-read verbs (Korean). 점검 is moved to /verify (dynamic).
      /검증(?:해|하고|한|할|좀)?/,
      /확인(?:해|하고|한|할|좀)?/,
      /체크(?:해|하고|한|할|좀)?/,
      // English static-read verbs — word-boundary aware
      /\bverify\b/i,
      /\bvalidate\b/i,
      /\bcheck\b/i,
      /\binvestigate\b/i,
      /\banalyze\b/i,
    ],
  },
  {
    mode: 'fix',
    priority: 10,
    patterns: [
      /버그/,
      /문제\s*(?:있|발생|생겨|해결)/,
      /에러/,
      /\berror\b/i,
      /작동\s*안\s*(?:해|함|됨)/,
      /동작\s*안\s*(?:해|함|됨)/,
      /고쳐줘/,
      /수정해줘/,
      /\bfix\b/i,
      /\bbug\b/i,
    ],
  },
];

const DEFAULT_MODE = 'fix';

// Action-verb → mode map for chain detection.
// Each entry: a pattern that matches a standalone action verb, and the mode it implies.
// Word-boundary \b used only for English tokens (Korean is outside \w).
const CHAIN_ACTION_MAP = [
  // verify verbs (dynamic — run tests / inspect / e2e)
  { pattern: /테스트(?:해|하고|한|할|해봐|돌려|실행)?/, mode: 'verify' },
  { pattern: /점검(?:해|하고|한|할)?/, mode: 'verify' },
  { pattern: /돌려(?:봐|보고|보자)?/, mode: 'verify' },
  { pattern: /실행(?:해|하고|한|할|해봐)?/, mode: 'verify' },
  { pattern: /\brun\s+(?:the\s+)?tests?\b/i, mode: 'verify' },
  { pattern: /\brun\s+verification\b/i, mode: 'verify' },
  { pattern: /\btest\s+it\b/i, mode: 'verify' },
  // investigate verbs (static read — 검증/확인/체크/파악/분석/조사, verify/validate/check/investigate/analyze)
  { pattern: /검증(?:해|하고|한|할)?/, mode: 'investigate' },
  { pattern: /확인(?:해|하고|한|할)?/, mode: 'investigate' },
  { pattern: /체크(?:해|하고|한|할)?/, mode: 'investigate' },
  { pattern: /파악(?:해|하고|한|할)?/, mode: 'investigate' },
  { pattern: /분석(?:해|하고|한|할)?/, mode: 'investigate' },
  { pattern: /조사(?:해|하고|한|할)?/, mode: 'investigate' },
  { pattern: /\bverify\b/i, mode: 'investigate' },
  { pattern: /\bvalidate\b/i, mode: 'investigate' },
  { pattern: /\binvestigate\b/i, mode: 'investigate' },
  { pattern: /\banalyze\b/i, mode: 'investigate' },
  { pattern: /\bcheck\b/i, mode: 'investigate' },
  // plan verbs
  { pattern: /리팩토링(?:\s*할\s*거야|\s*할\s*예정|\s*할거야|할거야|할\s*예정|할|해)?/, mode: 'plan' },
  { pattern: /설계(?:해|하고|할)?/, mode: 'plan' },
  { pattern: /기획(?:해|하고|할)?/, mode: 'plan' },
  { pattern: /\brefactor\b/i, mode: 'plan' },
  { pattern: /\bdesign\b/i, mode: 'plan' },
  // implement verbs
  { pattern: /구현(?:해|해줘|하고|할)?/, mode: 'implement' },
  { pattern: /추가(?:해|해줘|하고|할)?/, mode: 'implement' },
  { pattern: /만들어(?:줘)?/, mode: 'implement' },
  { pattern: /덧붙여(?:서|줘)?/, mode: 'implement' },        // spec §1-2
  { pattern: /확장(?:해|해줘|하고|할)?/, mode: 'implement' }, // ko: extend
  { pattern: /\bimplement\b/i, mode: 'implement' },
  { pattern: /\bextend\b/i, mode: 'implement' },               // spec §1-2
  { pattern: /\badd\b/i, mode: 'implement' },
  // fix verbs
  { pattern: /고쳐(?:줘)?/, mode: 'fix' },
  { pattern: /수정(?:해|해줘|하고|할)?/, mode: 'fix' },
  { pattern: /\bfix\b/i, mode: 'fix' },
];

// Connective tokens that indicate a chained intent (A then B).
// Must sit BETWEEN two action verbs.
const CHAIN_CONNECTIVES = [
  /그리고/,
  /그\s*뒤에?/,
  /그\s*후에?/,
  /하고(?:\s|$)/,       // Korean verbal connective: 검증하고, 분석하고, ...
  /한\s*뒤에?/,
  /한\s*후에?/,
  /뒤에?\s/,
  /후에?\s/,
  /\band\s+then\b/i,
  /\bthen\b/i,
  /\band\b/i,
];

/**
 * classifyChain — detect chained intents like "A하고 B해" / "A then B".
 *
 * Returns `{ modes: string[], trigger: string }` with ≥2 distinct modes
 * ordered by appearance, or `null` when no chain is detected.
 *
 * Detection rule:
 *   1. Find all action-verb matches in order of their position in the input.
 *   2. Dedupe consecutive same-mode hits (e.g., two fix verbs do not form a chain).
 *   3. Require at least one CHAIN_CONNECTIVE to appear BETWEEN the first two
 *      distinct-mode action verbs. This guards against "버그 수정해" style input
 *      where no connective exists.
 *   4. Every chain element must be a declared MODES enum value (mode whitelist).
 */
export function classifyChain(input) {
  if (!input || typeof input !== 'string') return null;

  // Step 1: collect all action-verb hits with position.
  const hits = [];
  for (const { pattern, mode } of CHAIN_ACTION_MAP) {
    // Use a global copy so we can iterate every match.
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    let m;
    while ((m = re.exec(input)) !== null) {
      hits.push({ index: m.index, token: m[0], mode });
      if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-width loop
    }
  }
  if (hits.length < 2) return null;
  hits.sort((a, b) => a.index - b.index);

  // Step 2: collapse consecutive same-mode hits — we only care about mode transitions.
  const distinct = [];
  for (const h of hits) {
    if (distinct.length === 0 || distinct[distinct.length - 1].mode !== h.mode) {
      distinct.push(h);
    }
  }
  if (distinct.length < 2) return null;

  // Step 3: require a CHAIN_CONNECTIVE somewhere that joins the first two
  //   distinct-mode hits. The connective can appear (a) between a.token and
  //   b.token in the raw slice, or (b) as a trailing suffix baked into
  //   a.token itself (e.g., "분석하고", "파악한", "검증하고"). This mirrors
  //   Korean morphology where the connective fuses to the verb stem.
  const [a, b] = distinct;
  const between = input.slice(a.index + a.token.length, b.index);
  const CONNECTIVE_SUFFIXES = [/하고$/, /한$/, /고$/, /뒤$/, /후$/];
  const hasConnectiveBetween = CHAIN_CONNECTIVES.some(c => c.test(between));
  const hasConnectiveSuffix = CONNECTIVE_SUFFIXES.some(c => c.test(a.token));
  if (!hasConnectiveBetween && !hasConnectiveSuffix) return null;

  // Step 4: mode whitelist.
  const modes = distinct.map(h => h.mode).filter(m => MODES_WHITELIST.includes(m));
  if (modes.length < 2) return null;

  return {
    modes,
    trigger: `chain:${a.token}->${b.token}`,
  };
}

// Keep the whitelist in this module so we don't create a hard dependency
// on state-schema from classifier imports; the two lists must stay in sync.
const MODES_WHITELIST = Object.freeze(['simple_fix', 'fix', 'investigate', 'verify', 'plan', 'implement']);

export function classify(input) {
  if (!input || typeof input !== 'string') {
    return { mode: DEFAULT_MODE, trigger: 'default:empty', overridden: false };
  }

  const trimmed = input.trim();

  // 1. Explicit command override.
  for (const [cmd, mode] of Object.entries(EXPLICIT_COMMANDS)) {
    if (trimmed.startsWith(cmd)) {
      return { mode, trigger: `command:${cmd}`, overridden: true };
    }
  }

  // 2. Chained-intent detection — takes precedence over single-mode pattern
  //    matching so that "분석하고 구현해줘" resolves to investigate (entry)
  //    with implement queued, rather than matching only the later verb.
  const chain = classifyChain(trimmed);
  if (chain) {
    return {
      mode: chain.modes[0],
      trigger: chain.trigger,
      overridden: false,
      chained_modes: chain.modes,
    };
  }

  // 3. Pattern matching.
  for (const rule of RULES.sort((a, b) => a.priority - b.priority)) {
    for (const p of rule.patterns) {
      const m = trimmed.match(p);
      if (m) return { mode: rule.mode, trigger: `keyword:${m[0]}`, overridden: false };
    }
  }

  // 4. Fallback.
  return { mode: DEFAULT_MODE, trigger: 'default:unclassified', overridden: false };
}

export function classifyMagicKeywords(input) {
  if (!input || typeof input !== 'string') return { surface: [], hints: [] };
  const surface = [];
  const hints = [];

  if (/(?:\bcss\b|\bstyle\b|\bi18n\b|\btypo\b|\bdialogue\b|텍스트|번역|문구|오타)/i.test(input)) {
    surface.push('style_or_text');
    hints.push('exempt.tdd=true');
  }
  if (/(?:\bextend\b|\badd to\b|덧붙여|추가로)/i.test(input)) {
    hints.push('skip_brainstorm_in_implement');
  }

  return { surface, hints };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv.slice(2).join(' ') || readFileSync('/dev/stdin', 'utf-8').trim();
  const r = classify(input);
  const mk = classifyMagicKeywords(input);
  console.log(JSON.stringify({ ...r, magic: mk }, null, 2));
}
