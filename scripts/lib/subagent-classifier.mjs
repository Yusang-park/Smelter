#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TIMEOUT_MS = 3000;
const CACHE_FILE = 'keyword-cache.json';

const CLASSIFICATION_PROMPT = `You are a command classifier for a CLI tool called "smelter". Classify the user's prompt as either a command or a question/explanation request.

Commands available: tasker (planning), feat (full dev workflow), qa (bug fix / simple edit), cancel, queue.

Rules:
- If the user is ASKING about a command (e.g. "how does tasker work?", "explain plan") → question
- If the user WANTS TO EXECUTE something → command
- If the user describes a problem to SOLVE, FIX, BUILD, or IMPLEMENT → command (not question)
- If ambiguous but the prompt describes broken behavior, errors, or work to do → default to command

Strong qa signals (any of these → command:qa):
  fix, bug, error, crash, broken, failing, deploy fail, build fail, ELIFECYCLE, exit code,
  버그, 고쳐, 터지, 에러, 수정, 해결해, 안됨, 안돼, 깨짐, 실패

Strong feat signals (any of these → command:feat):
  add, create, build, implement, new feature, 추가, 만들어, 새 기능, 구현

Strong tasker signals (any of these → command:tasker):
  plan, design, scope, 설계, 계획, 기획

Branch hints for commands:
- feat + "extend/add to/덧붙여/확장" → branch: "extend"
- feat + "new feature/새 기능" → branch: "new-feature"
- qa + "fix/bug/버그/고쳐/터지/에러" → branch: "bug"
- qa + "style/typo/i18n/텍스트/색상" → branch: "style"

Return ONLY valid JSON (no markdown, no explanation):
{"intent":"command"|"question","command":"<name>","branch":"<hint-or-empty>","reason":"<short>"}`;

function promptHash(prompt) {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

function readCache(stateDir, sessionId) {
  const path = join(stateDir, CACHE_FILE);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (data._session !== sessionId) return {};
    return data;
  } catch { return {}; }
}

function writeCache(stateDir, sessionId, cache) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, CACHE_FILE), JSON.stringify({ ...cache, _session: sessionId }));
}

let claudeAvailable = null;
function isClaudeAvailable() {
  if (claudeAvailable !== null) return claudeAvailable;
  try {
    execFileSync('which', ['claude'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 1000 });
    claudeAvailable = true;
  } catch {
    claudeAvailable = false;
  }
  return claudeAvailable;
}

export function classifyPrompt(prompt, { cwd = process.cwd(), sessionId = '' } = {}) {
  const stateDir = join(cwd, '.smt', 'state');
  const hash = promptHash(prompt);
  const cache = readCache(stateDir, sessionId);

  if (cache[hash]) return cache[hash];

  let result = { intent: 'question', command: '', branch: '', reason: 'fallback' };

  if (!isClaudeAvailable()) {
    result = { intent: 'question', command: '', branch: '', reason: 'claude-not-available' };
    cache[hash] = result;
    try { writeCache(stateDir, sessionId, cache); } catch {}
    return result;
  }

  try {
    const fullPrompt = `${CLASSIFICATION_PROMPT}\n\nUser prompt: "${prompt}"`;
    const stdout = execFileSync('claude', ['-p', '--model', 'haiku', '--output-format', 'json', fullPrompt], {
      timeout: TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const parsed = JSON.parse(stdout.trim());
    if (parsed.intent === 'command' || parsed.intent === 'question') {
      result = {
        intent: parsed.intent,
        command: parsed.command || '',
        branch: parsed.branch || '',
        reason: parsed.reason || '',
      };
    }
  } catch {
    result = { intent: 'question', command: '', branch: '', reason: 'timeout-or-unavailable' };
  }

  cache[hash] = result;
  try { writeCache(stateDir, sessionId, cache); } catch {}
  return result;
}
