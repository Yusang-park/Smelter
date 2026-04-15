import { spawn } from 'child_process';
import type { StreamChunk, UsageInfo } from '../types.js';

// =============================================================================
// Claude CLI adapter — pure Node.js version using child_process.spawn
// =============================================================================

/**
 * Stream Claude CLI output as typed StreamChunk values.
 * Spawns `claude` with `--output-format stream-json` and parses JSONL.
 */
export async function* streamClaude(
  prompt: string,
  cwd: string,
  model?: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', '3',
  ];
  if (model) {
    args.push('--model', model);
  }

  const child = spawn('claude', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  if (signal) {
    if (signal.aborted) {
      child.kill();
      yield { type: 'done' };
      return;
    }
    signal.addEventListener('abort', () => { child.kill(); }, { once: true });
  }

  const state: StreamState = { fullText: '', toolNames: new Map() };

  const chunks: StreamChunk[] = [];
  let done = false;
  let resolveWait: (() => void) | null = null;

  let buffer = '';
  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const parsed = tryParseJsonl(line);
      if (!parsed) {
        if (line.trim()) {
          chunks.push({ type: 'text', content: line });
          resolveWait?.();
        }
        continue;
      }
      const emitted = parseJsonlMessage(parsed, state);
      for (const chunk of emitted) {
        chunks.push(chunk);
      }
      if (emitted.length > 0) resolveWait?.();
    }
  });

  child.stderr.on('data', (data: Buffer) => {
    const text = data.toString();
    if (text.toLowerCase().includes('error')) {
      chunks.push({ type: 'error', content: text });
      resolveWait?.();
    }
  });

  child.on('close', () => {
    done = true;
    resolveWait?.();
  });

  child.on('error', (err: Error) => {
    chunks.push({ type: 'error', content: err.message });
    done = true;
    resolveWait?.();
  });

  while (!done || chunks.length > 0) {
    if (chunks.length > 0) {
      yield chunks.shift()!;
    } else if (!done) {
      await new Promise<void>((r) => { resolveWait = r; });
    }
  }

  yield { type: 'done' };
}

/**
 * Run Claude CLI and collect the full text output (non-streaming).
 */
export async function runClaude(
  prompt: string,
  cwd: string,
  model?: string,
  signal?: AbortSignal,
): Promise<string> {
  let output = '';
  for await (const chunk of streamClaude(prompt, cwd, model, signal)) {
    if (chunk.type === 'text') {
      output += chunk.content;
    }
    if (chunk.type === 'error') {
      throw new Error(chunk.content);
    }
  }
  return output;
}

// =============================================================================
// JSONL Parser
// =============================================================================

interface StreamState {
  fullText: string;
  toolNames: Map<string, string>;
}

interface RawContentBlock {
  type: string;
  text: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
}

interface ParsedJsonl {
  type: string;
  message?: { content?: RawContentBlock[]; usage?: unknown };
  delta?: unknown;
  result?: unknown;
  content?: unknown;
  tool_use_id?: string;
  id?: string;
  is_error?: boolean;
  isError?: boolean;
  usage?: unknown;
  [key: string]: unknown;
}

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5.4': 1_000_000,
};

function tryParseJsonl(line: string): ParsedJsonl | null {
  try { return JSON.parse(line) as ParsedJsonl; }
  catch { return null; }
}

