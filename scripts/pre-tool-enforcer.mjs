#!/usr/bin/env node

/**
 * PreToolUse Hook: Tool Description + Cancel Signal Check
 * Injects human-readable tool descriptions and handles cancel signals.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { readCancel } from './lib/cancel-signal.mjs';
import { printTag } from './lib/yellow-tag.mjs';

// Read stdin synchronously — hook scripts receive JSON via pipe, /dev/stdin returns immediately
function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

// Simple JSON field extraction
function extractJsonField(input, field, defaultValue = '') {
  try {
    const data = JSON.parse(input);
    return data[field] ?? defaultValue;
  } catch {
    const match = input.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, 'i'));
    return match ? match[1] : defaultValue;
  }
}

// looksLikeGitCommit — detect "git commit" invocations even through shell wrappers.
// Matches all of:
//   git commit ...
//   /path/to/git commit           (absolute path)
//   git -C /somedir commit        (dir override)
//   FOO=1 git commit              (env prefix)
//   bash -c 'git commit ...'      (shell wrapper)
//   sh -c "... git commit ..."    (same)
//   subshell invocation           (command substitution forms)
//   "; git commit", "&& git commit", "| git commit"
// Command aliases (gc / gcm) are NOT matched — alias-level gating would
// require an agent-controlled shell profile, out of scope.
function looksLikeGitCommit(command) {
  if (!command || typeof command !== 'string') return false;
  const stripped = String(command);

  // Match "git commit" with optional "-C <dir>" between, optionally prefixed by
  // a path (/usr/bin/git), preceded by start-of-string or a shell-boundary
  // character (whitespace, ; & | $ ( ` , single-quote ' , double-quote ").
  // Quote boundaries catch wrapped forms: bash -c 'git commit ...' / sh -c "... git commit ...".
  // Env prefix (FOO=1 git commit) handled by the whitespace boundary.
  const re = /(^|[\s;&|$(`'"])(?:[\w/.-]*\/)?git(?:\s+-C\s+\S+)?\s+commit\b/i;
  return re.test(stripped);
}

// Generate human-readable description of what the tool is actually doing
function generateToolDescription(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;

  switch (toolName) {
    case 'Glob': {
      const pattern = toolInput.pattern || '?';
      const path = toolInput.path ? ` in ${toolInput.path}` : '';
      return `Searching files: \`${pattern}\`${path}`;
    }
    case 'Grep': {
      const pattern = toolInput.pattern || '?';
      const glob = toolInput.glob ? ` [${toolInput.glob}]` : '';
      const path = toolInput.path ? ` in ${toolInput.path}` : '';
      return `Searching code: \`${pattern}\`${glob}${path}`;
    }
    case 'Read': {
      const file = toolInput.file_path || '?';
      const start = toolInput.offset || '';
      const end = (toolInput.offset && toolInput.limit) ? `-${toolInput.offset + toolInput.limit}` : '';
      const range = start ? ` (lines ${start}${end})` : '';
      return `Reading: \`${file}\`${range}`;
    }
    case 'Bash': {
      const cmd = (toolInput.command || '?').slice(0, 80);
      const bg = toolInput.run_in_background ? ' [background]' : '';
      return `Running: \`${cmd}\`${bg}`;
    }
    case 'Edit': {
      const file = toolInput.file_path || '?';
      return `Editing: \`${file}\``;
    }
    case 'Write': {
      const file = toolInput.file_path || '?';
      return `Writing: \`${file}\``;
    }
    case 'WebSearch': {
      const query = toolInput.query || '?';
      return `Searching web: "${query}"`;
    }
    case 'WebFetch': {
      const url = (toolInput.url || '?').slice(0, 60);
      return `Fetching: ${url}`;
    }
    default:
      return null;
  }
}

function main() {
  printTag('Pre Tool Enforcer');
  try {
    const input = readStdinSync();

    const toolName = extractJsonField(input, 'tool_name') || extractJsonField(input, 'toolName', 'unknown');
    printTag(`Pre Tool: ${toolName}`);
    const directory = extractJsonField(input, 'cwd') || extractJsonField(input, 'directory', process.cwd());

    let data = {};
    try { data = JSON.parse(input); } catch {}
    const sessionId = data.session_id || data.sessionId || '';

    // --- Block native EnterPlanMode when Smelter workflow is active ---
    // Smelter's /plan + step-3-interview gate OWNS planning. Native plan mode is redundant
    // and breaks file-based memory.
    if (toolName === 'ExitPlanMode' || toolName === 'EnterPlanMode') {
      // Check only the session-scoped pointer — a stale global pointer from
      // another session must not block this session's native plan mode.
      const smtState = sessionId
        ? join(directory, '.smt', 'state', `active-feature-${sessionId}.json`)
        : join(directory, '.smt', 'state', 'active-feature.json');
      let hasActiveWorkflow = false;
      try {
        if (existsSync(smtState)) {
          const pointer = JSON.parse(readFileSync(smtState, 'utf-8'));
          if (pointer?.slug) {
            const statePath = join(directory, '.smt', 'features', pointer.slug, 'state', 'workflow.json');
            hasActiveWorkflow = existsSync(statePath);
          }
        }
      } catch {}
      if (hasActiveWorkflow) {
        printTag(`Block: ${toolName} (Smelter workflow active)`);
        console.log(JSON.stringify({
          decision: 'block',
          reason: `[SMELTER] Native plan mode (${toolName}) is blocked while Smelter workflow is active. Smelter's own 10-step workflow engine (/plan → step-3-interview gate) handles planning. Use \`/plan <idea>\` to enter Smelter's planning workflow, or continue the current workflow by following the injected step prompt.`,
        }));
        return;
      }
    }

    // --- Block direct agent edits to workflow state + pointer files ---
    // Closes redirect attacks (security review C2): forging active_task pointer
    // or any .state.json anywhere is equivalent to editing the canonical state.
    // Matches both POSIX `/` and Windows `\` path separators.
    // Escape hatch: SMT_HOOK_WRITE=1 env var (reserved for hook scripts invoking
    // the agent's Write tool — real hook scripts use fs.writeFileSync and bypass
    // PreToolUse entirely).
    if (process.env.SMT_HOOK_WRITE !== '1' && (toolName === 'Write' || toolName === 'Edit')) {
      const toolInputData = data.tool_input || data.toolInput || {};
      const filePath = String(toolInputData.file_path || toolInputData.filePath || '');
      // Patterns that must never be agent-writable:
      //   .smt/features/<slug>/task/<task>.state.json   (canonical state)
      //   .smt/active_task                              (pointer → canonical state)
      //   .smt/state/active-feature.json                (session pointer)
      //   .smt/state/active-feature-<sid>.json          (per-session pointer)
      //   any *.state.json anywhere                     (forged-state redirect)
      // Scope all protected patterns under .smt/ so we never block third-party
      // files that happen to end in .state.json (e.g. terraform.state.json).
      const PROTECTED_RE = [
        /[\/\\]\.smt[\/\\]features[\/\\][^\/\\]+[\/\\]task[\/\\][^\/\\]+\.state\.json$/,
        /[\/\\]\.smt[\/\\]active_task$/,
        /[\/\\]\.smt[\/\\]state[\/\\]active-feature(?:-[^\/\\]+)?\.json$/,
        /[\/\\]\.smt[\/\\].*\.state\.json$/i,
      ];
      if (PROTECTED_RE.some(re => re.test(filePath))) {
        printTag(`Block: protected state path write (${filePath})`);
        console.log(JSON.stringify({
          decision: 'block',
          reason: `[SMELTER] Direct agent ${toolName} of workflow state/pointer file is forbidden: ${filePath}\n` +
            `State transitions must come from skill invocation (the skill-stage-transition hook writes state) ` +
            `or hook scripts using fs.writeFileSync directly. Invoke the appropriate workflow-* skill instead.`,
        }));
        return;
      }
    }

    // --- v3.3: Force code-file Edit/Write through a Smelter workflow ---
    // User directive (2026-04-23): every CODE file modification, no matter
    // how trivial, must run inside an active /fix or /implement workflow so
    // workflow-human-check is always the terminal gate. Raw agent edits that
    // bypass the pipeline are blocked here at PreToolUse.
    //
    // Scope (v3.3 clarification): CODE files only. Docs/plain-text
    // (.md / .txt / .rst) and files without a recognized code extension are
    // NOT subject to this gate. The intent is to stop behavior-changing edits
    // from running without review — docs are a separate lane.
    //
    // Bypass rules:
    //   - `.smt/` internals → handled by the protected-state rule above;
    //     other `.smt/` writes are hook / workflow bookkeeping.
    //   - SMT_HOOK_WRITE=1 → hook-script escape hatch (unchanged).
    //   - active state.mode ∈ {fix, implement} → allowed.
    //   - non-code file extension → allowed.
    //   - Everything else → blocked with guidance to seed a workflow first.
    const CODE_FILE_EXTENSIONS = new Set([
      'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
      'py', 'go', 'rs', 'rb', 'php', 'pl',
      'java', 'kt', 'kts', 'scala', 'groovy',
      'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx',
      'swift', 'm', 'mm',
      'sh', 'bash', 'zsh', 'fish',
      'sql', 'prisma', 'graphql', 'gql',
      'toml', 'json', 'jsonc',
      'vue', 'svelte', 'astro',
      'css', 'scss', 'sass', 'less',
      'html', 'htm', 'xml',
      'tf', 'tfvars',
      'lua', 'r', 'jl', 'dart', 'ex', 'exs', 'erl', 'clj', 'cljs',
    ]);
    function isCodeFile(path) {
      if (!path) return false;
      const base = String(path).split(/[\/\\]/).pop() || '';
      const dot = base.lastIndexOf('.');
      if (dot <= 0) return false;
      return CODE_FILE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
    }

    if (process.env.SMT_HOOK_WRITE !== '1' && (toolName === 'Write' || toolName === 'Edit')) {
      const toolInputData = data.tool_input || data.toolInput || {};
      const filePath = String(toolInputData.file_path || toolInputData.filePath || '');
      const isInternalSmtPath = /[\/\\]\.smt[\/\\]/.test(filePath);
      if (!isInternalSmtPath && isCodeFile(filePath)) {
        const smtState = sessionId
          ? join(directory, '.smt', 'state', `active-feature-${sessionId}.json`)
          : join(directory, '.smt', 'state', 'active-feature.json');
        let allowedMode = null;
        try {
          if (existsSync(smtState)) {
            const pointer = JSON.parse(readFileSync(smtState, 'utf-8'));
            if (pointer?.slug) {
              const statePath = join(directory, '.smt', 'features', pointer.slug, 'task', `${pointer.slug}.state.json`);
              if (existsSync(statePath)) {
                const state = JSON.parse(readFileSync(statePath, 'utf-8'));
                if (state?.mode === 'fix' || state?.mode === 'implement') {
                  allowedMode = state.mode;
                }
              }
            }
          }
        } catch {}
        if (!allowedMode) {
          printTag(`Block: ${toolName} code file requires active /fix or /implement workflow`);
          console.log(JSON.stringify({
            decision: 'block',
            reason: `[SMELTER] Raw ${toolName} of code file is blocked: ${filePath}\n` +
              `All code-file modifications — including trivial text / design edits within code — must run inside a Smelter /fix or /implement workflow so workflow-human-check is the terminal gate.\n` +
              `Required action: invoke \`/fix <description>\` (or a natural-language prompt the mode classifier routes to fix/implement) to seed state, then re-issue the ${toolName}.\n` +
              `Docs (.md / .txt / .rst) are NOT gated by this rule — only code files.\n` +
              `Iron Law #1 — never complete without workflow-human-check. fix_simple (target_type=text/design) also counts as a workflow run.`,
          }));
          return;
        }
      }
    }

    // --- v3.1: Block `git commit` before workflow-human-check (fix/implement modes) ---
    // When a code-modifying workflow is active and workflow-human-check has not
    // produced a pass event, agents must not commit. Human review is the last
    // gate; committing before it defeats the workflow's whole point.
    //
    // Shell-unwrap matching handles bypass attempts like:
    //   bash -c 'git commit -m x'
    //   /usr/bin/git commit
    //   git -C /path commit
    //   FOO=1 git commit
    //   somecmd && git commit
    //   $(which git) commit
    // The matcher strips shell-layer context and then searches for
    // `(^|/)git(\s+-C\s+\S+)?\s+commit\b` appearing ANYWHERE in the command.
    if (process.env.SMT_HOOK_WRITE !== '1' && toolName === 'Bash') {
      const toolInputData = data.tool_input || data.toolInput || {};
      const command = String(toolInputData.command || '');
      if (looksLikeGitCommit(command)) {
        const smtState = sessionId
          ? join(directory, '.smt', 'state', `active-feature-${sessionId}.json`)
          : join(directory, '.smt', 'state', 'active-feature.json');
        // Fail-CLOSED when an active pointer exists but state parsing fails.
        // An attacker who corrupts `.state.json` to bypass this gate gets
        // blocked instead of silently passing through.
        let blockReason = null;
        let pointerExists = false;
        let stateFileExists = false;
        try {
          if (existsSync(smtState)) {
            pointerExists = true;
            const pointer = JSON.parse(readFileSync(smtState, 'utf-8'));
            if (pointer?.slug) {
              const statePath = join(directory, '.smt', 'features', pointer.slug, 'task', `${pointer.slug}.state.json`);
              if (existsSync(statePath)) {
                stateFileExists = true;
                const state = JSON.parse(readFileSync(statePath, 'utf-8'));
                const needsHumanCheck = state?.mode === 'fix' || state?.mode === 'implement';
                if (needsHumanCheck) {
                  const completed = Array.isArray(state.completed_stages) ? state.completed_stages : [];
                  const events = Array.isArray(state.events) ? state.events : [];
                  // Two pass shapes produced by finalize-human-check.mjs on
                  // the user's `complete` click:
                  //   (a) events[] carries a workflow-human-check pass event,
                  //   (b) completed_stages includes workflow-human-check.
                  // Both are written by the same hook, so they coexist in the
                  // canonical flow. Either alone suffices.
                  const humanCheckPassed = completed.includes('workflow-human-check') ||
                    events.some(e => e?.skill === 'workflow-human-check' && e?.result === 'pass');
                  if (!humanCheckPassed) {
                    blockReason = `[SMELTER] git commit is blocked: ${state.mode} mode requires workflow-human-check to pass before commit.\n` +
                      `Current state: mode=${state.mode}, completed_stages=[${completed.join(', ')}], human-check=NOT_PASSED.\n` +
                      `Invoke workflow-human-check to present artifacts (screenshots, diffs, test output) to the user and obtain a pass verdict.\n` +
                      `Iron Law: Iron Law #5 — human review is the final file-verifiable gate for code-modifying modes.`;
                  }
                }
              }
            }
          }
        } catch (err) {
          // Fail-CLOSED when pointer exists but state is unreadable/unparseable.
          // Intent: an agent that corrupts state to bypass the gate does not win.
          // When pointer ITSELF is unreadable (no workflow active), fall through.
          if (pointerExists) {
            blockReason = `[SMELTER] git commit is blocked: active workflow pointer exists but state is unreadable (${err.message}).\n` +
              `Either (a) the state is corrupted — run \`/cancel hard\` and restart, or (b) re-invoke workflow-human-check to rebuild.`;
          }
        }
        if (blockReason) {
          printTag(`Block: git commit (see reason)`);
          console.log(JSON.stringify({ decision: 'block', reason: blockReason }));
          return;
        }
      }
    }

    // --- Cancel signal check ---
    const cancelSignal = readCancel(directory, sessionId);
    if (cancelSignal) {
      if (cancelSignal.type === 'hard') {
        console.error('\x1b[33m[smelter] PreToolUse · Guard: Cancel Signal\x1b[0m');
        console.log(JSON.stringify({
          decision: 'block',
          reason: '[CANCELLED] User issued /cancel. All tool execution is blocked. Stop working immediately and inform the user that cancellation is complete. Await new instructions.'
        }));
        return;
      }
      if (cancelSignal.type === 'queue' && cancelSignal.queued_intent) {
        const toolInput = data.toolInput || data.tool_input || null;
        const desc = generateToolDescription(toolName, toolInput) || toolName;
        console.log(JSON.stringify({
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: `${desc} | [QUEUED REDIRECT] After current step, switch to: "${cancelSignal.queued_intent}"`
          }
        }));
        return;
      }
    }

    // --- Normal flow: tool description only ---
    const toolInput = data.toolInput || data.tool_input || null;
    const desc = generateToolDescription(toolName, toolInput);

    if (desc) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: desc
        }
      }));
    } else {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
  } catch (error) {
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
