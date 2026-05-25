import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realPaths from '@smelter/paths';

// Mock only the logger so test output stays clean. All other @smelter/paths
// exports (findMarkdownFilesRecursive, getHomeCommandsPath, etc.) use real
// implementations — loadCommandPrompt exercises them against a tmp dir set
// via SMELTER_HOME below.
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@smelter/paths', () => ({
  ...realPaths,
  createLogger: mock(() => mockLogger),
}));

import { loadCommandPrompt } from './executor-shared';
import type { WorkflowDeps } from './deps';

// Minimal deps stub — loadCommandPrompt only calls loadConfig.
function makeDeps(loadDefaultCommands = true): WorkflowDeps {
  return {
    loadConfig: async () => ({ defaults: { loadDefaultCommands } }),
  } as unknown as WorkflowDeps;
}

describe('loadCommandPrompt — home-scope resolution', () => {
  let smelterHome: string;
  let repoRoot: string;
  let prevSmelterHome: string | undefined;

  beforeEach(() => {
    prevSmelterHome = process.env.SMELTER_HOME;
    // Separate tmp dirs for home and repo so they don't collide.
    smelterHome = mkdtempSync(join(tmpdir(), 'smelter-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'smelter-repo-'));
    process.env.SMELTER_HOME = smelterHome;
    mkdirSync(join(smelterHome, 'commands'), { recursive: true });
    mkdirSync(join(repoRoot, '.smelter', 'commands'), { recursive: true });
  });

  afterEach(() => {
    if (prevSmelterHome === undefined) delete process.env.SMELTER_HOME;
    else process.env.SMELTER_HOME = prevSmelterHome;
    rmSync(smelterHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('resolves a command from ~/.smelter/commands/ when repo has none', async () => {
    writeFileSync(join(smelterHome, 'commands', 'personal-helper.md'), 'Personal helper body');

    const result = await loadCommandPrompt(makeDeps(false), repoRoot, 'personal-helper');

    expect(result.success).toBe(true);
    if (result.success) expect(result.content).toBe('Personal helper body');
  });

  it('repo command shadows home command with the same name', async () => {
    writeFileSync(join(smelterHome, 'commands', 'shared.md'), 'HOME version');
    writeFileSync(join(repoRoot, '.smelter', 'commands', 'shared.md'), 'REPO version');

    const result = await loadCommandPrompt(makeDeps(false), repoRoot, 'shared');

    expect(result.success).toBe(true);
    if (result.success) expect(result.content).toBe('REPO version');
  });

  it('resolves a home command inside a 1-level subfolder by basename', async () => {
    mkdirSync(join(smelterHome, 'commands', 'triage'), { recursive: true });
    writeFileSync(join(smelterHome, 'commands', 'triage', 'review.md'), 'Review body');

    const result = await loadCommandPrompt(makeDeps(false), repoRoot, 'review');

    expect(result.success).toBe(true);
    if (result.success) expect(result.content).toBe('Review body');
  });

  it('does NOT resolve home commands buried >1 level deep', async () => {
    mkdirSync(join(smelterHome, 'commands', 'a', 'b'), { recursive: true });
    writeFileSync(join(smelterHome, 'commands', 'a', 'b', 'too-deep.md'), 'too deep');

    const result = await loadCommandPrompt(makeDeps(false), repoRoot, 'too-deep');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('not_found');
  });

  it('returns not_found when neither repo nor home has the command (defaults off)', async () => {
    const result = await loadCommandPrompt(makeDeps(false), repoRoot, 'missing');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('not_found');
  });

  it('surfaces empty_file for a zero-byte home command', async () => {
    writeFileSync(join(smelterHome, 'commands', 'blank.md'), '');

    const result = await loadCommandPrompt(makeDeps(false), repoRoot, 'blank');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('empty_file');
  });
});
