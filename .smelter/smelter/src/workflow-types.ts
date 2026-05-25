// =============================================================================
// Workflow Types — YAML-based DAG workflow definitions
// =============================================================================

/**
 * A single node in a workflow DAG.
 *
 * Exactly one of `command`, `prompt`, or `bash` must be set:
 * - `command` — loads a prompt from `commands/{name}.md` and runs it via Claude
 * - `prompt`  — inline AI prompt sent directly to Claude
 * - `bash`    — deterministic shell script (no AI involved)
 */
export interface WorkflowNode {
  /** Unique identifier for this node within the workflow. */
  id: string;
  /** References a command file: `commands/{name}.md`. */
  command?: string;
  /** Inline AI prompt text. */
  prompt?: string;
  /** Shell script executed via bash (no AI). */
  bash?: string;
  /** IDs of nodes that must complete before this node runs. */
  depends_on?: string[];
  /** When set to 'fresh', starts a new Claude session (prevents context pollution). */
  context?: 'fresh';
  /** Per-node model override (e.g. 'opus', 'sonnet', 'haiku'). */
  model?: string;
  /** How to evaluate dependency results. Default: 'all_success'. */
  trigger_rule?: 'all_success' | 'one_success';
  /** Conditional expression — node is skipped when this evaluates to false. */
  when?: string;
}

/** A complete workflow definition parsed from YAML. */
export interface Workflow {
  name: string;
  description?: string;
  nodes: WorkflowNode[];
}

/** The result of executing a single workflow node. */
export interface NodeResult {
  id: string;
  output: string;
  exitCode: number;
  status: 'completed' | 'failed' | 'skipped';
  duration: number;
}

/** The aggregate result of a full workflow run. */
export interface WorkflowResult {
  name: string;
  nodes: NodeResult[];
  status: 'completed' | 'failed';
  duration: number;
}
