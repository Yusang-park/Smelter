#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SETTINGS_PATH = '/Users/yusang/smelter/settings.json';
const CODEX_SUBAGENT_MODEL = 'gpt-5.4-mini';
const DEFAULT_SUBAGENT_MODEL = 'haiku';

function isCodexModel(model = '') {
  return ['gpt-', 'o3', 'o4', 'codex'].some((prefix) => model.startsWith(prefix));
}

function readMainModel() {
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    return String(settings.model ?? '');
  } catch {
    return '';
  }
}

export function inspectClassifierModel(settingsModel = '') {
  return isCodexModel(settingsModel) ? CODEX_SUBAGENT_MODEL : DEFAULT_SUBAGENT_MODEL;
}

function selectClassifierModel() {
  return inspectClassifierModel(readMainModel());
}

export { selectClassifierModel };

const TIMEOUT_MS = 20000;
const CACHE_FILE = 'keyword-cache.json';
const AUTO_CONFIRM_CACHE_FILE = 'auto-confirm-cache.json';

const AUTO_CONFIRM_PROMPT = `You classify whether Claude should continue automatically after a stop hook.

Return ONLY valid JSON:
{"action":"continue"|"stop"|"risk_review","reason":"<short>","prompt":"<string>"}

Rules:
- action=stop when the assistant already clearly said there is nothing left to do.
- action=continue when the assistant offered concrete next work, options to continue, or implied it should keep going now.
- action=risk_review when there is no clear next action and no explicit stop signal.
- For action=continue, write a direct prompt telling the main agent to execute the next concrete work now.
- For action=risk_review, set prompt exactly to: 남은 리스크 해결 및 테스트 및 검토 하라
- For action=stop, set prompt to an empty string.
- Treat Korean and English naturally.
`;

function semverCompare(a, b) {
  const pa = a.replace(/^v/, '').split('.').map((part) => parseInt(part, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function resolveClaudeBinary() {
  const versionsDir = join(homedir(), '.local', 'share', 'claude', 'versions');
  let versions = [];
  try {
    versions = readdirSync(versionsDir).sort(semverCompare).reverse();
  } catch {
    return '';
  }
  for (const v of versions) {
    const p = join(versionsDir, v);
    try {
      const s = statSync(p);
      if (s.size > 0 && (s.mode & 0o111)) return p;
    } catch {}
  }
  return '';
}

const CLAUDE_BINARY = resolveClaudeBinary();

function extractInnerJson(text) {
  // Strip markdown code fences if present
  const stripped = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // Try direct parse first
  try { return JSON.parse(stripped); } catch {}
  // Try each line (last valid JSON wins)
  const lines = stripped.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('no json object in text: ' + stripped.slice(0, 120));
}

function normalizeClaudeJson(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) throw new Error('empty output');
  // Claude CLI --output-format json wraps output in an envelope: { result: "...", ... }
  // Try parsing the outer envelope first, then extract the inner result field
  let outer;
  try { outer = JSON.parse(trimmed); } catch {}
  if (outer && typeof outer.result === 'string') {
    return extractInnerJson(outer.result);
  }
  // Fallback: try direct parse of the whole string
  return extractInnerJson(trimmed);
}

function invokeClaude(prompt) {
  const overrideModule = process.env.SMELTER_AUTO_CONFIRM_CLASSIFIER_MODULE;
  if (overrideModule) {
    return execFileSync(process.execPath, ['-e', `
      const mod = await import(process.env.SMELTER_AUTO_CONFIRM_CLASSIFIER_MODULE);
      const result = mod.classifyAutoConfirm(JSON.parse(process.env.SMELTER_AUTO_CONFIRM_MESSAGES || '[]'));
      process.stdout.write(JSON.stringify({ result: JSON.stringify(result) }));
    `], {
      timeout: TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
      },
    });
  }
  return execFileSync(CLAUDE_BINARY, ['-p', '--model', selectClassifierModel(), '--output-format', 'json', prompt], {
    timeout: TIMEOUT_MS,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // Tell inherited Smelter hooks (keyword-detector, etc.) that this Claude
      // invocation is a classifier subprocess — they must bail out before
      // side-effecting on the classifier's system prompt. See
      // scripts/keyword-detector.mjs re-entrancy guard.
      SMELTER_CLASSIFIER_SUBPROCESS: '1',
    },
  });
}

function readSessionCache(stateDir, sessionId, cacheFile) {
  const path = join(stateDir, cacheFile);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (data._session !== sessionId) return {};
    return data;
  } catch { return {}; }
}

function writeSessionCache(stateDir, sessionId, cacheFile, cache) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, cacheFile), JSON.stringify({ ...cache, _session: sessionId }));
}

