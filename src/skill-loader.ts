import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

function getHarnessRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

export function listSkills(): string[] {
  const skillsDir = join(getHarnessRoot(), 'skills');
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function loadSkill(name: string): string | null {
  const path = join(getHarnessRoot(), 'skills', name, 'SKILL.md');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

export function getSkillPrompt(name: string): string | null {
  const content = loadSkill(name);
  if (!content) return null;
  return `[ARCHON SKILL: ${name}]\n\n${content}`;
}
