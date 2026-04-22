#!/usr/bin/env node
/**
 * surface-extraction.mjs — unified surface-field extraction for Smelter workflow.
 *
 * Two lanes converge here:
 *   1. Slash-command args  → parseSlashArgs (deterministic table lookup)
 *   2. LLM classifyMode    → validateSurfaceFields (enum/type guard on model output)
 * Both produce a SurfaceFields shape; mergeSurface then combines with mode defaults.
 *
 * SurfaceFields = {
 *   schema_version: 2,
 *   target_type: 'typo'|'dialogue'|'bug_fix'|'extend_existing'|null,
 *   exempt: {tdd: boolean, e2e: boolean} | null,
 *   skip_brainstorm: boolean,
 * }
 */

import { printTag } from './yellow-tag.mjs';

export const SURFACE_SCHEMA_VERSION = 2;

const VALID_TARGET_TYPES = new Set(['typo', 'dialogue', 'bug_fix', 'extend_existing']);

/**
 * SLASH_SURFACE_TABLE — ordered rows for parseSlashArgs.
 * Only `fix` and `implement` have rows; other commands always return null.
 *
 * Match semantics (per brainstorm §Slash-Argument Parser):
 * - Tokenize input on Unicode whitespace + punctuation.
 * - Single-token rows: exact lowercase equality (ASCII) or direct equality (CJK).
 * - Multi-token rows (tokens=[..., ...]): consecutive-pair equality.
 * - `target_type`: first-match-wins across rows.
 * - `exempt.tdd`/`exempt.e2e`/`skip_brainstorm`: union (once true, stays true).
 */
export const SLASH_SURFACE_TABLE = Object.freeze([
  // fix: typo / plural / Korean
  { command: 'fix', tokens: ['typo'],     set: { target_type: 'typo', exempt: { tdd: true, e2e: true } } },
  { command: 'fix', tokens: ['typos'],    set: { target_type: 'typo', exempt: { tdd: true, e2e: true } } },
  { command: 'fix', tokens: ['오타'],      set: { target_type: 'typo', exempt: { tdd: true, e2e: true } } },
  // fix: dialogue
  { command: 'fix', tokens: ['dialogue'], set: { target_type: 'dialogue', exempt: { tdd: true, e2e: true } } },
  { command: 'fix', tokens: ['대화'],      set: { target_type: 'dialogue', exempt: { tdd: true, e2e: true } } },
  // fix: style/i18n (tdd-only)
  { command: 'fix', tokens: ['css'],      set: { exempt: { tdd: true } } },
  { command: 'fix', tokens: ['style'],    set: { exempt: { tdd: true } } },
  { command: 'fix', tokens: ['텍스트'],    set: { exempt: { tdd: true } } },
  { command: 'fix', tokens: ['i18n'],     set: { exempt: { tdd: true } } },
  // implement: extend
  { command: 'implement', tokens: ['extend'],   set: { skip_brainstorm: true } },
  { command: 'implement', tokens: ['add','to'], set: { skip_brainstorm: true } },
  { command: 'implement', tokens: ['덧붙여'],    set: { skip_brainstorm: true } },
  { command: 'implement', tokens: ['추가로'],    set: { skip_brainstorm: true } },
  // implement: style/i18n
  { command: 'implement', tokens: ['css'],   set: { exempt: { tdd: true } } },
  { command: 'implement', tokens: ['style'], set: { exempt: { tdd: true } } },
  { command: 'implement', tokens: ['i18n'],  set: { exempt: { tdd: true } } },
]);

function tokenize(argsString) {
  return String(argsString ?? '')
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter(Boolean);
}

function matchConsecutive(tokens, needle) {
  if (needle.length === 1) return tokens.includes(needle[0]);
  for (let i = 0; i <= tokens.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (tokens[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * parseSlashArgs — deterministic slash-command argument surface extractor.
 * Returns null if command is not scoped (think/investigate/verify) or no row matches.
 */
export function parseSlashArgs(commandName, argsString) {
  const tokens = tokenize(argsString);
  if (tokens.length === 0) return null;

  const rows = SLASH_SURFACE_TABLE.filter((r) => r.command === commandName);
  if (rows.length === 0) return null;

  let target_type = null;
  let exempt = null;
  let skip_brainstorm = false;
  let matched = false;

  for (const row of rows) {
    if (!matchConsecutive(tokens, row.tokens)) continue;
    matched = true;
    const s = row.set;
    if (s.target_type && target_type === null) target_type = s.target_type;
    if (s.exempt) {
      const next = exempt ? { ...exempt } : {};
      if (s.exempt.tdd) next.tdd = true;
      if (s.exempt.e2e) next.e2e = true;
      exempt = next;
    }
    if (s.skip_brainstorm) skip_brainstorm = true;
  }

  if (!matched) return null;
  return { schema_version: SURFACE_SCHEMA_VERSION, target_type, exempt, skip_brainstorm };
}

/**
 * validateSurfaceFields — normalize/sanitize LLM-emitted surface fields.
 * - schema_version !== 2 → drop all surface (keep `null` everywhere, skip_brainstorm=false).
 * - target_type not in enum → coerce to null.
 * - exempt not {tdd:boolean,e2e:boolean} → null (caller inherits default_exempt).
 * - skip_brainstorm not boolean → false.
 * Never throws on surface fields; only mode invalid throws upstream.
 */
export function validateSurfaceFields(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { schema_version: SURFACE_SCHEMA_VERSION, target_type: null, exempt: null, skip_brainstorm: false };
  }

  if (parsed.schema_version !== SURFACE_SCHEMA_VERSION) {
    try { printTag(`[Surface] schema_version mismatch, degrading to mode-only`); } catch {}
    return { schema_version: SURFACE_SCHEMA_VERSION, target_type: null, exempt: null, skip_brainstorm: false };
  }

  let target_type = parsed.target_type ?? null;
  if (target_type !== null && !VALID_TARGET_TYPES.has(target_type)) {
    try { printTag(`[Surface] invalid target_type dropped: ${String(target_type).slice(0, 32)}`); } catch {}
    target_type = null;
  }

  let exempt = null;
  if (parsed.exempt !== null && parsed.exempt !== undefined) {
    const e = parsed.exempt;
    if (e && typeof e === 'object' && typeof e.tdd === 'boolean' && typeof e.e2e === 'boolean') {
      exempt = { tdd: e.tdd, e2e: e.e2e };
    } else {
      try { printTag(`[Surface] invalid exempt shape dropped`); } catch {}
    }
  }

  const skip_brainstorm = typeof parsed.skip_brainstorm === 'boolean' ? parsed.skip_brainstorm : false;

  return { schema_version: SURFACE_SCHEMA_VERSION, target_type, exempt, skip_brainstorm };
}

/**
 * mergeSurface — combine extracted surface with mode's default_exempt.
 * Per-field shallow merge: `surface.exempt.tdd ?? default_exempt.tdd`, same for e2e.
 * Returns a fresh object. Does not mutate inputs.
 */
export function mergeSurface(surface, modeCfg) {
  const def = (modeCfg && modeCfg.default_exempt) || { tdd: false, e2e: false };
  const surfaceExempt = surface && surface.exempt;
  const exempt = {
    tdd: (surfaceExempt && typeof surfaceExempt.tdd === 'boolean') ? surfaceExempt.tdd : def.tdd,
    e2e: (surfaceExempt && typeof surfaceExempt.e2e === 'boolean') ? surfaceExempt.e2e : def.e2e,
  };
  return {
    target_type: (surface && surface.target_type) ?? null,
    exempt,
    skip_brainstorm: surface?.skip_brainstorm === true,
  };
}
