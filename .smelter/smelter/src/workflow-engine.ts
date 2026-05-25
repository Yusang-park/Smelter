// =============================================================================
// Workflow Engine — YAML-based DAG execution via Kahn's algorithm
// =============================================================================

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Workflow, WorkflowNode, NodeResult, WorkflowResult } from './workflow-types.js';
import { runClaude } from './adapters/claude.js';

const execFileAsync = promisify(execFile);

// =============================================================================
// Path helpers
// =============================================================================

function getHarnessRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

// =============================================================================
// Minimal YAML parser (no external dependencies)
// =============================================================================

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

function parseScalar(raw: string): YamlValue {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  // Strip surrounding quotes
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface YamlLine {
  indent: number;
  raw: string;
}

function tokenizeYaml(content: string): YamlLine[] {
  const lines: YamlLine[] = [];
  for (const raw of content.split('\n')) {
    // Skip blank lines and comments
    const stripped = raw.replace(/#.*$/, '');
    if (stripped.trim() === '') continue;
    const indent = raw.search(/\S/);
    lines.push({ indent: indent === -1 ? 0 : indent, raw: stripped });
  }
  return lines;
}

function parseYamlBlock(lines: YamlLine[], start: number, baseIndent: number): [YamlValue, number] {
  if (start >= lines.length) return [null, start];

  const firstLine = lines[start].raw.trim();

  // Array item at current level
  if (firstLine.startsWith('- ')) {
    const arr: YamlValue[] = [];
    let i = start;
    while (i < lines.length && lines[i].indent === baseIndent && lines[i].raw.trim().startsWith('- ')) {
      const itemContent = lines[i].raw.trim().slice(2).trim();
      const colonIdx = itemContent.indexOf(':');
      // Array item that is itself a mapping (e.g. "- id: foo")
      if (colonIdx > 0 && !itemContent.startsWith('"') && !itemContent.startsWith("'")) {
        const obj: Record<string, YamlValue> = {};
        // Parse inline key: value
        const key = itemContent.slice(0, colonIdx).trim();
        const valStr = itemContent.slice(colonIdx + 1).trim();
        if (valStr !== '') {
          obj[key] = parseScalar(valStr);
        } else {
          // Value on next indented lines
          const childIndent = i + 1 < lines.length ? lines[i + 1].indent : baseIndent + 2;
          const [childVal, nextI] = parseYamlBlock(lines, i + 1, childIndent);
          obj[key] = childVal;
          i = nextI;
          // Continue parsing sibling keys of this array item at childIndent
          while (i < lines.length && lines[i].indent === childIndent) {
            const [parsedObj, afterI] = parseMapping(lines, i, childIndent);
            Object.assign(obj, parsedObj);
            i = afterI;
          }
          arr.push(obj);
          continue;
        }
        i++;
        // Parse additional keys belonging to this array-item mapping
        const itemIndent = baseIndent + 2;
        while (i < lines.length && lines[i].indent >= itemIndent) {
          const [parsedObj, afterI] = parseMapping(lines, i, itemIndent);
          Object.assign(obj, parsedObj);
          i = afterI;
        }
        arr.push(obj);
      } else {
        // Simple scalar array item
        arr.push(parseScalar(itemContent));
        i++;
      }
    }
    return [arr, i];
  }

  // Mapping
  return parseMapping(lines, start, baseIndent) as [YamlValue, number];
}

function parseMapping(lines: YamlLine[], start: number, baseIndent: number): [Record<string, YamlValue>, number] {
  const obj: Record<string, YamlValue> = {};
  let i = start;

  while (i < lines.length && lines[i].indent === baseIndent) {
    const line = lines[i].raw.trim();
    if (line.startsWith('- ')) break; // Array items handled by caller

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const valStr = line.slice(colonIdx + 1).trim();

    if (valStr === '|' || valStr === '|-') {
      // Multi-line literal block scalar
      i++;
      const blockParts: string[] = [];
      const blockIndent = i < lines.length ? lines[i].indent : baseIndent + 2;
      while (i < lines.length && lines[i].indent >= blockIndent) {
        blockParts.push(lines[i].raw.slice(blockIndent));
        i++;
      }
      obj[key] = blockParts.join('\n');
    } else if (valStr !== '') {
      obj[key] = parseScalar(valStr);
      i++;
    } else {
      // Value is a nested block on the next lines
      i++;
      if (i < lines.length && lines[i].indent > baseIndent) {
        const childIndent = lines[i].indent;
        const [childVal, nextI] = parseYamlBlock(lines, i, childIndent);
        obj[key] = childVal;
        i = nextI;
      } else {
        obj[key] = null;
      }
    }
  }

  return [obj, i];
}

export function parseYaml(content: string): Record<string, unknown> {
  const lines = tokenizeYaml(content);
  if (lines.length === 0) return {};
  const [result] = parseMapping(lines, 0, 0);
  return result as Record<string, unknown>;
}

// =============================================================================
// Workflow loading
// =============================================================================

export function loadWorkflow(name: string, cwd?: string): Workflow {
  const harnessRoot = getHarnessRoot();
  const candidates = [
    join(harnessRoot, 'workflows', `${name}.yaml`),
    join(harnessRoot, 'workflows', `${name}.yml`),
    ...(cwd ? [
      join(cwd, '.smt', 'workflows', `${name}.yaml`),
      join(cwd, '.smt', 'workflows', `${name}.yml`),
    ] : []),
  ];

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`Workflow "${name}" not found. Searched:\n  ${candidates.join('\n  ')}`);
  }

  const raw = readFileSync(found, 'utf-8');
  const parsed = parseYaml(raw);

  const nodes = (parsed.nodes as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    name: (parsed.name as string) ?? name,
    description: (parsed.description as string) ?? undefined,
    nodes: nodes.map((n) => ({
      id: String(n.id ?? ''),
      command: n.command != null ? String(n.command) : undefined,
      prompt: n.prompt != null ? String(n.prompt) : undefined,
      bash: n.bash != null ? String(n.bash) : undefined,
      depends_on: Array.isArray(n.depends_on)
        ? (n.depends_on as unknown[]).map(String)
        : undefined,
      context: n.context === 'fresh' ? 'fresh' as const : undefined,
      model: n.model != null ? String(n.model) : undefined,
      trigger_rule: n.trigger_rule === 'one_success' ? 'one_success' as const : undefined,
      when: n.when != null ? String(n.when) : undefined,
    })),
  };
}