function parseJsonlMessage(parsed: ParsedJsonl, state: StreamState): StreamChunk[] {
  const out: StreamChunk[] = [];

  // --- assistant message (contains content blocks) ---
  if (parsed.type === 'assistant' && parsed.message?.content) {
    const blocks = parsed.message.content as RawContentBlock[];
    for (const block of blocks) {
      if (block.type === 'thinking' && block.thinking) {
        out.push({ type: 'thinking', content: block.thinking });
      } else if (block.type === 'text') {
        const newText = block.text.slice(state.fullText.length);
        if (newText) {
          state.fullText = block.text;
          out.push({ type: 'text', content: newText });
        }
      } else if (block.type === 'tool_use') {
        const toolName = block.name ?? 'unknown';
        const toolId = block.id ?? crypto.randomUUID();
        const toolInput = (block.input as Record<string, unknown>) ?? {};
        state.toolNames.set(toolId, toolName);
        out.push({
          type: 'tool_use',
          id: toolId,
          name: toolName,
          input: toolInput,
        });
      }
    }
  }

  // --- content_block_delta (streaming deltas) ---
  if (parsed.type === 'content_block_delta') {
    const delta = parsed.delta as { type?: string; text?: string; thinking?: string } | undefined;
    if (delta?.type === 'thinking_delta' && delta.thinking) {
      out.push({ type: 'thinking', content: delta.thinking });
    } else if (delta?.type === 'text_delta' && delta.text) {
      out.push({ type: 'text', content: delta.text });
    }
  }

  // --- tool_result ---
  if (parsed.type === 'tool_result' || (parsed.tool_use_id && parsed.type !== 'assistant')) {
    const toolId = (parsed.tool_use_id ?? parsed.id ?? '') as string;
    const resultContent = extractToolResultContent(parsed);
    const isError = parsed.is_error === true || parsed.isError === true;

    if (toolId) {
      out.push({
        type: 'tool_result',
        id: toolId,
        content: resultContent,
        isError,
      });
    }
  }

  // --- result (final from CLI, may contain usage) ---
  if (parsed.type === 'result') {
    const result = parsed.result as string | undefined;
    if (result && result !== state.fullText) {
      const remaining = result.slice(state.fullText.length);
      if (remaining) {
        out.push({ type: 'text', content: remaining });
      }
    }
    const usage = extractUsage(parsed);
    if (usage) {
      out.push({ type: 'usage', usage });
    }
  }

  // --- standalone usage message ---
  if (parsed.type === 'usage') {
    const usage = extractUsage(parsed);
    if (usage) {
      out.push({ type: 'usage', usage });
    }
  }

  return out;
}

// =============================================================================
// Extraction helpers
// =============================================================================

function extractToolResultContent(parsed: ParsedJsonl): string {
  if (typeof parsed.content === 'string') return parsed.content;
  if (typeof parsed.result === 'string') return parsed.result;
  if (Array.isArray(parsed.content)) {
    return (parsed.content as Array<{ text?: string }>)
      .map((b) => b.text ?? '')
      .join('');
  }
  return '';
}

function resolveContextWindow(raw: Record<string, unknown>): number {
  const explicit = Number(raw.context_window ?? raw.contextWindow ?? 0);
  if (explicit > 0) return explicit;

  const model = String(raw.model ?? '');
  if (model && MODEL_CONTEXT_WINDOWS[model]) {
    return MODEL_CONTEXT_WINDOWS[model];
  }

  return 200000;
}

function extractUsage(parsed: ParsedJsonl): UsageInfo | null {
  const raw =
    (parsed.usage as Record<string, unknown> | undefined) ??
    (parsed.message?.usage as Record<string, unknown> | undefined) ??
    ((parsed.result as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined);

  if (!raw) return null;

  const inputTokens = Number(raw.input_tokens ?? raw.inputTokens ?? 0);
  const cacheCreation = Number(raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens ?? 0);
  const cacheRead = Number(raw.cache_read_input_tokens ?? raw.cacheReadInputTokens ?? 0);
  const contextWindow = resolveContextWindow(raw);
  const contextTokens = inputTokens + cacheCreation + cacheRead;
  const percentage = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

  return {
    model: (raw.model as string) ?? undefined,
    inputTokens,
    cacheCreationInputTokens: cacheCreation || undefined,
    cacheReadInputTokens: cacheRead || undefined,
    contextWindow,
    contextTokens,
    percentage,
  };
}

export function parseUsageForTest(parsed: ParsedJsonl): UsageInfo | null {
  return extractUsage(parsed);
}
