import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

function getHarnessRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

export interface AgentDef {
  name: string;
  description: string;
  model: string;
  content: string;
}

export function listAgents(): AgentDef[] {
  const agentsDir = join(getHarnessRoot(), 'agents');
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md') && f !== 'AGENTS.md')
    .map((f) => {
      const content = readFileSync(join(agentsDir, f), 'utf-8');
      const meta = parseFrontmatter(content);
      return {
        name: meta.name ?? basename(f, '.md'),
        description: meta.description ?? '',
        model: meta.model ?? 'sonnet',
        content,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadAgent(name: string): AgentDef | null {
  const agentsDir = join(getHarnessRoot(), 'agents');
  const path = join(agentsDir, `${name}.md`);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf-8');
  const meta = parseFrontmatter(content);
  return {
    name: meta.name ?? name,
    description: meta.description ?? '',
    model: meta.model ?? 'sonnet',
    content,
  };
}

export function getAgentPrompt(name: string): string | null {
  const agent = loadAgent(name);
  if (!agent) return null;
  return `[SMELTER AGENT: ${agent.name} (${agent.model})]\n\n${agent.content}`;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      result[key] = val;
    }
  }
  return result;
}
