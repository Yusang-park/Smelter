#!/usr/bin/env node

/**
 * PostToolUse Hook: Verification Reminder System (Node.js)
 * Monitors tool execution and provides contextual guidance
 * Cross-platform: Windows, macOS, Linux
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { printTag } from './lib/yellow-tag.mjs';

// Read stdin synchronously — hook scripts receive JSON via pipe, /dev/stdin returns immediately
function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

// Append command to ~/.bash_history
function appendToBashHistory(command) {
  if (!command || typeof command !== 'string') return;

  // Clean command: trim, skip empty, skip if it's just whitespace
  const cleaned = command.trim();
  if (!cleaned) return;

  // Skip internal/meta commands that aren't useful in history
  if (cleaned.startsWith('#')) return;

  try {
    const historyPath = join(homedir(), '.bash_history');
    appendFileSync(historyPath, cleaned + '\n');
  } catch {
    // Silently fail - history is best-effort
  }
}

// Detect failures in Bash output — only match clear tool-level failure signals,
// not arbitrary occurrences of "error" / "failed" / "cannot" in stdout content.
function detectBashFailure(output) {
  const errorPatterns = [
    /^\s*(?:bash|zsh|sh):\s.+:\s+(?:permission denied|command not found|no such file)/im,
    /^(?:error|fatal):\s/im,
    /\bexit code:?\s*[1-9]\d*\b/i,
    /\bexit status\s+[1-9]\d*\b/i,
    /\baborted?\b.*\(core dumped\)/i,
    /^\s*npm ERR!\s/m,
    /^\s*ELIFECYCLE\s/m,
  ];

  return errorPatterns.some(pattern => pattern.test(output));
}

// Detect background operation — only match explicit background task indicators
function detectBackgroundOperation(output) {
  const bgPatterns = [
    /task_id/i,
    /run_in_background/i,
    /\bspawned\b/i,
  ];

  return bgPatterns.some(pattern => pattern.test(output));
}


// Detect write failure — check success indicators first to avoid false positives
// from file *contents* that contain words like "error" or "failed"
function detectWriteFailure(output) {
  // Known success messages from Claude Code Edit/Write tools
  if (/updated successfully|has been written|file written/i.test(output)) return false;

  // Specific error patterns that appear in tool failure messages (not file content)
  const errorPatterns = [
    /^Error:/m,
    /old_string.*not found/i,
    /did not match/i,
    /permission denied/i,
    /read-only file system/i,
    /no such file or directory/i,
  ];

  return errorPatterns.some(pattern => pattern.test(output));
}

// Detect the file-modified-since-read race specifically. This recovery is
// mechanical (re-Read then re-Edit/Write); generic write-failure guidance
// would mislead the agent into thinking the path is wrong.
//
// Guarded against false positives: arbitrary file *content* (or a hook's own
// guidance message) may contain the phrase "File has been modified since
// read" without being a real tool error. We only treat it as the race when
// the text is NOT a known success message AND looks like an error envelope
// (starts with "Error:" or contains the read-it-again hint).
function detectFileModifiedSinceRead(output) {
  if (!output) return false;
  if (/updated successfully|has been written|file written|file created/i.test(output)) return false;
  const phrase = /File has been modified since (last )?read\b/i;
  if (!phrase.test(output)) return false;
  // Require an error-shaped envelope to avoid matching docs / messages that
  // simply mention the phrase.
  return /^Error:|read it again before|either by the user or by a linter/im.test(output);
}

// Get agent completion summary from tracking state
function getAgentCompletionSummary(directory) {
  const trackingFile = join(directory, '.smt', 'state', 'subagent-tracking.json');
  try {
    if (existsSync(trackingFile)) {
      const data = JSON.parse(readFileSync(trackingFile, 'utf-8'));
      const agents = data.agents || [];
      const running = agents.filter(a => a.status === 'running');
      const completed = data.total_completed || 0;
      const failed = data.total_failed || 0;

      if (running.length === 0 && completed === 0 && failed === 0) return '';

      const parts = [];
      if (running.length > 0) {
        parts.push(`Running: ${running.length} [${running.map(a => a.agent_type.replace('smelter:', '')).join(', ')}]`);
      }
      if (completed > 0) parts.push(`Completed: ${completed}`);
      if (failed > 0) parts.push(`Failed: ${failed}`);

      return parts.join(' | ');
    }
  } catch {}
  return '';
}

// Track files modified by Claude (Write/Edit) for session-scoped E2E checks
function trackModifiedFile(filePath, directory) {
  if (!filePath) return;
  try {
    const projectHash = createHash('md5').update(directory).digest('hex').slice(0, 8);
    const trackingFile = `/tmp/smelter-session-files-${projectHash}.json`;
    let files = [];
    if (existsSync(trackingFile)) {
      try { files = JSON.parse(readFileSync(trackingFile, 'utf-8')); } catch { files = []; }
    }
    // Store relative path if inside project dir
    const rel = filePath.startsWith(directory) ? filePath.slice(directory.length + 1) : filePath;
    if (!files.includes(rel)) {
      files.push(rel);
      writeFileSync(trackingFile, JSON.stringify(files));
    }
  } catch { /* best-effort */ }
}

