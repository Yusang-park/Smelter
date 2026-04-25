#!/usr/bin/env node
/**
 * pretool-stage-gate.mjs — PreToolUse hook that gates code-mutating tool
 * invocations on whether the active stage's required skill has been loaded
 * in the current stage epoch.
 *
 * - tool_name === 'Skill' → append-only record to loaded-skills-<sid>.jsonl,
 *   always allow.
 * - Mutating tools (Write/Edit/NotebookEdit, mutating MCP, non-readonly Bash)
 *   → deny unless current_stage skill present in current-epoch log.
 * - Read-only Bash / non-mutating tools → pass-through.
 *
 * Modes (SMT_STAGE_GATE_MODE env):
 *   off     — full bypass
 *   enforce — actual block (default)
 *
 * Bypass: SMT_DISABLE_STAGE_GATE=1 plus ~/.smt/bypass-token mtime < 1h.
 *
 * Fail-closed: uncaught exception → decision=block with gate-error reason.
 */

import { readFileSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  loadedSkillsPath,
  resolveActiveState,
  sanitizeSessionId
} from './lib/session-paths.mjs';
import { classifyCommand } from './lib/shell-tokenize.mjs';

const READONLY_BASH = new Set([
  'ls', 'cat', 'grep', 'rg', 'head', 'tail', 'wc', 'find', 'which',
  'pwd', 'echo', 'ps', 'date', 'stat', 'file', 'readlink', 'basename',
  'dirname', 'jq', 'sort', 'uniq', 'awk', 'printenv', 'env', 'git',
  'node', 'pnpm', 'npm', 'tsc', 'true', 'false', 'realpath', 'tr'
]);

// Mutating git subcommands. Checked before classifyCommand: even though `git`
// is in READONLY_BASH (for status/log/diff/etc.), these subcommands write.
const MUTATING_GIT_RE = /\bgit\s+(commit|push|pull|merge|rebase|cherry-pick|revert|reset|checkout|switch|restore|add|rm|mv|clean|stash\b(?!\s+(?:list|show|diff))|fetch|clone|init|am|apply|tag\s+-[dD]|branch\s+-[dD]|remote\s+(?:add|remove|set-url)|config\s+--(?:add|set|unset|replace-all|remove-section))\b/;

const MUTATING_MCP = new Set([
  'mcp__serena__replace_symbol_body',
  'mcp__serena__insert_after_symbol',
  'mcp__serena__insert_before_symbol',
  'mcp__serena__rename_symbol',
  'mcp__serena__safe_delete_symbol',
  'mcp__serena__write_memory',
  'mcp__serena__edit_memory',
  'mcp__serena__delete_memory'
]);

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

function getMode() {
  const m = (process.env.SMT_STAGE_GATE_MODE || 'enforce').toLowerCase();
  return m === 'off' ? 'off' : 'enforce';
}

function bypassActive() {
  if (process.env.SMT_DISABLE_STAGE_GATE !== '1') return false;
  const tokenPath = join(homedir(), '.smt', 'bypass-token');
  try {
    const s = statSync(tokenPath);
    return Date.now() - s.mtimeMs < 60 * 60 * 1000;
  } catch { return false; }
}

function logStderr(tag, obj) {
  try { process.stderr.write(`[PreTool Stage Gate] ${tag} ${JSON.stringify(obj)}\n`); }
  catch { /* non-fatal */ }
}

function appendLoadedSkill(cwd, sessionId, skill, stageEpoch) {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return;
  const p = loadedSkillsPath(cwd, sessionId);
  try {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ skill, stageEpoch, ts: Date.now() }) + '\n', 'utf-8');
  } catch (e) { logStderr('append-error', { error: String(e && e.message || e) }); }
}

function resolveSkillLoadEpoch(active, skill) {
  if (!active || !active.state) return 'no-stage';
  if (
    typeof skill === 'string' &&
    skill.startsWith('workflow-') &&
    Array.isArray(active.state.allowed_skills) &&
    active.state.allowed_skills.includes(skill)
  ) {
    return `${active.slug}::${skill}`;
  }
  return active.state.current_stage ? `${active.slug}::${active.state.current_stage}` : 'no-stage';
}

function readLoadedSkills(cwd, sessionId) {
  const p = loadedSkillsPath(cwd, sessionId);
  try {
    const raw = readFileSync(p, 'utf-8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip partial */ }
    }
    return out;
  } catch { return []; }
}

