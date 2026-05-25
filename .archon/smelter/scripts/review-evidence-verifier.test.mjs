#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const VERIFIER = new URL('./review-evidence-verifier.mjs', import.meta.url).pathname;

function runHook({ tool_name, file_path, cwd }) {
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name,
    tool_input: { file_path },
    cwd,
  });
  const r = spawnSync('node', [VERIFIER], { input: payload, encoding: 'utf8' });
  let decision = null;
  let reason = null;
  try {
    const parsed = JSON.parse(r.stdout || '{}');
    decision = parsed.decision ?? null;
    reason = parsed.reason ?? null;
  } catch {}
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr, decision, reason };
}

const workdir = mkdtempSync(join(tmpdir(), 'review-verifier-'));

function write(rel, content) {
  const p = join(workdir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}

try {
  // 1. Non-review file → no-op
  const src = write('src/foo.ts', 'export const x = 1;\n');
  let r = runHook({ tool_name: 'Write', file_path: src, cwd: workdir });
  assert.equal(r.exit, 0, 'non-review file must exit 0');
  assert.equal(r.decision, null, 'non-review must not emit decision');

  // 2. Non-Write tool → no-op
  r = runHook({ tool_name: 'Bash', file_path: write('x_review.md', 'x'), cwd: workdir });
  assert.equal(r.decision, null, 'non-Write tool must not emit decision');

  // 3. Review file with no evidence and no fail verdict → ok
  const okPath = write('a_review.md', '# Review\n\n## Verdict\n\npass\n');
  r = runHook({ tool_name: 'Write', file_path: okPath, cwd: workdir });
  assert.notEqual(r.decision, 'block', 'pass review without evidence must not block');

  // 4. Review with fail verdict but no evidence → block
  const noEvPath = write('b_review.md', '# Review\n\n## Verdict\n\nfail\n\nreason: broken\n');
  r = runHook({ tool_name: 'Write', file_path: noEvPath, cwd: workdir });
  assert.equal(r.decision, 'block', 'fail verdict without evidence must block');
  assert.match(r.reason || '', /evidence/i, 'block reason mentions evidence');

  // 5. Evidence with correct quote → ok
  const target = write('src/bar.ts', 'line one\nconst answer = 42;\nline three\n');
  const okEv = write('c_review.md', `# Review\n\n## Verdict\n\nfail\n\n**Evidence:** \`src/bar.ts:2\` "const answer = 42"\n`);
  r = runHook({ tool_name: 'Write', file_path: okEv, cwd: workdir });
  assert.notEqual(r.decision, 'block', 'verified evidence must not block');

  // 6. Evidence with nonexistent file → block
  const missPath = write('d_review.md', '# Review\n\n## Verdict\n\nfail\n\n**Evidence:** `does/not/exist.ts:5` "whatever"\n');
  r = runHook({ tool_name: 'Write', file_path: missPath, cwd: workdir });
  assert.equal(r.decision, 'block', 'nonexistent file evidence must block');
  assert.match(r.reason || '', /does\/not\/exist\.ts/, 'reason includes path');

  // 7. Evidence with line out of range → block
  const oorPath = write('e_review.md', '# Review\n\n## Verdict\n\nfail\n\n**Evidence:** `src/bar.ts:99` "ghost"\n');
  r = runHook({ tool_name: 'Write', file_path: oorPath, cwd: workdir });
  assert.equal(r.decision, 'block', 'out-of-range line must block');

  // 8. Evidence with quote mismatch → block
  const mmPath = write('f_review.md', '# Review\n\n## Verdict\n\nfail\n\n**Evidence:** `src/bar.ts:2` "gpt-5.3-codex-spark"\n');
  r = runHook({ tool_name: 'Write', file_path: mmPath, cwd: workdir });
  assert.equal(r.decision, 'block', 'quote mismatch must block');
  assert.match(r.reason || '', /quote/i, 'reason mentions quote');

  // 9. Absolute path evidence resolves correctly
  const absTarget = write('src/baz.ts', 'first\nsecond matters\nthird\n');
  const absEv = write('g_review.md', `**Evidence:** \`${absTarget}:2\` "second matters"\n`);
  r = runHook({ tool_name: 'Write', file_path: absEv, cwd: workdir });
  assert.notEqual(r.decision, 'block', 'absolute path evidence must verify');

  // 10. Range evidence (L1-L2): quote must appear within the range
  const rangeEv = write('h_review.md', `## Verdict\n\nfail\n\n**Evidence:** \`src/bar.ts:1-3\` "line three"\n`);
  r = runHook({ tool_name: 'Write', file_path: rangeEv, cwd: workdir });
  assert.notEqual(r.decision, 'block', 'range evidence with quote in range must not block');

  console.log('review-evidence-verifier tests passed (10/10)');
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
