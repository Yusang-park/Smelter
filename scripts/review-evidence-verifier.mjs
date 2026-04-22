#!/usr/bin/env node
// review-evidence-verifier.mjs — PostToolUse(Edit|Write) hook.
// Blocks review-artifact writes whose `fail` verdict is not backed by at
// least one verified `**Evidence:** `path:line[-line]` "quote"` anchor.
// See .smt/features/review-evidence-verifier/task/{plan,brainstorm,tasks}.md.

import { readFileSync, existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

const REVIEW_BASENAME_RE = /(?:_review|-review)\.md$/;

// `**Evidence:** `path:line[-line]` "quote"`
const EVIDENCE_RE = /\*\*Evidence:\*\*\s+`([^`\n]+?):(\d+)(?:-(\d+))?`\s+"([^"\n]+)"/g;

function readStdinSync() {
  try { return readFileSync(0, 'utf-8'); } catch { return ''; }
}

function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

function noop() { process.exit(0); }

function normalize(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// Extract verdict. Accepts:
//   "## Verdict\n\npass" / "Verdict\n\nfail"
//   "result: pass"
//   bare line "pass" / "fail" in a section
function extractVerdict(text) {
  const mHeader = text.match(/(?:^|\n)#{1,6}\s*(?:Final\s+)?Verdict\s*\n+\s*(pass|fail)\b/i);
  if (mHeader) return mHeader[1].toLowerCase();
  const mInline = text.match(/\b(?:final\s+)?verdict\s*(?::|=)\s*[`*"']?(pass|fail)\b/i);
  if (mInline) return mInline[1].toLowerCase();
  // Last-resort: final line containing only pass/fail
  const mBare = text.match(/(?:^|\n)\s*(pass|fail)\s*$/im);
  if (mBare) return mBare[1].toLowerCase();
  return null;
}

function resolveEvidencePath(rawPath, cwd) {
  if (isAbsolute(rawPath)) return rawPath;
  return join(cwd || process.cwd(), rawPath);
}

function verifyAnchor(anchor, cwd) {
  const [, rawPath, lStart, lEndMaybe, quote] = anchor;
  const abs = resolveEvidencePath(rawPath, cwd);
  if (!existsSync(abs)) return { ok: false, reason: `evidence path not found: ${rawPath}` };
  let src;
  try { src = readFileSync(abs, 'utf-8'); }
  catch (e) { return { ok: false, reason: `evidence unreadable: ${rawPath} (${e.code || e.message})` }; }
  const lines = src.split(/\r?\n/);
  const L1 = parseInt(lStart, 10);
  const L2 = lEndMaybe ? parseInt(lEndMaybe, 10) : L1;
  if (!Number.isFinite(L1) || L1 < 1 || L1 > lines.length) {
    return { ok: false, reason: `evidence line ${L1} out of range (file has ${lines.length} lines): ${rawPath}` };
  }
  if (!Number.isFinite(L2) || L2 < L1 || L2 > lines.length) {
    return { ok: false, reason: `evidence range ${L1}-${L2} out of range (file has ${lines.length} lines): ${rawPath}` };
  }
  const hay = normalize(lines.slice(L1 - 1, L2).join('\n'));
  const needle = normalize(quote);
  if (!hay.includes(needle)) {
    return { ok: false, reason: `evidence quote mismatch at ${rawPath}:${L1}${L2 !== L1 ? '-' + L2 : ''} — cited "${needle.slice(0, 80)}" not found in line(s)` };
  }
  return { ok: true };
}

function main() {
  const stdin = readStdinSync();
  if (!stdin) return noop();
  let payload;
  try { payload = JSON.parse(stdin); } catch { return noop(); }
  const toolName = payload.tool_name;
  if (toolName !== 'Write' && toolName !== 'Edit') return noop();
  const filePath = payload?.tool_input?.file_path;
  if (!filePath || typeof filePath !== 'string') return noop();
  if (!REVIEW_BASENAME_RE.test(basename(filePath))) return noop();

  let content;
  try { content = readFileSync(filePath, 'utf-8'); }
  catch { return noop(); }

  const verdict = extractVerdict(content);
  if (verdict !== 'fail') return noop();

  const anchors = [...content.matchAll(EVIDENCE_RE)];
  if (anchors.length === 0) {
    return emitBlock('fail verdict without cited evidence anchors. Add **Evidence:** `path:line` "quote" for every symptom.');
  }

  const cwd = payload.cwd || process.cwd();
  for (const anchor of anchors) {
    const v = verifyAnchor(anchor, cwd);
    if (!v.ok) return emitBlock(v.reason);
  }

  return noop();
}

main();
