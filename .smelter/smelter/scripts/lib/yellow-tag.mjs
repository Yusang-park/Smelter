// Yellow tag printer for smelter hooks.
// Emits short ANSI-yellow bracketed labels to stderr so users see hook activity.
// Respects NO_COLOR and non-TTY environments (plain text fallback).

const YELLOW_OPEN = '\x1b[33m';
const RESET = '\x1b[0m';

// Strip control bytes that could be used to inject terminal escape sequences,
// overwrite previous output, or hide content via bidi overrides.
//   \x00-\x1f \x7f      C0 controls + DEL (CR/LF/ESC live here)
//   \u200B \u200E \u200F  zero-width space + LRM/RLM
//   \u2028 \u2029         line / paragraph separators
//   \u202A-\u202E         LRE / RLE / PDF / LRO / RLO bidi overrides
//   \u2066-\u2069         LRI / RLI / FSI / PDI bidi isolates
// ZWNJ (U+200C) and ZWJ (U+200D) are NOT stripped; they have legitimate
// uses in Persian / Hindi / Tamil text.
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

function sanitize(label) {
  return String(label).replace(CONTROL_CHARS, '');
}

function shouldUseColor() {
  if (process.env.NO_COLOR) return false;
  // stderr TTY check; default to true when isTTY is undefined (piped but CI color-safe).
  if (process.stderr && process.stderr.isTTY === false) return false;
  return true;
}

export function formatTag(label) {
  const text = `[${sanitize(label)}]`;
  return shouldUseColor() ? `${YELLOW_OPEN}${text}${RESET}` : text;
}

export function printTag(label) {
  try {
    process.stderr.write(formatTag(label) + '\n');
  } catch {
    // stderr write failures are never fatal for a hook.
  }
}

export default printTag;
