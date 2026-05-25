#!/usr/bin/env node

/**
 * Global Claude Code hook wrapper for Archon workflow hook guidance.
 *
 * Archon's original hooks are node-level SDK responses in workflow YAML, not
 * standalone Claude settings commands. This wrapper mirrors the default Archon
 * workflow hook guidance so it can be tested globally from ~/.claude/settings.json.
 */

import { readFileSync } from 'fs';

function readStdinSync() {
  try {
    return readFileSync('/dev/stdin', 'utf-8');
  } catch {
    return '{}';
  }
}

function parseInput() {
  try {
    return JSON.parse(readStdinSync());
  } catch {
    return {};
  }
}

function getToolName(input) {
  return String(input.tool_name ?? input.toolName ?? 'unknown');
}

function emit(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function emitAdditionalContext(hookEventName, additionalContext) {
  emit({
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  });
}

function handlePreToolUse(toolName) {
  if (!/^(Write|Edit)$/.test(toolName)) return;

  emitAdditionalContext(
    'PreToolUse',
    [
      'Archon global hook test: before writing, verify this file is part of the active plan or a direct dependency of the planned target.',
      'Check import fan-out before changing widely imported modules.',
      'Unplanned edits increase rollback risk; explain the reason before proceeding.',
    ].join(' ')
  );
}

function handlePostToolUse(toolName) {
  if (/^(Write|Edit)$/.test(toolName)) {
    emit({
      systemMessage: [
        'Archon global hook test: you just modified a file.',
        'Run the relevant type check before making another change.',
        'Re-read the changed file and confirm the change preserved behavior and reduced complexity.',
        'If validation failed, fix it now instead of accumulating broken state.',
      ].join(' '),
    });
    return;
  }

  if (toolName === 'Read') {
    emitAdditionalContext(
      'PostToolUse',
      [
        'Archon global hook test: for the file just read, assess single responsibility, cognitive load, abstraction value, and dependency direction.',
        'Capture concrete concerns with file and line references before proposing changes.',
      ].join(' ')
    );
    return;
  }

  if (toolName === 'Bash') {
    emitAdditionalContext(
      'PostToolUse',
      [
        'Archon global hook test: check the exit code and diagnose failures before retrying.',
        'Do not blindly rerun failed validation commands.',
      ].join(' ')
    );
  }
}

function main() {
  const eventName = process.argv[2];
  const input = parseInput();
  const toolName = getToolName(input);

  if (eventName === 'PreToolUse') {
    handlePreToolUse(toolName);
    return;
  }

  if (eventName === 'PostToolUse') {
    handlePostToolUse(toolName);
  }
}

main();
