/**
 * Task Summary widget - displays Haiku-summarized current task
 * Data source: ~/.claude/hud/task-summary/{cwdKey}.json
 *
 * The cache is written by a UserPromptSubmit hook (task-summarizer.mjs)
 * that captures user prompts and calls Haiku API to produce a one-line summary.
 * This widget simply reads and displays that cached summary.
 */

import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

import type { Widget } from './base.js';
import type { WidgetContext } from '../types.js';
import { colorize, getTheme } from '../utils/colors.js';
import { truncate } from '../utils/formatters.js';

const CACHE_DIR = join(homedir(), '.claude', 'hud', 'task-summary');
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

interface TaskSummaryData {
  summary: string;
}

function cacheKeyForCwd(cwd: string): string {
  return Buffer.from(cwd || 'default').toString('base64url');
}

/** File-stat cache to avoid re-reading unchanged files */
let fileCache: {
  path: string;
  mtime: number;
  data: TaskSummaryData | null;
} | null = null;

export const taskSummaryWidget: Widget<TaskSummaryData> = {
  id: 'taskSummary' as any,
  name: 'Task Summary',

  async getData(ctx: WidgetContext): Promise<TaskSummaryData | null> {
    const cwd = ctx.stdin.workspace?.current_dir;
    if (!cwd) return null;

    const cwdKey = cacheKeyForCwd(cwd);
    const cachePath = join(CACHE_DIR, `${cwdKey}.json`);

    try {
      const fileStat = await stat(cachePath);

      // Return cached if mtime matches
      if (fileCache?.path === cachePath && fileCache.mtime === fileStat.mtimeMs) {
        return fileCache.data;
      }

      const content = await readFile(cachePath, 'utf-8');
      const cached = JSON.parse(content) as {
        raw_prompt?: string;
        summary?: string | null;
        timestamp?: string;
        session_id?: string | null;
      };

      // Check age
      if (!cached.timestamp) {
        fileCache = { path: cachePath, mtime: fileStat.mtimeMs, data: null };
        return null;
      }
      const age = Date.now() - new Date(cached.timestamp).getTime();
      if (age > MAX_AGE_MS) {
        fileCache = { path: cachePath, mtime: fileStat.mtimeMs, data: null };
        return null;
      }

      // Only show summary from current session
      const sessionId = ctx.stdin.session_id;
      if (sessionId && cached.session_id && cached.session_id !== sessionId) {
        fileCache = { path: cachePath, mtime: fileStat.mtimeMs, data: null };
        return null;
      }

      // Prefer Haiku summary, fall back to truncated raw prompt
      const text = cached.summary
        ?? (cached.raw_prompt ? cached.raw_prompt.trim() : null);

      if (!text) {
        fileCache = { path: cachePath, mtime: fileStat.mtimeMs, data: null };
        return null;
      }

      const data: TaskSummaryData = { summary: text };
      fileCache = { path: cachePath, mtime: fileStat.mtimeMs, data };
      return data;
    } catch {
      return null;
    }
  },

  render(data: TaskSummaryData, _ctx: WidgetContext): string {
    const theme = getTheme();
    return `${colorize('▸', theme.info)} ${colorize(truncate(data.summary, 40), theme.secondary)}`;
  },
};
