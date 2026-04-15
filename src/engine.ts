import type {
  HarnessRunOptions,
  HarnessRunResult,
} from './types.js';
import type { Task } from './store.js';
import { runClaude } from './adapters/claude.js';
import { runCodex, isCodexModel } from './adapters/codex.js';
import { createTask, updateTask } from './store.js';
import { autoDetectAndSave } from './project-memory.js';
import type { ProjectMemory } from './project-memory.js';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HARNESS_ROOT = join(__dirname, '..');

interface PresetConfig {
  name: string;
  description?: string;
  steps: (number | string)[];
  startStep?: number;
  e2e: boolean;
  video: boolean;
  minTests?: number;
}

function loadPreset(preset: string): PresetConfig | null {
  const presetPath = join(HARNESS_ROOT, 'presets', `${preset}.json`);
  if (!existsSync(presetPath)) return null;
  try {
    return JSON.parse(readFileSync(presetPath, 'utf-8')) as PresetConfig;
  } catch {
    return null;
  }
}

function buildMemoryContext(memory: ProjectMemory): string {
  const parts: string[] = [];
  const techKeys = Object.keys(memory.techStack);
  if (techKeys.length > 0) {
    parts.push(`[Tech Stack] ${techKeys.join(', ')}`);
  }
  if (memory.build.command) {
    parts.push(`[Build] ${memory.build.command}`);
  }
  if (memory.build.testCommand) {
    parts.push(`[Test] ${memory.build.testCommand}`);
  }
  if (memory.conventions.length > 0) {
    parts.push(`[Conventions] ${memory.conventions.join('; ')}`);
  }
  if (memory.directives.length > 0) {
    parts.push(`[Directives] ${memory.directives.join('; ')}`);
  }
  return parts.length > 0 ? `[PROJECT CONTEXT]\n${parts.join('\n')}` : '';
}

/**
 * Run a prompt through the harness engine.
 *
 * Context injection (TDD + caveman) is handled by the SessionStart hook.
 * E2E interface (UI/CLI/API/Query/Hook) is surface-based, enforced by
 * Stop hook chain (stop-e2e.mjs). runWithHarness stops at model call.
 */
export async function runWithHarness(
  prompt: string,
  cwd: string,
  options: HarnessRunOptions,
): Promise<HarnessRunResult> {
  // Route to Codex (OpenAI) when model is a GPT/o-series/Codex model
  const output = isCodexModel(options.model)
    ? await runCodex(prompt, cwd, options.model)
    : await runClaude(prompt, cwd, options.model);
  return { status: 'completed', retryCount: 0, output };
}

/**
 * Run a prompt through the harness with full task lifecycle:
 * 1. Creates a task card
 * 2. Runs Claude with TDD prompt
 * 3. Runs E2E with artifact saving
 * 4. Moves task to review on completion
 */
export async function runWithTask(
  prompt: string,
  cwd: string,
  options: HarnessRunOptions,
): Promise<{ task: Task; result: HarnessRunResult }> {
  // Step 0: Auto-detect project memory
  const memory = autoDetectAndSave(cwd);
  const memoryContext = buildMemoryContext(memory);

  // Load preset config
  const presetConfig = loadPreset(options.preset);
  if (presetConfig) {
    const stepList = presetConfig.steps.join(' → ');
    const e2eLabel = presetConfig.e2e ? '+E2E' : 'no-E2E';
    console.log(`[harness] Preset: ${presetConfig.name} [${stepList}] ${e2eLabel}`);
  } else {
    console.log(`[harness] Preset: ${options.preset} (config not found, using defaults)`);
  }

  // Build preset context for Claude — tells it which steps to perform
  const presetContext = presetConfig
    ? [
        `[WORKFLOW PRESET: ${presetConfig.name}]`,
        `Steps: ${presetConfig.steps.join(' → ')}`,
        presetConfig.startStep ? `Start from step: ${presetConfig.startStep}` : '',
        `E2E: ${presetConfig.e2e ? 'required (Playwright + API)' : 'skip'}`,
        `Video: ${presetConfig.video ? 'required' : 'skip'}`,
        `Min tests: ${presetConfig.minTests ?? 10}`,
        `Spec: ${HARNESS_ROOT}/doc/spec.md`,
      ].filter(Boolean).join('\n')
    : '';

  // Step 1: Create task
  const task = createTask(cwd, prompt.slice(0, 60));
  console.log(`[harness] Task created: ${task.id} — "${task.title}"`);

  // Step 2: Run with harness (TDD + E2E), enriched with project memory + preset
  const contextParts = [memoryContext, presetContext].filter(Boolean);
  const enrichedPrompt = contextParts.length > 0
    ? `${contextParts.join('\n\n')}\n\n${prompt}`
    : prompt;
  const result = await runWithHarness(enrichedPrompt, cwd, options);

  // Step 3: Move to review (E2E artifacts are saved by stop-e2e.mjs hook)
  if (result.status === 'completed' || result.status === 'failed') {
    updateTask(cwd, task.id, { column: 'review' });
    console.log(`[harness] Task ${task.id} → Review (awaiting approval)`);
  }

  return { task, result };
}
