// =============================================================================
// Harness Types — Pure types with no framework dependencies
// =============================================================================

// --- Harness Mode & Rule Types ---

export type HarnessMode = 'normal' | 'e2e-force' | 'tdd-e2e' | 'autopilot';

export type RuleTrigger = 'on-complete' | 'on-keyword' | 'on-e2e-result' | 'manual';

export interface HarnessRule {
  id: string;
  name: string;
  description: string;
  trigger: RuleTrigger;
  enabled: boolean;
}

// --- E2E Types ---

export type E2EStatus = 'idle' | 'running' | 'passed' | 'failed' | 'error';

export interface E2ETestCase {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
  error?: string;
}

export interface E2EResult {
  id: string;
  projectId: string;
  timestamp: number;
  status: E2EStatus;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  duration: number;
  videoPath: string | null;
  screenshotPaths: string[];
  tests: E2ETestCase[];
  triggerSource: 'manual' | 'auto-hook' | 'auto-retry';
  retryCount: number;
  rawOutput: string;
}

// --- Stream Chunk Types (for Claude CLI JSONL parsing) ---

export type StreamChunk =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }
  | { type: 'error'; content: string }
  | { type: 'done' }
  | { type: 'usage'; usage: UsageInfo };

export interface UsageInfo {
  model?: string;
  inputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  contextWindow: number;
  contextTokens: number;
  percentage: number;
}

// --- Harness Run Options ---

export interface HarnessRunOptions {
  mode: HarnessMode;
  model?: string;
  maxRetries?: number;
  rules?: HarnessRule[];
  skill?: string;
  agent?: string;
  noCaveman?: boolean;
}

// --- Harness Run Result ---

export type HarnessRunStatus = 'completed' | 'failed' | 'error';

export interface HarnessRunResult {
  status: HarnessRunStatus;
  e2eResult?: PlaywrightRunResult;
  retryCount: number;
  output: string;
}

// --- Playwright Runner Result ---

export interface PlaywrightRunResult {
  status: 'passed' | 'failed' | 'error';
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  duration: number;
  tests: E2ETestCase[];
  videoPath: string | null;
  screenshotPaths: string[];
  rawOutput: string;
}
