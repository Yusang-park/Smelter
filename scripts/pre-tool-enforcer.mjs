#!/usr/bin/env node

/**
 * PreToolUse Hook: Tool Description + Cancel Signal Check
 * Injects human-readable tool descriptions and handles cancel signals.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { readCancel } from './lib/cancel-signal.mjs';
import { printTag } from './lib/yellow-tag.mjs';
import { evaluateToolUse as evaluateV4ToolUse } from './lib/workflow-v4-guard.mjs';
import { resolveHookSessionId } from './lib/session-paths.mjs';

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

// Resolve the unscoped `active-feature.json` pointer ONLY when it carries
// the explicit seeder-asymmetry marker `session_id === ''`. The seeder
// writes the unscoped file whenever sessionId is empty at seed time
// (workflow-state-seeder.mjs:241-247); the stored `session_id` field is
// always the empty string in that path. Any other unscoped pointer is
// treated as stale cross-session state (see PLAN-C4 session-isolation
// invariant) and ignored here — returning `null` tells the caller that
// no fallback pointer is available.
function resolveUnscopedFallback(directory) {
  const ptrPath = join(directory, '.smt', 'state', 'active-feature.json');
  if (!existsSync(ptrPath)) return null;
  try {
    const ptr = JSON.parse(readFileSync(ptrPath, 'utf-8'));
    if (ptr && ptr.session_id === '') return ptrPath;
  } catch {}
  return null;
}

function resolveWorkflowRoot(directory) {
  let current = directory || process.cwd();
  while (current) {
    if (existsSync(join(current, '.smt'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directory || process.cwd();
}

function main() {
  printTag('Pre Tool Enforcer');
  try {
    const input = readStdinSync();

    const toolName = extractJsonField(input, 'tool_name') || extractJsonField(input, 'toolName', 'unknown');
    printTag(`Pre Tool: ${toolName}`);
    const directory = extractJsonField(input, 'cwd') || extractJsonField(input, 'directory', process.cwd());
    const workflowRoot = resolveWorkflowRoot(directory);

    let data = {};
    try { data = JSON.parse(input); } catch {}
    const sessionId = resolveHookSessionId(data);

    // --- Block native EnterPlanMode only during Smelter /brainstorm (planning) ---
    // Smelter's /brainstorm → workflow-brainstorm (depth: deep) OWNS planning. Native
    // plan mode during /brainstorm is redundant and breaks file-based memory.
    // Other modes (/fix, /implement, /explore, /verify) MAY legitimately use
    // native plan mode — do not block them.
    // Fail-open: malformed / missing / command-less workflow.json allows the tool.
    if (toolName === 'ExitPlanMode' || toolName === 'EnterPlanMode') {
      // Prefer the session-scoped pointer. Fall back to the unscoped pointer
      // ONLY when it carries the explicit seeder-asymmetry marker
      // `session_id === ''` — the seeder writes the unscoped file whenever
      // sessionId is empty at seed time (workflow-state-seeder.mjs:241-247).
      // Any other unscoped pointer (missing session_id or non-empty sid from
      // another session) is treated as stale cross-session state and
      // ignored — preserving the session-isolation invariant in PLAN-C4.
      const smtStateScoped = sessionId
          ? join(workflowRoot, '.smt', 'state', `active-feature-${sessionId}.json`)
          : join(workflowRoot, '.smt', 'state', 'active-feature.json');
      const smtState = existsSync(smtStateScoped)
        ? smtStateScoped
        : resolveUnscopedFallback(workflowRoot, sessionId);
      let isBrainstormMode = false;
      try {
        if (smtState && existsSync(smtState)) {
          const pointer = JSON.parse(readFileSync(smtState, 'utf-8'));
          if (pointer?.slug) {
            const statePath = join(workflowRoot, '.smt', 'features', pointer.slug, 'state', 'workflow.json');
            if (existsSync(statePath)) {
              const wf = JSON.parse(readFileSync(statePath, 'utf-8'));
              isBrainstormMode = wf?.command === 'brainstorm';
            }
          }
        }
      } catch {}
      if (isBrainstormMode) {
        printTag(`Block: ${toolName} (Smelter /brainstorm active)`);
        console.log(JSON.stringify({
          decision: 'block',
          reason: `[SMELTER] Native plan mode (${toolName}) is blocked during Smelter /brainstorm. The workflow-brainstorm skill (depth: deep) is the planning engine for /brainstorm — use it instead of native plan mode. Agent recovery: invoke Skill(brainstorm) yourself for new planning work, or follow the injected step prompt for the current workflow. Do not ask the user to type a slash command.`,
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

    // --- Block writes to unknown-slug .smt/features/ paths (divergence guard) ---
    // Closes the state↔artifact divergence bug: if an agent creates / writes
    // into `.smt/features/<X>/...` where X doesn't match the active-feature
    // pointer's slug, the resulting artifacts become orphaned (state machine
    // keeps tracking the pointer's slug while artifacts accumulate under X).
    // Guard enforces single-slug-per-session via pre-tool check on Write/Edit
    // and Bash mkdir.
    if (process.env.SMT_HOOK_WRITE !== '1') {
      const toolInputData = data.tool_input || data.toolInput || {};
      const candidatePaths = [];
      if (toolName === 'Write' || toolName === 'Edit') {
        const p = String(toolInputData.file_path || toolInputData.filePath || '');
        if (p) candidatePaths.push(p);
      } else if (toolName === 'Bash') {
        const cmd = String(toolInputData.command || '');
        // Extract target paths from mkdir, touch, mv, cp. Keep it simple —
        // match anything that contains `.smt/features/` so the guard is
        // conservative by default.
        const m = cmd.match(/\.smt[\/\\]features[\/\\][^\s\/\\'"]+/g);
        if (m) candidatePaths.push(...m);
      }
      for (const raw of candidatePaths) {
        const match = raw.match(/[\/\\]?\.smt[\/\\]features[\/\\]([^\/\\]+)/);
        if (!match) continue;
        const targetSlug = match[1];
        // Resolve active pointer — scoped first, seeder-asymmetry-marked
        // unscoped as fallback. See resolveUnscopedFallback for the
        // isolation rule (only pointer.session_id === '' is honored).
        const ptrScoped = sessionId
          ? join(workflowRoot, '.smt', 'state', `active-feature-${sessionId}.json`)
          : join(workflowRoot, '.smt', 'state', 'active-feature.json');
        const ptrPath = existsSync(ptrScoped)
          ? ptrScoped
          : resolveUnscopedFallback(workflowRoot, sessionId);
        let activeSlug = null;
        try {
          if (ptrPath && existsSync(ptrPath)) {
            const ptr = JSON.parse(readFileSync(ptrPath, 'utf-8'));
            activeSlug = ptr?.slug || null;
          }
        } catch { /* fall through — no active slug */ }
        if (activeSlug && targetSlug !== activeSlug) {
          printTag(`Block: divergence guard (target=${targetSlug}, active=${activeSlug})`);
          console.log(JSON.stringify({
            decision: 'block',
            reason: `[SMELTER] ${toolName} targets .smt/features/${targetSlug}/ but the active-feature slug is ${activeSlug}.\n` +
              `All task artifacts must live under .smt/features/${activeSlug}/ to keep state and artifacts in sync.\n` +
              `If you need a new feature, invoke the appropriate command Skill yourself to seed a new workflow — do NOT mkdir a parallel features/ dir within this session or ask the user to type a slash command.`,
          }));
          return;
        }
      }
    }

    // --- v3.3: Force code-file Edit/Write through a Smelter workflow ---
    // User directive (2026-04-23): every CODE file modification, no matter
    // how trivial, must run inside an active write/infra/freeform workflow so
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
      // json/jsonc intentionally ungated (v3.3.6) — declarative configs
      // (package.json, tsconfig.json, plugin.json, etc.) are parallel to
      // YAML and should not require a /fix workflow for trivial edits.
      // Protected state files under .smt/ are blocked separately by
      // PROTECTED_RE regardless of this list.
      'toml',
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
      const isWorkflowArtifactPath = /[\/\\]\.smt[\/\\]features[\/\\][^\/\\]+[\/\\](?:task|artifacts)[\/\\]/.test(filePath);
      if (isWorkflowArtifactPath || (!isInternalSmtPath && isCodeFile(filePath))) {
        // Resolve workflow pointer — scoped first, seeder-asymmetry-marked
        // unscoped as fallback. See resolveUnscopedFallback for the
        // isolation rule (only pointer.session_id === '' is honored).
        const smtStateScoped = sessionId
          ? join(workflowRoot, '.smt', 'state', `active-feature-${sessionId}.json`)
          : join(workflowRoot, '.smt', 'state', 'active-feature.json');
        const smtState = existsSync(smtStateScoped)
          ? smtStateScoped
          : resolveUnscopedFallback(workflowRoot, sessionId);
        let allowedMode = null;
        let v4TaskType = null;
        try {
          if (smtState && existsSync(smtState)) {
            const pointer = JSON.parse(readFileSync(smtState, 'utf-8'));
            if (pointer?.slug) {
              const statePath = join(workflowRoot, '.smt', 'features', pointer.slug, 'task', `${pointer.slug}.state.json`);
              if (existsSync(statePath)) {
                const state = JSON.parse(readFileSync(statePath, 'utf-8'));
                if (typeof state?.task_type === 'string') {
                  v4TaskType = state.task_type;
                  const verdict = evaluateV4ToolUse(state, { toolName, filePath });
                  if (verdict.decision === 'block') {
                    printTag(`Block: ${toolName} by v0.4 guard (${verdict.reason})`);
                    console.log(JSON.stringify({
                      decision: 'block',
                      reason: `[SMELTER] v0.4 guard blocked ${toolName} on ${isWorkflowArtifactPath ? 'workflow artifact' : 'code file'}: ${filePath}\n${verdict.reason}`,
                    }));
                    return;
                  }
                  if (isWorkflowArtifactPath) return;
                  if (verdict.decision === 'allow' && (state.task_type === 'write' || state.task_type === 'infra' || state.task_type === 'freeform')) {
                    allowedMode = state.user_mode || state.mode || state.task_type;
                  }
                } else if (state?.mode === 'fix' || state?.mode === 'implement' || state?.mode === 'dobby') {
                  allowedMode = state.mode;
                }
              }
            }
          }
        } catch {}
        if (!allowedMode && !isWorkflowArtifactPath) {
          const v4Suffix = v4TaskType ? ` Current v0.4 task_type=${v4TaskType}.` : '';
          printTag(`Block: ${toolName} code file requires active write/infra/freeform workflow`);
          console.log(JSON.stringify({
            decision: 'block',
            reason: `[SMELTER] Raw ${toolName} of code file is blocked: ${filePath}\n` +
              `v0.4 guard requires an active source-edit workflow for code-file edits.${v4Suffix}\n` +
              `All code-file modifications — including trivial text / design edits within code — require an active Smelter workflow so workflow-human-check is the terminal gate.\n` +
              `Agent recovery: for normal feature work, invoke Skill(implement); for bug fixes, invoke Skill(fix); for infrastructure work, invoke Skill(infra). If an existing active workflow pointer is present, continue that workflow instead. Do not ask the user to type a slash command. Then re-issue the ${toolName}.\n` +
              `Docs (.md / .txt / .rst) are NOT gated by this rule — only code files.\n` +
              `Iron Law #1 — never complete without workflow-human-check. Surface-exempt text/design fixes also count as workflow runs.`,
          }));
          return;
        }
      }
    }

    // --- Current rule: block `git commit` before workflow-human-check ---
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
          ? join(workflowRoot, '.smt', 'state', `active-feature-${sessionId}.json`)
          : join(workflowRoot, '.smt', 'state', 'active-feature.json');
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
              const statePath = join(workflowRoot, '.smt', 'features', pointer.slug, 'task', `${pointer.slug}.state.json`);
              if (existsSync(statePath)) {
                stateFileExists = true;
                const state = JSON.parse(readFileSync(statePath, 'utf-8'));
                const needsHumanCheck = typeof state?.task_type === 'string'
                  ? (state.task_type === 'write' || state.task_type === 'infra' || state.task_type === 'freeform')
                  : (state?.mode === 'fix' || state?.mode === 'implement' || state?.mode === 'dobby');
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
              `Agent recovery: do not attempt commit. Re-invoke workflow-human-check if the active state can be rebuilt; otherwise report the corrupted workflow state for user-directed recovery. Do not ask the user to type a slash command.`;
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

    // --- Normal flow: tool description + optional Read-first reminder ---
    // Prevention for the Claude Code harness error:
    //   "File has not been read yet. Read it first before writing to it."
    // The harness rejects Write/Edit of any file not Read in the current
    // session, and can also reject stale snapshots when the file changed after
    // the last Read. We inject a reminder whenever Write/Edit targets an
    // EXISTING on-disk file so the agent refreshes content instead of hitting
    // a validation error. New-file writes (path does not exist) carry no
    // reminder — there is nothing to Read.
    const toolInput = data.toolInput || data.tool_input || null;
    const desc = generateToolDescription(toolName, toolInput);

    let readFirstReminder = '';
    if (toolName === 'Write' || toolName === 'Edit') {
      const ti = toolInput || {};
      const fp = String(ti.file_path || ti.filePath || '');
      if (fp) {
        try {
          if (existsSync(fp)) {
            readFirstReminder = `Read-first: existing file. Read/re-read before ${toolName} if unread, stale, or modified since read. New files exempt.`;
          }
        } catch {}
      }
    }

    const contextParts = [];
    if (desc) contextParts.push(desc);
    if (readFirstReminder) contextParts.push(readFirstReminder);

    if (contextParts.length > 0) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: contextParts.join('\n')
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
