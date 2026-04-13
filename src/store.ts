import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export type TaskColumn = 'backlog' | 'in-progress' | 'review' | 'done';

export interface Task {
  id: string;
  title: string;
  description: string;
  column: TaskColumn;
  sessionId: string | null;
  e2eResultId: string | null;
  videoPath: string | null;
  screenshotPaths: string[];
  logPath: string | null;
  reportPath: string | null;
  reviewStatus: 'pending' | 'approved' | 'rejected' | null;
  reviewFeedback: string | null;
  prUrl: string | null;
  labels: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TaskStore {
  tasks: Task[];
}

const ARCHON_DIR = '.archon';
const TASKS_FILE = 'tasks.json';

function getTasksPath(cwd: string): string {
  return join(cwd, ARCHON_DIR, TASKS_FILE);
}

function ensureArchonDir(cwd: string): void {
  const dir = join(cwd, ARCHON_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadTasks(cwd: string): Task[] {
  const path = getTasksPath(cwd);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const store: TaskStore = JSON.parse(raw);
  return store.tasks;
}

export function saveTasks(cwd: string, tasks: Task[]): void {
  ensureArchonDir(cwd);
  const path = getTasksPath(cwd);
  writeFileSync(path, JSON.stringify({ tasks }, null, 2));
}

export function createTask(cwd: string, title: string, description = ''): Task {
  const tasks = loadTasks(cwd);
  const task: Task = {
    id: crypto.randomUUID().slice(0, 8),
    title,
    description,
    column: 'in-progress',
    sessionId: null,
    e2eResultId: null,
    videoPath: null,
    screenshotPaths: [],
    logPath: null,
    reportPath: null,
    reviewStatus: null,
    reviewFeedback: null,
    prUrl: null,
    labels: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  tasks.push(task);
  saveTasks(cwd, tasks);
  return task;
}

export function findTask(cwd: string, id: string): Task | undefined {
  return loadTasks(cwd).find((t) => t.id === id || t.id.startsWith(id));
}

export function updateTask(cwd: string, id: string, update: Partial<Task>): Task | undefined {
  const tasks = loadTasks(cwd);
  const idx = tasks.findIndex((t) => t.id === id || t.id.startsWith(id));
  if (idx === -1) return undefined;
  tasks[idx] = { ...tasks[idx], ...update, updatedAt: Date.now() };
  saveTasks(cwd, tasks);
  return tasks[idx];
}

export function getTasksByColumn(cwd: string, column: TaskColumn): Task[] {
  return loadTasks(cwd).filter((t) => t.column === column);
}
