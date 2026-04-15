/**
 * Context widget - displays progress bar, percentage, and token count
 * @handbook 3.3-widget-data-sources
 * @tested scripts/__tests__/widgets.test.ts
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { Widget } from './base.js';
import type { WidgetContext, ContextData } from '../types.js';
import { getColorForPercent, colorize, getSeparator } from '../utils/colors.js';
import { formatTokens, calculatePercent } from '../utils/formatters.js';
import { renderProgressBar, DEFAULT_PROGRESS_BAR_CONFIG } from '../utils/progress-bar.js';

let codexContextHintCache: { value: number | null } | null = null;

async function inferContextSize(ctx: WidgetContext): Promise<number> {
  const modelId = String(ctx.stdin.model?.id ?? '');
  const modelLabel = String(ctx.stdin.model?.display_name ?? '');
  const explicitSize = ctx.stdin.context_window?.context_window_size;
  if (
    /^gpt-5\.4(?:$|-)/i.test(modelId) ||
    /gpt-5\.4/i.test(modelLabel)
  ) {
    // Claude Code v2.1.108 reports gpt-5.4 as a 200k custom-model window on stdin even
    // though Codex sessions should be treated as 1M. Override that specific stale value.
    if (explicitSize === 200000 || explicitSize == null) {
      return 1000000;
    }
  }

  if (typeof explicitSize === 'number' && explicitSize > 0) return explicitSize;

  if (/^gpt-5\.4(?:$|-)/i.test(modelId) || /gpt-5\.4/i.test(modelLabel)) {
    return 1000000;
  }

  if (codexContextHintCache) {
    return codexContextHintCache.value ?? 200000;
  }

  try {
    const statePath = join(homedir(), '.omc', 'state', 'model-mode.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8')) as { mode?: string; model?: string };
    if (state.mode === 'codex' && /gpt-5\.4/i.test(String(state.model ?? ''))) {
      codexContextHintCache = { value: 1000000 };
      return 1000000;
    }
  } catch {
    // ignore state hint failures
  }

  codexContextHintCache = { value: null };
  return 200000;
}

export const contextWidget: Widget<ContextData> = {
  id: 'context',
  name: 'Context',

  async getData(ctx: WidgetContext): Promise<ContextData | null> {
    const { context_window } = ctx.stdin;
    const usage = context_window?.current_usage;
    const contextSize = await inferContextSize(ctx);
    const officialPercent = context_window?.used_percentage;

    if (!usage) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextSize,
        percentage: typeof officialPercent === 'number' ? Math.round(officialPercent) : 0,
      };
    }

    const inputTokens =
      usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens;
    const outputTokens = usage.output_tokens;
    const totalTokens = inputTokens + outputTokens;
    const percentage = typeof officialPercent === 'number'
      ? Math.round(officialPercent)
      : calculatePercent(inputTokens, contextSize);

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      contextSize,
      percentage,
    };
  },

  render(data: ContextData, _ctx: WidgetContext): string {
    const parts: string[] = [];

    // Progress bar
    parts.push(renderProgressBar(data.percentage));

    // Percentage with color
    const percentColor = getColorForPercent(data.percentage);
    parts.push(colorize(`${data.percentage}%`, percentColor));

    // Token count
    parts.push(
      `${formatTokens(data.inputTokens)}/${formatTokens(data.contextSize)}`
    );

    return parts.join(getSeparator());
  },
};
