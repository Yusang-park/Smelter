import type {
  HarnessRunOptions,
  HarnessRunResult,
  PlaywrightRunResult,
} from './types.js';
import type { Task } from './store.js';
import { runClaude } from './adapters/claude.js';
import { runPlaywright } from './runners/playwright.js';
import { createTask, updateTask } from './store.js';
import { saveArtifacts } from './artifacts.js';
import { autoDetectAndSave } from './project-memory.js';
import type { ProjectMemory } from './project-memory.js';

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
 * E2E retry loop is handled by the Stop hook (exit 2 → Claude re-prompts).
 * This function simply calls Claude with the raw user prompt.
 */
export async function runWithHarness(
  prompt: string,
  cwd: string,
  options: HarnessRunOptions,
): Promise<HarnessRunResult> {
  // Context injected via SessionStart hook — pass raw prompt directly
  const output = await runClaude(prompt, cwd, options.model);
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

  // Step 1: Create task
  const task = createTask(cwd, prompt.slice(0, 60));
  console.log(`[harness] Task created: ${task.id} — "${task.title}"`);

  // Step 2: Run with harness (TDD + E2E), enriched with project memory
  const enrichedPrompt = memoryContext ? `${memoryContext}\n\n${prompt}` : prompt;
  const result = await runWithHarness(enrichedPrompt, cwd, options);

  // Step 3: Save artifacts if E2E ran
  if (result.e2eResult) {
    const artifacts = saveArtifacts(cwd, task.id, result.e2eResult);
    updateTask(cwd, task.id, {
      videoPath: artifacts.videoPath,
      screenshotPaths: artifacts.screenshotPaths,
      logPath: artifacts.logPath,
      reportPath: artifacts.reportPath,
      e2eResultId: task.id,
    });
    console.log(`[harness] Artifacts saved: ${artifacts.dir}`);
  }

  // Step 4: Move to review
  if (result.status === 'completed' || result.status === 'failed') {
    updateTask(cwd, task.id, {
      column: 'review',
      reviewStatus: 'pending',
    });
    console.log(`[harness] Task ${task.id} → Review (awaiting approval)`);
  }

  return { task, result };
}
