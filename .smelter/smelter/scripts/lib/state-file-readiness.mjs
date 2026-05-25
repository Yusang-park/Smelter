import { readFileSync } from 'node:fs';

export function isReadableStateFile(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8'));
    return state && typeof state === 'object';
  } catch {
    return false;
  }
}
