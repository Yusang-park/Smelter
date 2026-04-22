#!/usr/bin/env node
/**
 * shell-tokenize.test.mjs — RED tests for vendored shell tokenizer.
 *
 * Covers read-only classification of Bash commands for pretool-stage-gate.
 * The target module does not yet exist; these tests will fail until
 * scripts/lib/shell-tokenize.mjs is implemented.
 */

let pass = 0, fail = 0;
const failures = [];

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else {
    fail++;
    failures.push({ label, actual, expected });
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
  }
}

function section(t) { console.log(`\n[${t}]`); }

const READONLY = new Set([
  'ls', 'cat', 'grep', 'rg', 'head', 'tail', 'wc', 'find', 'which',
  'pwd', 'echo', 'ps', 'date', 'stat', 'file', 'readlink', 'basename',
  'dirname', 'jq', 'sort', 'uniq', 'awk', 'printenv', 'env', 'git',
  'node', 'pnpm', 'npm', 'tsc'
]);

const { classifyCommand } = await import('./shell-tokenize.mjs');

// [happy path — 2+]
section('happy path');
assert('ls → readonly', classifyCommand('ls', READONLY).readonly, true);
assert('grep foo bar.txt → readonly', classifyCommand('grep foo bar.txt', READONLY).readonly, true);
assert('cat a.txt → readonly', classifyCommand('cat a.txt', READONLY).readonly, true);
assert('git status → readonly', classifyCommand('git status', READONLY).readonly, true);

// [boundary — 2+]
section('boundary');
assert('empty string → readonly true (no command)', classifyCommand('', READONLY).readonly, true);
assert('pure whitespace → readonly true', classifyCommand('   ', READONLY).readonly, true);
assert('leading whitespace preserved', classifyCommand('  ls  ', READONLY).readonly, true);

// [error path — 2+]
section('error path');
assert('rm → not readonly', classifyCommand('rm -rf /tmp/foo', READONLY).readonly, false);
assert('unknown binary → not readonly', classifyCommand('mycustomcmd', READONLY).readonly, false);
assert('multi-segment with one mutating', classifyCommand('ls && rm -rf /tmp/foo', READONLY).readonly, false);

// [edge case — 2+]
section('edge case');
assert('bash -c "rm x" → not readonly', classifyCommand('bash -c "rm x"', READONLY).readonly, false);
assert('sh -c "ls" → readonly', classifyCommand('sh -c "ls"', READONLY).readonly, true);
assert('eval "rm x" → not readonly', classifyCommand('eval "rm x"', READONLY).readonly, false);
assert('xargs rm → not readonly', classifyCommand('xargs rm', READONLY).readonly, false);
assert('env K=V ls → readonly', classifyCommand('env K=V ls', READONLY).readonly, true);
assert('env K=V rm x → not readonly', classifyCommand('env K=V rm x', READONLY).readonly, false);
assert('echo $(rm x) → not readonly (command substitution)', classifyCommand('echo $(rm x)', READONLY).readonly, false);
assert('echo `rm x` → not readonly (backtick substitution)', classifyCommand('echo `rm x`', READONLY).readonly, false);
assert('ls > file → not readonly (redirect)', classifyCommand('ls > file', READONLY).readonly, false);
assert('ls >> file → not readonly (append redirect)', classifyCommand('ls >> file', READONLY).readonly, false);
assert('ls | tee file → not readonly (tee writes)', classifyCommand('ls | tee file', READONLY).readonly, false);
assert('dd of=x → not readonly', classifyCommand('dd of=x', READONLY).readonly, false);
assert('cat > file → not readonly', classifyCommand('cat > file', READONLY).readonly, false);
assert('ls > >(tee file) → not readonly (process sub write)', classifyCommand('ls > >(tee file)', READONLY).readonly, false);
assert('exec > file → not readonly', classifyCommand('exec > file', READONLY).readonly, false);
assert('{ ls; } > file → not readonly (brace group redirect)', classifyCommand('{ ls; } > file', READONLY).readonly, false);
assert('coproc x → not readonly', classifyCommand('coproc x', READONLY).readonly, false);
assert('ls |& grep foo → readonly (both readonly, |& stderr-pipe)', classifyCommand('ls |& grep foo', READONLY).readonly, true);
assert('nested bash -c "bash -c rm" → not readonly', classifyCommand('bash -c "bash -c \'rm x\'"', READONLY).readonly, false);
assert('sudo rm → not readonly (sudo prefix stripped, rm still mutating)', classifyCommand('sudo rm x', READONLY).readonly, false);
assert('time ls → readonly (time prefix stripped)', classifyCommand('time ls', READONLY).readonly, true);

// [integration — 1+]
section('integration');
assert('multi-segment readonly pipe', classifyCommand('ls | grep foo | head -5', READONLY).readonly, true);
assert('semicolon sequence all readonly', classifyCommand('ls; pwd; echo done', READONLY).readonly, true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.label}`);
  process.exit(1);
}