// Untrack files whose tests just ran successfully — removes the corresponding
// source file from the session-files tracking list so stop-stage-enforcer doesn't keep
// firing the "Step 8 E2E required" reminder after the user has already
// validated the change via tests. Marker = E2E completion for hook/script
// surfaces (where unit-test == real-interface invocation).
//
// Heuristic:
//   - Test command pattern: `node X.test.mjs`, `node X.test.js`, `*test*.{mjs,js,ts}` invocation
//   - Failure detection from existing detectBashFailure() suppresses the untrack
//   - For each `<base>.test.<ext>` referenced in the command, untrack `<base>.<ext>`
function untrackTestedFiles(command, output, directory) {
  if (!command || typeof command !== 'string') return;
  if (detectBashFailure(output)) return; // tests failed → keep tracking
  // Match every `<path>.test.<ext>` token in the command (including under bash -c).
  const re = /(?:^|[\s'"])([^\s'"]+\.test\.(mjs|js|ts|tsx|jsx|cjs))/g;
  const tested = new Set();
  let m;
  while ((m = re.exec(command)) !== null) {
    const testPath = m[1];
    const ext = m[2];
    const sourcePath = testPath.replace(new RegExp(`\\.test\\.${ext}$`), `.${ext}`);
    tested.add(sourcePath);
    // Also try matching by basename in case the source was tracked relative.
    const base = sourcePath.split('/').pop();
    tested.add(base);
  }
  if (tested.size === 0) return;
  try {
    const projectHash = createHash('md5').update(directory).digest('hex').slice(0, 8);
    const trackingFile = `/tmp/smelter-session-files-${projectHash}.json`;
    if (!existsSync(trackingFile)) return;
    let files = [];
    try { files = JSON.parse(readFileSync(trackingFile, 'utf-8')); } catch { return; }
    const before = files.length;
    files = files.filter(f => {
      const rel = f.startsWith(directory) ? f.slice(directory.length + 1) : f;
      const base = rel.split('/').pop();
      // Drop if absolute, relative, or basename matches any tested source.
      if (tested.has(rel) || tested.has(base) || tested.has(f)) return false;
      // Also drop if the tracked path *ends with* a tested suffix (e.g.
      // "scripts/auto-confirm.mjs" matches "auto-confirm.mjs").
      for (const t of tested) {
        if (rel.endsWith(t) || f.endsWith(t)) return false;
      }
      return true;
    });
    if (files.length !== before) {
      if (files.length === 0) {
        try { unlinkSync(trackingFile); } catch {}
      } else {
        writeFileSync(trackingFile, JSON.stringify(files));
      }
    }
  } catch { /* best-effort */ }
}

// Generate contextual message
function generateMessage(toolName, toolOutput, sessionId, toolCount, directory) {
  let message = '';

  switch (toolName) {
    case 'Bash':
      if (detectBashFailure(toolOutput)) {
        message = 'Command failed. Please investigate the error and fix before continuing.';
      } else if (detectBackgroundOperation(toolOutput)) {
        message = 'Background operation detected. Remember to verify results before proceeding.';
      }
      break;

    case 'Task':
    case 'TaskCreate':
    case 'TaskUpdate': {
      const agentSummary = getAgentCompletionSummary(directory);
      if (detectWriteFailure(toolOutput)) {
        message = 'Task delegation failed. Verify agent name and parameters.';
      } else if (detectBackgroundOperation(toolOutput)) {
        message = 'Background task launched. Use TaskOutput to check results when needed.';
      }
      if (agentSummary) {
        message = message ? `${message} | ${agentSummary}` : agentSummary;
      }
      break;
    }

    case 'Edit':
      if (detectFileModifiedSinceRead(toolOutput)) {
        message = 'File modified since last Read (likely by hook/linter). Re-Read the same file_path, then re-issue Edit with refreshed content. Do not stop or report this as a failure — recovery is mechanical.';
      } else if (detectWriteFailure(toolOutput)) {
        message = 'Edit operation failed. Verify file exists and content matches exactly.';
      } else {
        message = 'Code modified. Verify changes work as expected before marking complete.';
      }
      break;

    case 'Write':
      if (detectFileModifiedSinceRead(toolOutput)) {
        message = 'File modified since last Read (likely by hook/linter). Re-Read the same file_path, then re-issue Write with refreshed content. Do not stop or report this as a failure — recovery is mechanical.';
      } else if (detectWriteFailure(toolOutput)) {
        message = 'Write operation failed. Check file permissions and directory existence.';
      } else {
        message = 'File written. Test the changes to ensure they work correctly.';
      }
      break;

    case 'TodoWrite':
      if (/created|added/i.test(toolOutput)) {
        message = 'Todo list updated. Proceed with next task on the list.';
      } else if (/completed|done/i.test(toolOutput)) {
        message = 'Task marked complete. Continue with remaining todos.';
      } else if (/in_progress/i.test(toolOutput)) {
        message = 'Task marked in progress. Focus on completing this task.';
      }
      break;

    case 'Read':
      break;

    case 'Grep':
      if (/^0$|no matches/i.test(toolOutput)) {
        message = 'No matches found. Verify pattern syntax or try broader search.';
      }
      break;

    case 'Glob':
      if (!toolOutput.trim() || /no files/i.test(toolOutput)) {
        message = 'No files matched pattern. Verify glob syntax and directory.';
      }
      break;
  }

  return message;
}

function main() {
  printTag('Post Tool Verifier');
  try {
    const input = readStdinSync();
    const data = JSON.parse(input);

    const toolName = data.tool_name || data.toolName || '';
    const rawResponse = data.tool_response || data.toolOutput || '';
    const toolOutput = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
    const directory = data.cwd || data.directory || process.cwd();

    // Append Bash commands to ~/.bash_history for terminal recall
    if (toolName === 'Bash' || toolName === 'bash') {
      const toolInput = data.tool_input || data.toolInput || {};
      const command = typeof toolInput === 'string' ? toolInput : (toolInput.command || '');
      appendToBashHistory(command);
      // When a test command runs successfully, untrack the tested source files
      // so stop-stage-enforcer's "Step 8 E2E required" reminder doesn't keep firing for
      // surfaces that have already been validated through their real interface.
      untrackTestedFiles(command, toolOutput, directory);
    }

    // Track files modified by Claude for session-scoped E2E checks
    if (toolName === 'Write' || toolName === 'Edit') {
      const toolInput = data.tool_input || data.toolInput || {};
      const filePath = typeof toolInput === 'string' ? toolInput : (toolInput.file_path || toolInput.filePath || '');
      trackModifiedFile(filePath, directory);
    }

    // Generate contextual message
    const message = generateMessage(toolName, toolOutput, '', 0, directory);

    // Build response - use hookSpecificOutput.additionalContext for PostToolUse
    const response = { continue: true };
    if (message) {
      console.error(`\x1b[33m[smelter] PostToolUse · ${toolName}\x1b[0m`);
      response.hookSpecificOutput = {
        hookEventName: 'PostToolUse',
        additionalContext: message
      };
    } else {
      response.suppressOutput = true;
    }

    console.log(JSON.stringify(response, null, 2));
  } catch (error) {
    // On error, always continue
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
