import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

test('Smelter release notes do not couple Codex companion manifest versions', () => {
  const releaseNotes = readFileSync(join(repoRoot, 'RELEASE_NOTES.md'), 'utf8');

  assert.doesNotMatch(releaseNotes, /Codex companion manifests/i);
  assert.doesNotMatch(releaseNotes, /codex companion manifest/i);
});
