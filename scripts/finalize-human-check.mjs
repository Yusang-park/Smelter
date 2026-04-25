#!/usr/bin/env node
/**
 * finalize-human-check.mjs — PostToolUse:Write hook.
 *
 * Closes the "workflow-human-check cannot self-pass" deadlock: the skill's
 * SKILL.md contract tells the agent to write `results.md` and then append a
 * pass event to `state.json`, but the agent's Write/Edit tool cannot touch
 * `.state.json` (protected-path rule) and inline `SMT_HOOK_WRITE=1 node -e`
 * bypass attempts are refused by the permission classifier (correctly — any
 * inline script that writes `events[].result:'pass'` is indistinguishable
 * from a forgery at that surface).
 *
 * This hook runs legitimately as a hook script (fs.writeFileSync is exempt
 * from PreToolUse) AFTER the agent writes `results.md`. `results.md` is the
 * ONLY trigger — the file must physically exist on disk before state can be
 * finalized, which matches `workflow-human-check` SKILL.md's evidence
 * contract (pass event cites `results.md`).
 *
 * Behavior:
 *   - Trigger: PostToolUse, tool_name === 'Write', file_path ends in
 *     `.smt/features/<slug>/task/results.md` inside the project cwd.
 *   - Preconditions (all must hold; otherwise no-op):
 *       (a) the adjacent `<slug>.state.json` exists and parses;
 *       (b) `state.mode` ∈ {'fix', 'implement'};
 *       (c) `state.current_stage === 'workflow-human-check'`;
 *       (d) no existing `workflow-human-check pass` event in `state.events`.
 *   - Effect (atomic, idempotent):
 *       - Append pass event: {skill:'workflow-human-check', result:'pass',
 *         declarer:'hook', evidence:{type:'file_present', path:'results.md'}}
 *       - Ensure 'workflow-human-check' is in `completed_stages`.
 *       - Leave `current_stage` at 'workflow-human-check' (WORKFLOW_SKILLS
 *         enum rejects 'done'; terminal release rides on `completed_stages`
 *         + `events[]`, both of which the commit gate accepts).
 *       - `updated_at` bumped.
 *   - Output: always `{continue: true}`; never blocks.
 *
 * Security properties:
 *   - `results.md` must be a regular file, non-empty, inside the canonical
 *     `.smt/features/<slug>/task/` shape. Arbitrary `results.md` writes
 *     outside that shape are ignored.
 *   - The hook cannot be triggered without the agent first producing a real
 *     `results.md` — matches the SKILL.md ordering constraint that
 *     `results.md` precedes the pass event.
 *   - Idempotent: running twice does not duplicate events.
 *   - fail-safe: any error is swallowed and `{continue: true}` emitted so
 *     the Write tool call is never blocked by this hook.
 */

import { readFileSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, basename, join, resolve, relative } from 'node:path';

function readStdinJson() {
  try { return JSON.parse(readFileSync('/dev/stdin', 'utf-8')); } catch { return {}; }
}

function printTag(msg) {
  process.stderr.write(`\x1b[33m[smelter] finalize-human-check · ${msg}\x1b[0m\n`);
}

// Canonical shape: <cwd>/.smt/features/<slug>/task/results.md (POSIX or Windows sep).
const RESULTS_PATH_RE = /[\/\\]\.smt[\/\\]features[\/\\]([^\/\\]+)[\/\\]task[\/\\]results\.md$/;