function isMutatingTool(toolName, toolInput) {
  if (WRITE_TOOLS.has(toolName)) return { mutating: true, reason: `write-tool:${toolName}` };
  if (MUTATING_MCP.has(toolName)) return { mutating: true, reason: `mutating-mcp:${toolName}` };
  if (toolName === 'Bash') {
    const cmd = toolInput && typeof toolInput.command === 'string' ? toolInput.command : '';
    if (MUTATING_GIT_RE.test(cmd)) return { mutating: true, reason: 'bash-mutating:git-write' };
    const r = classifyCommand(cmd, READONLY_BASH);
    if (!r.readonly) return { mutating: true, reason: `bash-mutating:${r.reason || 'unknown'}` };
  }
  return { mutating: false };
}

function isHumanCheckResultsWrite(active, toolInput) {
  const filePath = toolInput && typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  if (!filePath || !active?.statePath) return false;
  return resolve(filePath) === resolve(dirname(active.statePath), 'results.md');
}

function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

function emitAllow() { process.exit(0); }

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
  } catch (e) {
    logStderr('stdin-parse-error', { error: String(e && e.message || e) });
    emitAllow(); return;
  }

  const mode = getMode();
  if (mode === 'off') emitAllow();
  if (bypassActive()) {
    logStderr('bypass', { tool: input.tool_name });
    emitAllow();
    return;
  }

  const { tool_name, tool_input, session_id, cwd } = input;
  if (!cwd) emitAllow();

  // Skill tool: record load and always allow
  if (tool_name === 'Skill') {
    const skill = tool_input && tool_input.skill;
    if (typeof skill === 'string' && skill) {
      const active = resolveActiveState(cwd, session_id);
      const stageEpoch = resolveSkillLoadEpoch(active, skill);
      appendLoadedSkill(cwd, session_id, skill, stageEpoch);
      logStderr('skill-load', { skill, stageEpoch, mode });
    }
    emitAllow();
    return;
  }

  // Non-mutating tools: pass-through
  const check = isMutatingTool(tool_name, tool_input);
  if (!check.mutating) { emitAllow(); return; }

  // Resolve active state
  const active = resolveActiveState(cwd, session_id);
  if (!active) { emitAllow(); return; } // state file absent → pass-through

  if (active.state === null) {
    // corrupt state → fail-closed
    const reason = `gate-error: state.json unreadable at ${active.statePath}`;
    logStderr('state-error', { reason, mode });
    emitBlock(reason);
    return;
  }

  const currentStage = active.state.current_stage;
  if (currentStage == null) {
    const reason = `stage transition in progress for ${active.slug}; retry after Skill() dispatch`;
    logStderr('stage-null', { slug: active.slug, mode });
    emitBlock(reason);
    return;
  }

  if (isHumanCheckResultsWrite(active, tool_input) && currentStage !== 'workflow-human-check') {
    const reason = `Skill(workflow-human-check) must be the active stage before ${tool_name} writes results.md (current stage ${currentStage}; ${check.reason}).`;
    logStderr('block-results-before-human-check', { tool: tool_name, stage: currentStage, mode, reason: check.reason });
    emitBlock(reason);
    return;
  }

  const stageEpoch = `${active.slug}::${currentStage}`;
  const entries = readLoadedSkills(cwd, session_id);
  const loaded = entries.some((e) => e && e.skill === currentStage && e.stageEpoch === stageEpoch);

  if (loaded) {
    logStderr('allow', { tool: tool_name, stage: currentStage, mode });
    emitAllow();
    return;
  }

  const reason = `Skill(${currentStage}) must be loaded before ${tool_name} (stage epoch ${stageEpoch}; ${check.reason}).`;
  logStderr('block', { tool: tool_name, stage: currentStage, mode, reason: check.reason });
  emitBlock(reason);
}

process.on('uncaughtException', (e) => {
  const mode = getMode();
  process.stderr.write(`[PreTool Stage Gate] crash ${String(e && e.stack || e)}\n`);
  if (mode === 'off') emitAllow();
  process.stdout.write(JSON.stringify({ decision: 'block', reason: `gate-error: ${String(e && e.message || e)}` }));
  process.exit(0);
});

main();
