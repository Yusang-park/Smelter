#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function allHookCommands(hooks) {
  return Object.values(hooks ?? {})
    .flatMap((entries) => entries ?? [])
    .flatMap((entry) => entry.hooks ?? [])
    .map((hook) => hook.command ?? '');
}

test('Smelter-first hook registration omits Smelter workflow blocking hooks', () => {
  const repoHooks = readJson(join(ROOT, 'hooks', 'hooks.json'));
  const activeSettings = readJson(join(ROOT, 'settings.json'));

  for (const commands of [allHookCommands(repoHooks.hooks), allHookCommands(activeSettings.hooks)]) {
    for (const script of [
      'keyword-detector.mjs',
      'auto-confirm-consumer.mjs',
      'pre-tool-enforcer.mjs',
      'pretool-stage-gate.mjs',
      'state-contract-injector.mjs',
      'post-tool-verifier.mjs',
      'tool-retry.mjs',
      'posttool-test-red-recorder.mjs',
      'posttool-terminal-state-gate.mjs',
      'critic-watchdog.mjs',
      'review-evidence-verifier.mjs',
      'finalize-human-check.mjs',
      'skill-stage-transition.mjs',
      'auto-confirm.mjs',
    ]) {
      assert(!commands.some((command) => command.includes(script)), `${script} must not be registered`);
    }
  }
});

test('active settings keep only non-blocking support hooks', () => {
  const activeSettings = readJson(join(ROOT, 'settings.json'));
  const commands = allHookCommands(activeSettings.hooks);

  for (const script of [
    'session-start-smt.mjs',
    'permission-handler.mjs',
    'subagent-tracker.mjs',
    'pre-compact.mjs',
    'session-end.mjs',
  ]) {
    assert(commands.some((command) => command.includes(script)), `${script} must be registered in active settings.json`);
  }
});
