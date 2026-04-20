import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import type { Widget } from './base.js';
import type { WidgetContext } from '../types.js';
import { colorize, getTheme } from '../utils/colors.js';

interface WorkflowStatusData {
  text: string;
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let fileCache: {
  key: string;
  data: WorkflowStatusData | null;
} | null = null;

function normalizeModeLabel(mode: string): string {
  return `${String(mode).toUpperCase()} MODE`;
}

export const workflowStatusWidget: Widget<WorkflowStatusData> = {
  id: 'workflowStatus' as any,
  name: 'Workflow Status',

  async getData(ctx: WidgetContext): Promise<WorkflowStatusData | null> {
    const cwd = ctx.stdin.workspace?.current_dir;
    const projectDir = ctx.stdin.workspace?.project_dir || cwd;
    if (!projectDir) return null;

    const sessionId = ctx.stdin.session_id || '';
    const pointerPath = sessionId
      ? join(projectDir, '.smt', 'state', `active-feature-${sessionId}.json`)
      : join(projectDir, '.smt', 'state', 'active-feature.json');

    try {
      if (!existsSync(pointerPath)) return null;
      const pointerStat = statSync(pointerPath);
      if (Date.now() - pointerStat.mtimeMs > MAX_AGE_MS) {
        fileCache = { key: `${pointerPath}:${pointerStat.mtimeMs}`, data: null };
        return null;
      }

      const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8')) as { slug?: string };
      if (!pointer.slug) {
        fileCache = { key: `${pointerPath}:${pointerStat.mtimeMs}`, data: null };
        return null;
      }

      const statePath = join(
        cwd ?? projectDir,
        '.smt',
        'features',
        pointer.slug,
        'task',
        `${pointer.slug}.state.json`,
      );
      if (!existsSync(statePath)) {
        fileCache = { key: `${pointerPath}:${pointerStat.mtimeMs}`, data: null };
        return null;
      }
      const stateStat = statSync(statePath);
      const cacheKey = `${pointerPath}:${pointerStat.mtimeMs}:${statePath}:${stateStat.mtimeMs}`;
      if (fileCache?.key === cacheKey) {
        return fileCache.data;
      }

      const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
        mode?: string;
        current_stage?: string | null;
      };
      if (!state.mode) {
        fileCache = { key: cacheKey, data: null };
        return null;
      }

      const segments = [normalizeModeLabel(state.mode), pointer.slug];
      if (state.current_stage) segments.push(state.current_stage);
      const data = { text: segments.join(' · ') };
      fileCache = { key: cacheKey, data };
      return data;
    } catch {
      return null;
    }
  },

  render(data: WorkflowStatusData, _ctx: WidgetContext): string {
    const theme = getTheme();
    return `${colorize('▸', theme.info)} ${colorize(data.text, theme.secondary)}`;
  },
};
