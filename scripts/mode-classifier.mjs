#!/usr/bin/env node
/**
 * mode-classifier.mjs — Classify natural-language input into a v2 mode.
 *
 * Layer architecture (v2.4.9+, no-fallback variant):
 *   Layer 1 — Explicit slash commands (/fix, /plan, /implement, ...) always win.
 *   Layer 2 — Passthrough for pure git/shell verb-first imperatives.
 *   Layer 3 — LLM classifier (subagent-classifier.classifyMode).
 *             Returns mode + optional chained_modes + passthrough hint.
 *
 * Failure policy (v2.4.9):
 *   If Layer 3 throws, the error propagates. There is NO regex fallback —
 *   the LLM is the only classifier for natural language. Callers must decide
 *   what to do on failure (treat as "no classification" and pass the prompt
 *   through unseeded, log, retry, etc.).
 *
 * Empty input is NOT a classification error — returns null so callers can
 * skip seeding without exception noise.
 *
 * Usage:
 *   import { classify } from './mode-classifier.mjs';
 *   const r = classify('버그 고쳐줘', { cwd: process.cwd(), sessionId: 'sX' });
 *   // → { mode: 'fix', trigger: 'llm:...', overridden: false }
 *
 * CLI:
 *   echo "리팩토링할거야" | node mode-classifier.mjs
 */

import { readFileSync } from 'node:fs';
import { classifyMode } from './lib/subagent-classifier.mjs';

const EXPLICIT_COMMANDS = {
  '/think': 'think',
  '/fix': 'fix',
  '/investigate': 'investigate',
  '/verify': 'verify',
  '/implement': 'implement',
};

// Mode whitelist — kept in sync with state-schema MODES (v3 canonical set).
const MODES_WHITELIST = Object.freeze([
  'think', 'fix', 'investigate', 'verify', 'implement',
]);

// ---------------------------------------------------------------------------
// Layer 2 — Passthrough (pure shell / git intents)
// ---------------------------------------------------------------------------
// Patterns MUST consume the entire input (anchored `$`). Mixed-intent prompts
// like "git log 후 고쳐줘" deliberately fall through to the LLM layer, which
// can recognize the embedded fix intent and chain appropriately.
export const PASSTHROUGH_PATTERNS = [
  // git/gh + verb + optional flag/path/ref args. Rejects natural-language
  // tokens by restricting trailing args to a shell-safe character class.
  /^\s*git\s+[a-z][\w\-]*(?:\s+(?:[\w\-\/\.\@:~=+]+|'[^']*'|"[^"]*"))*\s*$/i,
  /^\s*gh\s+[a-z][\w\-]*(?:\s+(?:[\w\-\/\.\@:~=+]+|'[^']*'|"[^"]*"))*\s*$/i,
  // Korean git-noun openers with optional verbal suffix — bare form only.
  /^\s*(?:남은\s*(?:변경|changes?)?\s*(?:다\s*)?)?(?:커밋|푸시|풀|리베이스|체크아웃|스테이시|브랜치|머지|스태시|stash)(?:\s*(?:해|해줘|해야|해봐|하고|하자|좀|진행|바로))?\s*$/i,
  // Bare English git verbs — no suffix, a minimal ref/flag, or a Korean
  // adverbial/verbal suffix (좀/해/해줘/하자/바로/진행). The Korean suffixes
  // require a full whitespace boundary (`\s+`) so adjacent-joined forms like
  // `push origin-좀` (no space) do NOT passthrough — they drop to the LLM.
  /^\s*(?:push|pull|commit|rebase|checkout|status|diff|log|blame|stash|merge|fetch)(?:\s+(?:origin|main|master|\-\w+|[\w\-\/\.]+))?(?:\s+(?:좀|해|해줘|하자|바로|진행))?\s*$/i,
];

export function classifyPassthrough(input) {
  if (!input || typeof input !== 'string') return null;
  // Operator kill switch.
  if (process.env.SMT_CLASSIFIER_NO_PASSTHROUGH === '1') return null;

  for (const rx of PASSTHROUGH_PATTERNS) {
    const m = input.match(rx);
    if (m) return { trigger: `passthrough:${m[0].trim().slice(0, 30)}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * classify — resolve an input to a workflow mode.
 *
 * @param {string} input — user prompt (natural language or slash command).
 * @param {{cwd?: string, sessionId?: string}} opts
 * @returns {object|null} Either a classification result (Layer 1/2/3 match)
 *   or `null` for empty input. Throws propagate from Layer 3 on LLM failure —
 *   the caller decides whether to catch-and-skip or surface the error.
 */
export function classify(input, { cwd = process.cwd(), sessionId = '' } = {}) {
  if (!input || typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  // Layer 1 — Explicit command override. Require a word boundary after the
  // command so `/fixture` does NOT match `/fix`. The boundary is EOL, any
  // whitespace, `:`, or `-` — matching `keyword-detector.mjs::extractExplicitHarnessCommand`
  // behavior so the two entry points agree on the same input.
  for (const [cmd, mode] of Object.entries(EXPLICIT_COMMANDS)) {
    if (!trimmed.startsWith(cmd)) continue;
    const rest = trimmed.slice(cmd.length);
    if (rest === '' || /^[:\s-]/.test(rest)) {
      return { mode, trigger: `command:${cmd}`, overridden: true };
    }
  }

  // Layer 2 — Pure shell / git passthrough.
  const passthrough = classifyPassthrough(trimmed);
  if (passthrough) {
    return { mode: null, trigger: passthrough.trigger, overridden: false, passthrough: true };
  }

  // Layer 3 — LLM classifier. Errors propagate: there is no regex fallback.
  const llm = classifyMode(trimmed, { cwd, sessionId });
  if (!llm || typeof llm.mode !== 'string' || !MODES_WHITELIST.includes(llm.mode)) {
    throw new Error(`classifyMode returned invalid result: ${JSON.stringify(llm)}`);
  }
  const chain = Array.isArray(llm.chained_modes) && llm.chained_modes.length >= 2
    && llm.chained_modes.every((m) => MODES_WHITELIST.includes(m))
    ? llm.chained_modes
    : null;
  // Passthrough bypasses workflow seeding entirely, so surface fields carry
  // no routing signal. Null them so downstream consumers that ignore
  // `passthrough` and read surface directly still see a consistent shape.
  const isPassthrough = llm.passthrough === true;
  const result = {
    schema_version: llm.schema_version ?? 2,
    mode: llm.mode,
    // subagent-classifier already normalizes trigger with `llm:`/`stub:` prefix
    // before caching. Re-prefixing here produced doubled `llm:llm:...` banners
    // (visible in the Magic Keyword log line). Respect the prefix if already
    // present; only add it for raw triggers that slipped through unnormalized.
    trigger: typeof llm.trigger === 'string' && llm.trigger
      ? (/^(llm:|stub:)/.test(llm.trigger) ? llm.trigger : `llm:${llm.trigger}`)
      : `llm:${llm.mode}`,
    overridden: false,
    target_type: isPassthrough ? null : (llm.target_type ?? null),
    exempt: isPassthrough ? null : (llm.exempt ?? null),
    skip_brainstorm: !isPassthrough && llm.skip_brainstorm === true,
  };
  if (chain) result.chained_modes = chain;
  if (isPassthrough) result.passthrough = true;
  return result;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv.slice(2).join(' ') || readFileSync('/dev/stdin', 'utf-8').trim();
  try {
    const r = classify(input);
    console.log(JSON.stringify(r || { mode: null, trigger: 'empty-input' }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: String(err?.message || err) }));
    process.exit(1);
  }
}