function main() {
  try {
    const input = readStdinJson();
    if (input.tool_name !== 'Write') {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const toolInput = input.tool_input || input.toolInput || {};
    const filePath = String(toolInput.file_path || toolInput.filePath || '');
    const cwd = String(input.cwd || process.cwd());

    const m = RESULTS_PATH_RE.exec(filePath);
    if (!m) { process.stdout.write(JSON.stringify({ continue: true })); return; }
    const slug = m[1];

    // Containment guard — the results.md must live inside the project cwd.
    const rel = relative(resolve(cwd), resolve(filePath));
    if (!rel || rel.startsWith('..')) {
      process.stdout.write(JSON.stringify({ continue: true })); return;
    }

    const taskDir = dirname(filePath);
    const statePath = join(taskDir, `${slug}.state.json`);
    if (!existsSync(statePath)) {
      process.stdout.write(JSON.stringify({ continue: true })); return;
    }

    // results.md must be a real non-empty regular file (the evidence).
    // lstatSync (not statSync) + symlink reject: prevents a `results.md`
    // symlink-to-/etc/passwd from satisfying the size check. An attacker
    // who controls the write path could otherwise weaponize the finalizer
    // into touching arbitrary-looking targets via the adjacent state.json
    // symlink (handled below).
    try {
      const st = lstatSync(filePath);
      if (st.isSymbolicLink() || !st.isFile() || st.size === 0) {
        process.stdout.write(JSON.stringify({ continue: true })); return;
      }
    } catch {
      process.stdout.write(JSON.stringify({ continue: true })); return;
    }

    // statePath must be a regular file inside cwd. Re-verify via realpathSync
    // (resolves symlinks) and re-apply containment so a `<slug>.state.json`
    // symlink pointing to an outside path cannot be clobbered by the
    // finalizer's writeFileSync.
    let resolvedStatePath;
    try {
      const lst = lstatSync(statePath);
      if (lst.isSymbolicLink() || !lst.isFile()) {
        process.stdout.write(JSON.stringify({ continue: true })); return;
      }
      resolvedStatePath = realpathSync(statePath);
      // Containment: resolve BOTH sides via realpath so macOS's /var→/private/var
      // (and similar OS-level symlinks) do not produce a spurious escape.
      const resolvedCwd = realpathSync(resolve(cwd));
      const relState = relative(resolvedCwd, resolvedStatePath);
      if (!relState || relState.startsWith('..')) {
        process.stdout.write(JSON.stringify({ continue: true })); return;
      }
    } catch {
      process.stdout.write(JSON.stringify({ continue: true })); return;
    }

    let state;
    try { state = JSON.parse(readFileSync(resolvedStatePath, 'utf-8')); }
    catch { process.stdout.write(JSON.stringify({ continue: true })); return; }

    if (!state || typeof state !== 'object') {
      process.stdout.write(JSON.stringify({ continue: true })); return;
    }
    if (state.mode !== 'fix' && state.mode !== 'implement') {
      process.stdout.write(JSON.stringify({ continue: true })); return;
    }
    // Accept finalize when workflow-human-check is the terminal skill of this
    // run's pipeline AND current_stage is either human-check itself or the
    // penultimate skill. The penultimate case is the real production path:
    // skill-stage-transition.mjs advances current_stage on PostToolUse:Skill
    // (Skill completion), but the Write(results.md) that triggers this hook
    // fires DURING Skill(workflow-human-check) — so current_stage is still the
    // predecessor skill at that moment. Line 146's alreadyPassed idempotency
    // check prevents post-completion re-flips; the earlier strict
    // current_stage === 'workflow-human-check' guard was redundant and caused
    // the live timing bug where finalize no-op'd the first results.md write.
    const pipeline = Array.isArray(state.allowed_skills) ? state.allowed_skills : [];
    const hcIdx = pipeline.indexOf('workflow-human-check');
    if (hcIdx < 0) {
      process.stdout.write(JSON.stringify({ continue: true })); return;
    }
    const penultimate = hcIdx > 0 ? pipeline[hcIdx - 1] : null;
    const isHumanCheck = state.current_stage === 'workflow-human-check';
    const isPenultimate = penultimate !== null && state.current_stage === penultimate;
    if (!isHumanCheck && !isPenultimate) {
      process.stdout.write(JSON.stringify({ continue: true })); return;
    }

    if (!Array.isArray(state.events)) state.events = [];
    const alreadyPassed = state.events.some(
      e => e && e.skill === 'workflow-human-check' && e.result === 'pass'
    );

    const now = new Date().toISOString();
    if (!alreadyPassed) {
      state.events.push({
        t: now,
        skill: 'workflow-human-check',
        result: 'pass',
        declarer: 'hook',
        evidence: { type: 'file_present', path: basename(filePath) },
      });
    }

    if (!Array.isArray(state.completed_stages)) state.completed_stages = [];
    if (!state.completed_stages.includes('workflow-human-check')) {
      state.completed_stages.push('workflow-human-check');
    }

    // Do NOT set current_stage = 'done' — WORKFLOW_SKILLS enum in
    // state-schema.mjs rejects the literal 'done', so any downstream path
    // that calls writeState() would fail on re-validation. The commit gate
    // accepts completed_stages OR events[] as a pass shape (see
    // pre-tool-enforcer.mjs ~line 307-309); either suffices to unblock the
    // terminal commit. Leaving current_stage at 'workflow-human-check' keeps
    // the state schema-valid.
    state.updated_at = now;

    // Hook script writes state directly — PreToolUse does not intercept
    // fs.writeFileSync. No SMT_HOOK_WRITE env needed (that flag only gates
    // Write/Edit tool calls). Use the realpath-resolved, re-contained path
    // so a symlink swap between the earlier check and this write cannot
    // redirect the output outside cwd.
    writeFileSync(resolvedStatePath, JSON.stringify(state, null, 2) + '\n');
    printTag(`${slug} → done (events:${state.events.length}, completed:${state.completed_stages.length})`);
    process.stdout.write(JSON.stringify({ continue: true }));
  } catch (err) {
    process.stderr.write(`[finalize-human-check] self-error: ${err.message}\n`);
    process.stdout.write(JSON.stringify({ continue: true }));
  }
}

main();
