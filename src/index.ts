// =============================================================================
// @linear-harness/harness — Public API
// =============================================================================

export type {
  HarnessMode,
  RuleTrigger,
  HarnessRule,
  E2EStatus,
  E2ETestCase,
  E2EResult,
  StreamChunk,
  UsageInfo,
  HarnessRunOptions,
  HarnessRunStatus,
  HarnessRunResult,
  PlaywrightRunResult,
} from './types.js';

export { runWithHarness, runWithTask } from './engine.js';
export { streamClaude, runClaude } from './adapters/claude.js';
export { runPlaywright } from './runners/playwright.js';
export { DEFAULT_RULES, HARNESS_CONFIG, TDD_E2E_SYSTEM_PROMPT, CAVEMAN_SYSTEM_PROMPT, E2E_MAX_RETRIES, E2E_CONFIG } from './rules/defaults.js';
export { createTask, loadTasks, findTask, updateTask, getTasksByColumn, saveTasks } from './store.js';
export type { Task, TaskColumn, TaskStore } from './store.js';
export { saveArtifacts } from './artifacts.js';
export type { SavedArtifacts } from './artifacts.js';
export { loadProjectMemory, saveProjectMemory, addNote, addDirective, detectTechStack, autoDetectAndSave } from './project-memory.js';
export type { ProjectMemory } from './project-memory.js';

export { listSkills, loadSkill, getSkillPrompt } from './skill-loader.js';
export { listAgents, loadAgent, getAgentPrompt } from './agent-loader.js';
export type { AgentDef } from './agent-loader.js';
export { downgradeModel, getModelForTier, detectTier } from './ecomode.js';
export type { ModelTier } from './ecomode.js';

export { loadWorkflow, listWorkflows, loadCommand, runWorkflow, buildTopologicalLayers } from './workflow-engine.js';
export type { WorkflowNode, Workflow, NodeResult, WorkflowResult } from './workflow-types.js';
