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
  path: string;
  mtime: number;
  data: WorkflowStatusData | null;
} | null = null;

function normalizeModeLabel(command: string): string {
  return `${String(command).toUpperCase()} MODE`;
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
        fileCache = { path: pointerPath, mtime: pointerStat.mtimeMs, data: null };
        return null;
      }

      if (fileCache?.path === pointerPath && fileCache.mtime === pointerStat.mtimeMs) {
        return fileCache.data;
      }

      const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8')) as { slug?: string };
      if (!pointer.slug) {
        fileCache = { path: pointerPath, mtime: pointerStat.mtimeMs, data: null };
        return null;
      }

      const workflowPath = join(cwd, '.smt', 'features', pointer.slug, 'state', 'workflow.json');
      if (!existsSync(workflowPath)) return null;
      const workflow = JSON.parse(readFileSync(workflowPath, 'utf-8')) as { command?: string; step?: string };
      if (!workflow.command || !workflow.step) {
        fileCache = { path: pointerPath, mtime: pointerStat.mtimeMs, data: null };
        return null;
      }

      const data = {
        text: `${normalizeModeLabel(workflow.command)} · ${pointer.slug} · ${workflow.step}`,
      };
      fileCache = { path: pointerPath, mtime: pointerStat.mtimeMs, data };
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
