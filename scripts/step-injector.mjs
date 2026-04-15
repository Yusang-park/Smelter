#!/usr/bin/env node
// step-injector.mjs — UserPromptSubmit hook.
//
// Reads the active feature's workflow state and injects the current step
// prompt as additionalContext.
//
// Active feature resolution order:
//   1. `.smt/state/active-feature.json` → { slug }   (explicit pointer)
//   2. Fallback: most-recently-updated .smt/features/*/state/workflow.json

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printTag } from './lib/yellow-tag.mjs';
import { parseYaml } from './lib/yaml-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HARNESS_ROOT = resolve(__dirname, '..');

function readStdinSync() {
  try { return readFileSync('/dev/stdin', 'utf-8'); } catch { return '{}'; }
}

function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

function findActiveFeature(projectDir) {
  const featuresDir = join(projectDir, '.smt', 'features');
  if (!existsSync(featuresDir)) return null;

  // 1. Explicit pointer
  const pointerPath = join(projectDir, '.smt', 'state', 'active-feature.json');
  const pointer = readJsonSafe(pointerPath);
  if (pointer?.slug) {
    const statePath = join(featuresDir, pointer.slug, 'state', 'workflow.json');
    const state = readJsonSafe(statePath);
    if (state) return { slug: pointer.slug, state, statePath };
  }

  // 2. Fallback: most-recent by updated_at
  let latest = null;
  let slugs = [];
  try { slugs = readdirSync(featuresDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  for (const slug of slugs) {
    const statePath = join(featuresDir, slug, 'state', 'workflow.json');
    const state = readJsonSafe(statePath);
    if (!state) continue;
    const ts = state.updated_at || state.created_at || 0;
    if (!latest || ts > latest.ts) latest = { slug, state, statePath, ts };
  }
  return latest;
}

function loadWorkflow(command) {
  const path = join(HARNESS_ROOT, 'workflows', `${command}.yaml`);
  if (!existsSync(path)) return null;
  try { return parseYaml(readFileSync(path, 'utf-8')); }
  catch (err) {
    process.stderr.write(`[step-injector] YAML parse error in ${path}: ${err.message}\n`);
    return null;
  }
}

function loadStepPrompt(promptPath) {
  const abs = join(HARNESS_ROOT, promptPath);
  if (!existsSync(abs)) return null;
  try { return readFileSync(abs, 'utf-8'); } catch { return null; }
}

function createOutput(additionalContext) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
}

function main() {
  try {
    const input = readStdinSync();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const projectDir = data.cwd || data.directory || process.env.CLAUDE_PROJECT_DIR || process.cwd();

    const active = findActiveFeature(projectDir);
    if (!active) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const { slug, state } = active;
    const command = state.command;
    const stepId = state.step;
    const retry = state.retry || 0;

    const workflow = loadWorkflow(command);
    if (!workflow || !workflow.steps || !workflow.steps[stepId]) {
      process.stderr.write(`[step-injector] workflow ${command} missing step ${stepId}\n`);
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const step = workflow.steps[stepId];
    const isGate = step.type === 'gate';

    let ctx;
    if (isGate) {
      ctx = `[Workflow: ${command} | ${stepId}: ${step.name} | Feature: ${slug}]\n\n`
          + `GATE — PAUSE. Present current state to the user and wait for explicit approval.\n`
          + (step.options ? `Options: ${Array.isArray(step.options) ? step.options.join(', ') : step.options}\n` : '')
          + (step.allow_revisit ? `User may request revisit: ${Array.isArray(step.allow_revisit) ? step.allow_revisit.join(', ') : step.allow_revisit}\n` : '');
    } else {
      const body = step.prompt ? loadStepPrompt(step.prompt) : null;
      ctx = `[Workflow: ${command} | ${stepId}: ${step.name} | Feature: ${slug}${retry > 0 ? ` | Retry ${retry}` : ''}]\n\n`
          + (body || `(step prompt file not found: ${step.prompt})`);
    }

    printTag(`Step: ${stepId} (${command})`);
    console.log(JSON.stringify(createOutput(ctx)));
  } catch (err) {
    process.stderr.write(`[step-injector] error: ${err.message}\n`);
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
