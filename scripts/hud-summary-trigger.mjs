#!/usr/bin/env node
/**
 * PostToolUse hook — triggers HUD task summary via subagent.
 *
 * Checks if the current session has an unsummarized prompt in the HUD cache.
 * If so, returns additionalContext asking the main model to spawn a background
 * Haiku agent to write a one-line summary. Fires at most once per prompt.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizeSessionId } from './auto-confirm.mjs';

const SETTINGS_PATH = '/Users/yusang/smelter/settings.json';
const CODEX_SUBAGENT_MODEL = 'gpt-5.4-mini';
const DEFAULT_SUBAGENT_MODEL = 'haiku';
const ACTIVE_MODEL_ENV = process.env.SMELTER_ACTIVE_MODEL || '';

const CACHE_DIR = join(homedir(), '.claude', 'hud', 'task-summary');
const PASS = JSON.stringify({ continue: true, suppressOutput: true });

function isCodexModel(model = '') {
  return ['gpt-', 'o3', 'o4', 'codex'].some((prefix) => model.startsWith(prefix));
}

function readMainModel() {
  if (ACTIVE_MODEL_ENV) return ACTIVE_MODEL_ENV;
  const sid = sanitizeSessionId(process.env.SMELTER_SESSION_ID);
  if (sid) {
    try {
      const statePath = join(process.cwd(), '.smt', 'state', `model-mode-${sid}.json`);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      if (state?.mode === 'codex' && typeof state.model === 'string') {
        return state.model.replace(/^Codex\s+/i, '').trim();
      }
    } catch {}
  }
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    return String(settings.model ?? '');
  } catch {
    return '';
  }
}

function selectSummarySubagentModel() {
  return isCodexModel(readMainModel()) ? CODEX_SUBAGENT_MODEL : DEFAULT_SUBAGENT_MODEL;
}

function cacheKeyForCwd(cwd) {
  return Buffer.from(cwd || 'default').toString('base64url');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const input = await readStdin();
  let cwd;
  try {
    const data = JSON.parse(input);
    cwd = data.cwd || data.directory || process.cwd();
  } catch {
    cwd = process.cwd();
  }

  const cwdKey = cacheKeyForCwd(cwd);
  const cachePath = join(CACHE_DIR, `${cwdKey}.json`);

  if (!existsSync(cachePath)) { console.log(PASS); return; }

  let cached;
  try { cached = JSON.parse(readFileSync(cachePath, 'utf8')); }
  catch { console.log(PASS); return; }

  // Only trigger if summary is missing, not already requested, and raw_prompt exists
  if (cached.summary || cached.summary_requested || !cached.raw_prompt) {
    console.log(PASS);
    return;
  }

  // Check age — only summarize recent prompts (within 5 minutes)
  const age = Date.now() - new Date(cached.timestamp).getTime();
  if (age > 5 * 60 * 1000) { console.log(PASS); return; }

  // Mark as requested to prevent re-triggering
  try {
    writeFileSync(cachePath, JSON.stringify({ ...cached, summary_requested: true }, null, 2));
  } catch { /* ignore */ }

  const prompt = cached.raw_prompt.length > 200
    ? cached.raw_prompt.slice(0, 200)
    : cached.raw_prompt;

  const escaped = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
  const subagentModel = selectSummarySubagentModel();
  const modelLabel = subagentModel === DEFAULT_SUBAGENT_MODEL ? 'Haiku' : subagentModel;

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `[HUD Summary Required] Spawn a background ${modelLabel} agent to summarize the current task. Run: Agent({ subagent_type: "executor-low", model: "${subagentModel}", run_in_background: true, prompt: "Read ${cachePath}, update the summary field with a one-line summary (max 30 chars, same language as the request) of: ${escaped}. Write the updated JSON back." })`
    }
  }));
}

main().catch(() => { console.log(PASS); });
