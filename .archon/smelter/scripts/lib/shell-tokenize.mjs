/**
 * shell-tokenize.mjs — Vendored read-only classifier for shell commands.
 *
 * Given a bash command string and a Set of read-only command names,
 * classify whether the command would only read (not mutate) state.
 *
 * Implementation: heuristic tokenizer. Not a full shell parser.
 * Handles: operator splitting (&&, ||, ;, |, |&, newlines), command
 * substitution ($(..), backticks), wrapper unwrap (bash/sh/zsh -c,
 * eval, xargs), benign prefixes (sudo, time, nice, command, builtin,
 * env K=V), brace groups, redirects, tee, dd of=, coproc.
 */

export function classifyCommand(cmd, whitelist) {
  if (cmd == null || !String(cmd).trim()) return { readonly: true };
  const s = String(cmd).trim();

  // Redirect to file: > or >> when not followed by an fd-dup marker (&)
  if (/>{1,2}(?!\s*&)/.test(s)) return { readonly: false, reason: 'redirect' };
  // Pipe into tee
  if (/\|\s*tee\b/.test(s)) return { readonly: false, reason: 'tee' };
  // dd with of=
  if (/\bdd\b[^|&;]*\bof=/.test(s)) return { readonly: false, reason: 'dd-of' };
  // coproc keyword
  if (/\bcoproc\b/.test(s)) return { readonly: false, reason: 'coproc' };

  // Command substitution (recurse on inner)
  for (const inner of extractSubstitutions(s)) {
    const r = classifyCommand(inner, whitelist);
    if (!r.readonly) return { readonly: false, reason: 'substitution' };
  }

  // Strip substitutions before segment split
  const stripped = stripSubstitutions(s);

  // Split on shell control operators and check each segment
  const segments = splitSegments(stripped);
  for (const seg of segments) {
    const t = seg.trim();
    if (!t) continue;
    const r = classifySegment(t, whitelist);
    if (!r.readonly) return r;
  }
  return { readonly: true };
}

function classifySegment(seg, whitelist) {
  let rest = stripEnvPrefix(seg);
  rest = stripBenignPrefix(rest);

  const wrapped = unwrapContainer(rest);
  if (wrapped !== null) return classifyCommand(wrapped, whitelist);

  const first = rest.split(/\s+/)[0];
  if (!first) return { readonly: true };
  if (whitelist.has(first)) return { readonly: true };
  return { readonly: false, reason: `not-in-whitelist: ${first}` };
}

function stripEnvPrefix(s) {
  let rest = s;
  if (/^env(\s|$)/.test(rest)) {
    rest = rest.replace(/^env\s*/, '');
    const kv = /^([A-Za-z_]\w*=\S*)\s+/;
    while (kv.test(rest)) rest = rest.replace(kv, '');
  }
  return rest;
}

function stripBenignPrefix(s) {
  let rest = s;
  const pat = /^(sudo|time|nice|command|builtin)(\s+)/;
  while (pat.test(rest)) rest = rest.replace(pat, '');
  return rest;
}

function unwrapContainer(s) {
  // bash|sh|zsh|ksh|dash -c "..."
  let m = s.match(/^(bash|sh|zsh|ksh|dash)\s+-c\s+(['"])([\s\S]*)\2\s*$/);
  if (m) return m[3];
  // eval "..."
  m = s.match(/^eval\s+(['"])([\s\S]*)\1\s*$/);
  if (m) return m[2];
  // eval <rest>
  if (/^eval\s+/.test(s)) return s.replace(/^eval\s+/, '');
  // xargs [-flags] <cmd...>
  m = s.match(/^xargs\s+(?:-\S+\s+)*(.+)$/);
  if (m) return m[1];
  // source/. <file>
  if (/^(source|\.)\s+/.test(s)) return null;
  // brace group: { cmd; }
  m = s.match(/^\{\s*([\s\S]*?)\s*\}$/);
  if (m) return m[1].replace(/;\s*$/, '');
  return null;
}

function extractSubstitutions(s) {
  const out = [];
  const paren = /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let m;
  while ((m = paren.exec(s))) out.push(m[1]);
  const bt = /`([^`]+)`/g;
  while ((m = bt.exec(s))) out.push(m[1]);
  return out;
}

function stripSubstitutions(s) {
  return s
    .replace(/\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, '')
    .replace(/`[^`]+`/g, '');
}

function splitSegments(s) {
  const out = [];
  let buf = '';
  let q = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const c2 = s[i + 1];
    if (q) {
      if (c === q) q = null;
      buf += c; i++; continue;
    }
    if (c === '"' || c === "'") { q = c; buf += c; i++; continue; }
    if (c === '&' && c2 === '&') { out.push(buf); buf = ''; i += 2; continue; }
    if (c === '|' && c2 === '|') { out.push(buf); buf = ''; i += 2; continue; }
    if (c === '|' && c2 === '&') { out.push(buf); buf = ''; i += 2; continue; }
    if (c === '|') { out.push(buf); buf = ''; i++; continue; }
    if (c === ';') { out.push(buf); buf = ''; i++; continue; }
    if (c === '\n') { out.push(buf); buf = ''; i++; continue; }
    buf += c; i++;
  }
  if (buf.trim()) out.push(buf);
  return out;
}
