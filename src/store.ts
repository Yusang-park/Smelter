import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import type { Feature as BaseFeature } from './types.js';

export type TaskColumn = 'backlog' | 'in-progress' | 'review' | 'done';

export interface Task {
  id: string;
  title: string;
  done: boolean;
  column: TaskColumn;
  tags: string[];
}

export interface Feature extends BaseFeature {
  tasks: Task[];
}

export interface TaskStore {
  tasks: Task[];
}

const SMT_DIR = '.smt';
const FEATURES_DIR = 'features';

function featuresRoot(cwd: string): string {
  return join(cwd, SMT_DIR, FEATURES_DIR);
}

function featureDir(cwd: string, slug: string): string {
  return join(featuresRoot(cwd), slug);
}

function taskDir(cwd: string, slug: string): string {
  return join(featureDir(cwd, slug), 'task');
}

function planPath(cwd: string, slug: string): string {
  return join(taskDir(cwd, slug), 'plan.md');
}

function taskFilePath(cwd: string, slug: string, taskId: string): string {
  return join(taskDir(cwd, slug), `${taskId}.md`);
}

function decisionsPath(cwd: string, slug: string): string {
  return join(featureDir(cwd, slug), 'decisions.md');
}

function parseCheckboxLine(line: string): Task | null {
  const m = line.match(/^- \[([ xX])\] (?:(\w+):\s*)?(.+)$/);
  if (!m) return null;
  const done = m[1].toLowerCase() === 'x';
  const raw = m[3].trim();
  const tagMatch = raw.match(/\s+(#\S+(?:\s+#\S+)*)$/);
  const tags = tagMatch ? tagMatch[1].split(/\s+/).filter(Boolean) : [];
  const title = tagMatch ? raw.slice(0, raw.length - tagMatch[0].length).trim() : raw;
  const fallbackBase = title.slice(0, 8).replace(/\s+/g, '-').toLowerCase();
  const fallbackHash = Array.from(title).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0).toString(36).slice(-4);
  const id = m[2] || `${fallbackBase}-${fallbackHash}`;
  return { id, title, done, column: done ? 'done' : 'in-progress', tags };
}

function taskToCheckbox(task: Task): string {
  const check = task.done ? 'x' : ' ';
  const tagStr = task.tags.length > 0 ? ' ' + task.tags.join(' ') : '';
  return `- [${check}] ${task.id}: ${task.title}${tagStr}`;
}

export function listFeatures(cwd: string): string[] {
  const root = featuresRoot(cwd);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

function skipFrontMatter(content: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return content;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return content;
  return lines.slice(endIdx + 1).join('\n');
}

export function readFeatureTasks(cwd: string, slug: string): Task[] {
  const dir = taskDir(cwd, slug);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'plan.md')
    .sort();
  const tasks: Task[] = [];
  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf-8');
    const content = skipFrontMatter(raw);
    for (const line of content.split('\n')) {
      const task = parseCheckboxLine(line);
      if (task) tasks.push(task);
    }
  }
  return tasks;
}

function computeFeatureStatus(tasks: Task[]): 'open' | 'in-progress' | 'done' {
  if (tasks.length === 0) return 'open';
  const allDone = tasks.every(t => t.done);
  if (allDone) return 'done';
  const anyDone = tasks.some(t => t.done);
  return anyDone ? 'in-progress' : 'open';
}

export function writeFeatureTasks(cwd: string, slug: string, tasks: Task[]): void {
  const dir = taskDir(cwd, slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const status = computeFeatureStatus(tasks);
  for (const task of tasks) {
    const filePath = taskFilePath(cwd, slug, task.id);
    const frontMatter = `---\nstatus: ${status}\ntype: task\ncreated: ${now}\nupdated: ${now}\n---\n\n`;
    const content = frontMatter + taskToCheckbox(task) + '\n';
    writeFileSync(filePath, content);
  }
}

export function createFeature(cwd: string, slug: string, meta: { title?: string; description?: string } = {}): Feature {
  const dir = taskDir(cwd, slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const plan = planPath(cwd, slug);
  if (!existsSync(plan)) {
    const planContent = `---\nstatus: open\ncreated: ${now}\nupdated: ${now}\n---\n\n# ${meta.title || slug}\n\n${meta.description || ''}\n\n## Plan\n\n## Wiki Links\n\n## Risks\n`;
    writeFileSync(plan, planContent);
  }

  return { slug, status: 'open', created: now, updated: now, tasks: [] };
}

// --- Legacy compatibility wrappers (used by engine.ts and CLI) ---

export function loadTasks(cwd: string): Task[] {
  const slugs = listFeatures(cwd);
  const all: Task[] = [];
  for (const slug of slugs) {
    for (const task of readFeatureTasks(cwd, slug)) {
      all.push({ ...task, id: `${slug}/${task.id}` });
    }
  }
  return all;
}

export function saveTasks(cwd: string, tasks: Task[]): void {
  const bySlug = new Map<string, Task[]>();
  for (const task of tasks) {
    const parts = task.id.split('/');
    const slug = parts.length > 1 ? parts[0] : 'default';
    const localTask = { ...task, id: parts.length > 1 ? parts.slice(1).join('/') : task.id };
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug)!.push(localTask);
  }
  for (const [slug, tasks] of bySlug) {
    writeFeatureTasks(cwd, slug, tasks);
  }
}

export function createTask(cwd: string, title: string, description = ''): Task {
  const slug = title.slice(0, 40).replace(/[^a-zA-Z0-9가-힣]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'task';
  createFeature(cwd, slug, { title, description });
  const id = crypto.randomUUID().slice(0, 8);
  const task: Task = { id, title, done: false, column: 'in-progress', tags: [] };
  const tasks = readFeatureTasks(cwd, slug);
  tasks.push(task);
  writeFeatureTasks(cwd, slug, tasks);
  return { ...task, id: `${slug}/${id}` };
}

export function findTask(cwd: string, id: string): Task | undefined {
  return loadTasks(cwd).find(t => t.id === id || t.id.endsWith(`/${id}`));
}

export function updateTask(cwd: string, id: string, update: Partial<Task>): Task | undefined {
  const parts = id.split('/');
  if (parts.length < 2) {
    const found = findTask(cwd, id);
    if (!found) return undefined;
    return updateTask(cwd, found.id, update);
  }
  const slug = parts[0];
  const localId = parts.slice(1).join('/');
  const tasks = readFeatureTasks(cwd, slug);
  const idx = tasks.findIndex(t => t.id === localId);
  if (idx === -1) return undefined;
  tasks[idx] = { ...tasks[idx], ...update };
  writeFeatureTasks(cwd, slug, tasks);
  return { ...tasks[idx], id };
}

export function getTasksByColumn(cwd: string, column: TaskColumn): Task[] {
  return loadTasks(cwd).filter(t => t.column === column);
}
