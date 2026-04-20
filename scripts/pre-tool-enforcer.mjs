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
