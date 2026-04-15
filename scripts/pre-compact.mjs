#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { printTag } from './lib/yellow-tag.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const preCompactPath = join(__dirname, '..', 'dist', 'hooks', 'pre-compact', 'index.js');

async function main() {
  printTag('Pre-Compact');
  // Read stdin synchronously
  let input = '{}';
  try { input = readFileSync('/dev/stdin', 'utf-8'); } catch {}

  if (process.env.DISABLE_COMPACT === '1' || process.env.DISABLE_COMPACT === 'true') {
    console.log(JSON.stringify({ decision: 'block' }));
    return;
  }

  try {
    const data = JSON.parse(input);
    if (!existsSync(preCompactPath)) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    const { processPreCompact } = await import(pathToFileURL(preCompactPath).href);
    const result = await processPreCompact(data);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[pre-compact] Error:', error.message);
    process.exit(0); // Don't block on errors
  }
}

main();