export function listWorkflows(cwd?: string): string[] {
  const names = new Set<string>();
  const dirs = [
    join(getHarnessRoot(), 'workflows'),
    ...(cwd ? [join(cwd, '.smt', 'workflows')] : []),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.yaml') || f.endsWith('.yml')) {
        names.add(f.replace(/\.ya?ml$/, ''));
      }
    }
  }

  return [...names].sort();
}

// =============================================================================
// Command loading
// =============================================================================

export function loadCommand(name: string, cwd: string): string | null {
  // Project override first, then bundled default
  const candidates = [
    join(cwd, '.smt', 'commands', `${name}.md`),
    join(getHarnessRoot(), 'commands', `${name}.md`),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      return readFileSync(p, 'utf-8');
    }
  }
  return null;
}

// =============================================================================
// Topological sort — Kahn's algorithm
// =============================================================================

export function buildTopologicalLayers(nodes: WorkflowNode[]): WorkflowNode[][] {
  const nodeMap = new Map<string, WorkflowNode>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    nodeMap.set(node.id, node);
    inDegree.set(node.id, 0);
    dependents.set(node.id, []);
  }

  for (const node of nodes) {
    const deps = node.depends_on ?? [];
    inDegree.set(node.id, deps.length);
    for (const dep of deps) {
      if (!nodeMap.has(dep)) {
        throw new Error(`Node "${node.id}" depends on unknown node "${dep}"`);
      }
      dependents.get(dep)!.push(node.id);
    }
  }

  const layers: WorkflowNode[][] = [];
  let queue = nodes.filter((n) => inDegree.get(n.id) === 0);
  let processed = 0;

  while (queue.length > 0) {
    layers.push(queue);
    processed += queue.length;

    const nextQueue: WorkflowNode[] = [];
    for (const node of queue) {
      for (const depId of dependents.get(node.id)!) {
        const newDeg = inDegree.get(depId)! - 1;
        inDegree.set(depId, newDeg);
        if (newDeg === 0) {
          nextQueue.push(nodeMap.get(depId)!);
        }
      }
    }
    queue = nextQueue;
  }

  if (processed !== nodes.length) {
    throw new Error('Workflow contains a cycle — cannot determine execution order');
  }

  return layers;
}

