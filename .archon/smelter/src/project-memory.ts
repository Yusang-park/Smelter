import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface ProjectMemory {
  techStack: Record<string, string>;
  build: {
    command?: string;
    testCommand?: string;
    lintCommand?: string;
  };
  conventions: string[];
  structure: Record<string, string>;
  notes: Array<{ category: string; content: string; timestamp: number }>;
  directives: string[];
}

const MEMORY_FILE = '.smt/project-memory.json';

function getMemoryPath(cwd: string): string {
  return join(cwd, MEMORY_FILE);
}

export function loadProjectMemory(cwd: string): ProjectMemory {
  const path = getMemoryPath(cwd);
  if (!existsSync(path)) {
    return { techStack: {}, build: {}, conventions: [], structure: {}, notes: [], directives: [] };
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as ProjectMemory;
}

export function saveProjectMemory(cwd: string, memory: ProjectMemory): void {
  const dir = join(cwd, '.smt');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getMemoryPath(cwd), JSON.stringify(memory, null, 2));
}

export function addNote(cwd: string, category: string, content: string): void {
  const memory = loadProjectMemory(cwd);
  memory.notes.push({ category, content, timestamp: Date.now() });
  saveProjectMemory(cwd, memory);
}

export function addDirective(cwd: string, directive: string): void {
  const memory = loadProjectMemory(cwd);
  if (!memory.directives.includes(directive)) {
    memory.directives.push(directive);
    saveProjectMemory(cwd, memory);
  }
}

export function detectTechStack(cwd: string): Record<string, string> {
  const stack: Record<string, string> = {};
  const checks: Array<[string, string]> = [
    ['package.json', 'node'],
    ['Cargo.toml', 'rust'],
    ['go.mod', 'go'],
    ['pyproject.toml', 'python'],
    ['requirements.txt', 'python'],
    ['tsconfig.json', 'typescript'],
    ['playwright.config.ts', 'playwright'],
    ['vite.config.ts', 'vite'],
    ['.eslintrc.js', 'eslint'],
    ['tailwind.config.ts', 'tailwind'],
  ];
  for (const [file, tech] of checks) {
    if (existsSync(join(cwd, file))) {
      stack[tech] = file;
    }
  }
  return stack;
}

export function autoDetectAndSave(cwd: string): ProjectMemory {
  const memory = loadProjectMemory(cwd);
  memory.techStack = { ...memory.techStack, ...detectTechStack(cwd) };
  saveProjectMemory(cwd, memory);
  return memory;
}