const CLASSIFICATION_PROMPT = `You are a command classifier for a CLI tool called "smelter". Classify the user's prompt as either a command or a question/explanation request.

Commands available: plan (deep planning), build (full dev workflow), fix (bug fix / simple edit), cancel, queue.

Rules:
- If the user is ASKING about a command (e.g. "how does plan work?", "explain build") → question
- If the user WANTS TO EXECUTE something → command
- If the user describes a problem to SOLVE, FIX, BUILD, or IMPLEMENT → command (not question)
- If ambiguous but the prompt describes broken behavior, errors, or work to do → default to command

Strong fix signals (any of these → command:fix):
  EN: fix, correct, correction, patch, resolve, direct correction, bug, error, crash, broken, failing, deploy fail, build fail, ELIFECYCLE, exit code, hotfix, regression, not working
  KO: 버그, 고쳐, 터지, 에러, 수정, 해결해, 안됨, 안돼, 깨짐, 실패, 오류, 장애, 배포실패
  ZH: 修复, 错误, 崩溃, 失败, 坏了, 报错, 部署失败, 不工作
  JA: バグ, 修正, エラー, クラッシュ, 壊れた, 失敗, 動かない, デプロイ失敗
  ES: arreglar, error, fallo, roto, despliegue fallido, no funciona, corregir
  DE: Fehler, kaputt, reparieren, Absturz, fehlgeschlagen, funktioniert nicht, beheben

If a prompt contains explicit repair wording such as "fix" or a direct correction request, route to command:fix immediately, even when the prompt also contains investigative words.

Strong plan signals (any of these → command:plan):
  EN: plan, design, scope, architect, spec, requirements, breakdown, estimate, check, investigate, inspect, diagnose, verify, look into, triage, debug, root cause
  KO: 설계, 계획, 기획, 스펙, 요구사항, 분석, 조사, 확인해, 살펴봐, 진단
  ZH: 计划, 设计, 需求, 规划, 架构, 调查, 检查, 诊断
  JA: 計画, 設計, 要件, スコープ, 見積もり, 調査, 確認, 診断
  ES: planificar, diseñar, requisitos, alcance, arquitectura, investigar, revisar, diagnosticar
  DE: planen, entwerfen, Anforderungen, Umfang, Architektur, untersuchen, prüfen, diagnostizieren

If a prompt is primarily investigative or diagnostic (for example "check", "investigate", or "look into") and does not contain explicit repair wording, route to command:plan.

If a prompt contains both investigative wording and explicit repair wording (for example "check and fix"), explicit repair wording wins and the result must be command:fix.

Strong build signals (any of these → command:build):
  EN: add, create, build, implement, new feature, develop, integrate, migrate, refactor
  KO: 추가, 만들어, 새 기능, 구현, 개발, 리팩토링, 마이그레이션
  ZH: 添加, 创建, 新功能, 实现, 开发, 重构
  JA: 追加, 作成, 新機能, 実装, 開発, リファクタ
  ES: agregar, crear, nueva funcionalidad, implementar, desarrollar
  DE: hinzufügen, erstellen, neue Funktion, implementieren, entwickeln

Branch hints for commands:
- build + "extend/add to/덧붙여/확장" → branch: "extend"
- build + "new feature/새 기능" → branch: "new-feature"
- fix + "fix/bug/버그/고쳐/터지/에러" → branch: "bug"
- fix + "style/typo/i18n/텍스트/색상" → branch: "style"

Return ONLY valid JSON (no markdown, no explanation):
{"intent":"command"|"question","command":"<name>","branch":"<hint-or-empty>","reason":"<short>"}`;

function promptHash(prompt) {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

function readCache(stateDir, sessionId) {
  return readSessionCache(stateDir, sessionId, CACHE_FILE);
}

function writeCache(stateDir, sessionId, cache) {
  writeSessionCache(stateDir, sessionId, CACHE_FILE, cache);
}

let claudeAvailable = null;
function isClaudeAvailable() {
  if (claudeAvailable !== null) return claudeAvailable;
  try {
    execFileSync(CLAUDE_BINARY, ['--version'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 });
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
  if (!isClaudeAvailable()) {
    throw new Error('Claude binary is unavailable for prompt classification');
  }

  const fullPrompt = `${CLASSIFICATION_PROMPT}\n\nUser prompt: "${prompt}"`;
  const parsed = normalizeClaudeJson(invokeClaude(fullPrompt));
  if (parsed.intent !== 'command' && parsed.intent !== 'question') {
    throw new Error(`Invalid classifier response: ${JSON.stringify(parsed)}`);
  }

  const result = {
    intent: parsed.intent,
    command: parsed.command || '',
    branch: parsed.branch || '',
    reason: parsed.reason || '',
  };

  cache[hash] = result;
  try { writeCache(stateDir, sessionId, cache); } catch {}
  return result;
}

export function classifyAutoConfirm(messages, { cwd = process.cwd(), sessionId = '' } = {}) {
  const stateDir = join(cwd, '.smt', 'state');
  const normalizedMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const hash = promptHash(JSON.stringify(normalizedMessages));
  const cache = readSessionCache(stateDir, sessionId, AUTO_CONFIRM_CACHE_FILE);

  if (cache[hash]) return cache[hash];
  if (!process.env.SMELTER_AUTO_CONFIRM_CLASSIFIER_MODULE && !isClaudeAvailable()) {
    throw new Error('Claude binary is unavailable for auto-confirm classification');
  }

  const fullPrompt = `${AUTO_CONFIRM_PROMPT}\n\nAssistant messages:\n${JSON.stringify(normalizedMessages, null, 2)}`;
  const parsed = normalizeClaudeJson(invokeClaude(fullPrompt));
  if (!['continue', 'stop', 'risk_review'].includes(parsed.action)) {
    throw new Error(`Invalid auto-confirm response: ${JSON.stringify(parsed)}`);
  }

  const result = {
    action: parsed.action,
    reason: parsed.reason || '',
    prompt: parsed.prompt || '',
  };

  cache[hash] = result;
  try { writeSessionCache(stateDir, sessionId, AUTO_CONFIRM_CACHE_FILE, cache); } catch {}
  return result;
}