// =============================================================================
// Variable substitution
// =============================================================================

function substituteVariables(
  text: string,
  args: string,
  nodeOutputs: Map<string, NodeResult>,
): string {
  let result = text.replace(/\$ARGUMENTS/g, args);
  for (const [id, nr] of nodeOutputs) {
    result = result.replace(new RegExp(`\\$${id}\\.output`, 'g'), nr.output);
    result = result.replace(new RegExp(`\\$${id}\\.exitCode`, 'g'), String(nr.exitCode));
  }
  return result;
}

// =============================================================================
// Condition evaluation
// =============================================================================

function evaluateWhen(expr: string, nodeOutputs: Map<string, NodeResult>): boolean {
  // Substitute node references then do simple comparisons
  let resolved = expr;
  for (const [id, nr] of nodeOutputs) {
    resolved = resolved.replace(new RegExp(`\\$${id}\\.exitCode`, 'g'), String(nr.exitCode));
    resolved = resolved.replace(new RegExp(`\\$${id}\\.status`, 'g'), `"${nr.status}"`);
    resolved = resolved.replace(new RegExp(`\\$${id}\\.output`, 'g'), `"${nr.output}"`);
  }

  // Support "X == Y" and "X != Y" comparisons
  const eqMatch = resolved.match(/^\s*(.+?)\s*==\s*(.+?)\s*$/);
  if (eqMatch) {
    return eqMatch[1].replace(/"/g, '') === eqMatch[2].replace(/"/g, '');
  }
  const neqMatch = resolved.match(/^\s*(.+?)\s*!=\s*(.+?)\s*$/);
  if (neqMatch) {
    return neqMatch[1].replace(/"/g, '') !== neqMatch[2].replace(/"/g, '');
  }

  // Fallback: non-empty, non-"false", non-"0" is truthy
  const val = resolved.trim().replace(/"/g, '');
  return val !== '' && val !== 'false' && val !== '0';
}

// =============================================================================
// Node execution
// =============================================================================

export async function executeNode(
  node: WorkflowNode,
  cwd: string,
  nodeOutputs: Map<string, NodeResult>,
  args: string,
  modelOverride?: string,
): Promise<NodeResult> {
  const start = Date.now();

  // Check trigger_rule
  const deps = node.depends_on ?? [];
  if (deps.length > 0) {
    const depResults = deps.map((d) => nodeOutputs.get(d)).filter(Boolean) as NodeResult[];
    const rule = node.trigger_rule ?? 'all_success';
    if (rule === 'all_success' && depResults.some((r) => r.status !== 'completed')) {
      console.log(`[workflow] Skipping "${node.id}" — not all dependencies succeeded`);
      return { id: node.id, output: '', exitCode: -1, status: 'skipped', duration: Date.now() - start };
    }
    if (rule === 'one_success' && !depResults.some((r) => r.status === 'completed')) {
      console.log(`[workflow] Skipping "${node.id}" — no dependency succeeded`);
      return { id: node.id, output: '', exitCode: -1, status: 'skipped', duration: Date.now() - start };
    }
  }

  // Check when condition
  if (node.when) {
    const conditionMet = evaluateWhen(node.when, nodeOutputs);
    if (!conditionMet) {
      console.log(`[workflow] Skipping "${node.id}" — when condition not met`);
      return { id: node.id, output: '', exitCode: -1, status: 'skipped', duration: Date.now() - start };
    }
  }

  const model = node.model ?? modelOverride;

  try {
    // --- bash node: deterministic shell, no AI ---
    if (node.bash) {
      const script = substituteVariables(node.bash, args, nodeOutputs);
      console.log(`[workflow] Node "${node.id}" (bash)...`);
      const { stdout, stderr } = await execFileAsync('bash', ['-c', script], { cwd });
      const output = (stdout + stderr).trim();
      console.log(`[workflow] Node "${node.id}" completed (${((Date.now() - start) / 1000).toFixed(1)}s)`);
      return { id: node.id, output, exitCode: 0, status: 'completed', duration: Date.now() - start };
    }

    // --- command node: load prompt from .md file ---
    if (node.command) {
      const commandPrompt = loadCommand(node.command, cwd);
      if (!commandPrompt) {
        throw new Error(`Command "${node.command}" not found for node "${node.id}"`);
      }
      const prompt = substituteVariables(commandPrompt, args, nodeOutputs);
      console.log(`[workflow] Node "${node.id}" (command: ${node.command})...`);
      const output = await runClaude(prompt, cwd, model);
      console.log(`[workflow] Node "${node.id}" completed (${((Date.now() - start) / 1000).toFixed(1)}s)`);
      return { id: node.id, output, exitCode: 0, status: 'completed', duration: Date.now() - start };
    }

    // --- prompt node: inline AI prompt ---
    if (node.prompt) {
      const prompt = substituteVariables(node.prompt, args, nodeOutputs);
      console.log(`[workflow] Node "${node.id}" (prompt)...`);
      const output = await runClaude(prompt, cwd, model);
      console.log(`[workflow] Node "${node.id}" completed (${((Date.now() - start) / 1000).toFixed(1)}s)`);
      return { id: node.id, output, exitCode: 0, status: 'completed', duration: Date.now() - start };
    }

    throw new Error(`Node "${node.id}" has no command, prompt, or bash defined`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[workflow] Node "${node.id}" failed: ${message}`);
    return { id: node.id, output: message, exitCode: 1, status: 'failed', duration: Date.now() - start };
  }
}

// =============================================================================
// Main entry point
// =============================================================================

export async function runWorkflow(
  name: string,
  cwd: string,
  args?: string,
  model?: string,
): Promise<WorkflowResult> {
  const start = Date.now();
  const workflow = loadWorkflow(name, cwd);
  const layers = buildTopologicalLayers(workflow.nodes);

  console.log(`[workflow] Running "${workflow.name}" — ${workflow.nodes.length} nodes, ${layers.length} layers`);

  const nodeOutputs = new Map<string, NodeResult>();
  const allResults: NodeResult[] = [];

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    console.log(`[workflow] Layer ${i + 1}/${layers.length}: [${layer.map((n) => n.id).join(', ')}]`);

    const settled = await Promise.allSettled(
      layer.map((node) => executeNode(node, cwd, nodeOutputs, args ?? '', model)),
    );

    for (const result of settled) {
      const nodeResult: NodeResult = result.status === 'fulfilled'
        ? result.value
        : { id: 'unknown', output: String(result.reason), exitCode: 1, status: 'failed', duration: 0 };
      nodeOutputs.set(nodeResult.id, nodeResult);
      allResults.push(nodeResult);
    }
  }

  const hasFailed = allResults.some((r) => r.status === 'failed');
  const duration = Date.now() - start;
  const status = hasFailed ? 'failed' : 'completed';

  console.log(`[workflow] "${workflow.name}" ${status} in ${(duration / 1000).toFixed(1)}s`);

  return { name: workflow.name, nodes: allResults, status, duration };
}
