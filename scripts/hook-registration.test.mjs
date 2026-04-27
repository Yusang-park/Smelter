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

function userPromptCommands(hooks) {
  return (hooks.UserPromptSubmit ?? [])
    .flatMap((entry) => entry.hooks ?? [])
    .map((hook) => hook.command ?? '');
}

test('UserPromptSubmit hooks do not pre-inject learned skills', () => {
  const repoHooks = readJson(join(ROOT, 'hooks', 'hooks.json'));
  const activeSettings = readJson(join(ROOT, 'settings.json'));

  for (const commands of [userPromptCommands(repoHooks.hooks), userPromptCommands(activeSettings.hooks)]) {
    assert(commands.some((command) => command.includes('keyword-detector.mjs')));
    assert(commands.some((command) => command.includes('auto-confirm-consumer.mjs')));
    assert(!commands.some((command) => command.includes(`skill-${'injector'}.mjs`)));
  }
});
