import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { mkdir, rm, writeFile, lstat, readlink } from 'fs/promises';

const isWindows = process.platform === 'win32';

import {
  isDocker,
  getSmelterHome,
  getSmelterWorkspacesPath,
  ensureSmelterWorkspacesPath,
  getSmelterWorktreesPath,
  getSmelterConfigPath,
  getHomeWorkflowsPath,
  getHomeCommandsPath,
  getHomeScriptsPath,
  getLegacyHomeWorkflowsPath,
  getCommandFolderSearchPaths,
  getWorkflowFolderSearchPaths,
  expandTilde,
  getAppSmelterBasePath,
  getDefaultCommandsPath,
  getDefaultWorkflowsPath,
  logSmelterPaths,
  validateAppDefaultsPaths,
  parseOwnerRepo,
  getProjectRoot,
  getProjectSourcePath,
  getProjectWorktreesPath,
  getProjectArtifactsPath,
  getProjectLogsPath,
  getRunArtifactsPath,
  getRunLogPath,
  resolveProjectRootFromCwd,
  ensureProjectStructure,
  createProjectSourceSymlink,
} from './smelter-paths';

/** All env vars that path functions depend on */
const ENV_VARS = ['WORKSPACE_PATH', 'WORKTREE_BASE', 'SMELTER_HOME', 'SMELTER_DOCKER', 'HOME'];

/**
 * Save and restore environment variables around each test.
 * Call at the top of a describe block to register beforeEach/afterEach hooks.
 */
function useEnvSnapshot(): void {
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_VARS) {
      snapshot[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_VARS) {
      if (snapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key];
      }
    }
  });
}

describe('smelter-paths', () => {
  useEnvSnapshot();

  describe('expandTilde', () => {
    test('expands ~ to home directory', () => {
      expect(expandTilde('~/test')).toBe(join(homedir(), 'test'));
    });

    test('returns path unchanged if no tilde', () => {
      expect(expandTilde('/absolute/path')).toBe('/absolute/path');
    });
  });

  describe('isDocker', () => {
    test('returns true when WORKSPACE_PATH is /workspace', () => {
      process.env.WORKSPACE_PATH = '/workspace';
      expect(isDocker()).toBe(true);
    });

    test('returns true when HOME=/root and WORKSPACE_PATH set', () => {
      process.env.HOME = '/root';
      process.env.WORKSPACE_PATH = '/app/workspace';
      expect(isDocker()).toBe(true);
    });

    test('returns true when SMELTER_DOCKER=true', () => {
      delete process.env.WORKSPACE_PATH;
      process.env.SMELTER_DOCKER = 'true';
      expect(isDocker()).toBe(true);
    });

    test('returns false for local development', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_DOCKER;
      process.env.HOME = homedir();
      expect(isDocker()).toBe(false);
    });
  });

  describe('getSmelterHome', () => {
    test('returns /.smelter in Docker', () => {
      process.env.WORKSPACE_PATH = '/workspace';
      expect(getSmelterHome()).toBe('/.smelter');
    });

    test('returns SMELTER_HOME when set (local)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_DOCKER;
      process.env.SMELTER_HOME = '/custom/smelter';
      expect(getSmelterHome()).toBe('/custom/smelter');
    });

    test('expands tilde in SMELTER_HOME', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_DOCKER;
      process.env.SMELTER_HOME = '~/my-smelter';
      expect(getSmelterHome()).toBe(join(homedir(), 'my-smelter'));
    });

    test('returns ~/.smelter by default (local)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getSmelterHome()).toBe(join(homedir(), '.smelter'));
    });
  });

  describe('getSmelterWorkspacesPath', () => {
    test('returns ~/.smelter/workspaces by default', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getSmelterWorkspacesPath()).toBe(join(homedir(), '.smelter', 'workspaces'));
    });

    test('returns /.smelter/workspaces in Docker', () => {
      process.env.SMELTER_DOCKER = 'true';
      expect(getSmelterWorkspacesPath()).toBe(join('/', '.smelter', 'workspaces'));
    });

    test('uses SMELTER_HOME when set', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_DOCKER;
      process.env.SMELTER_HOME = '/custom/smelter';
      expect(getSmelterWorkspacesPath()).toBe(join('/custom/smelter', 'workspaces'));
    });
  });

  describe('getSmelterWorktreesPath', () => {
    test('returns ~/.smelter/worktrees by default', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.WORKTREE_BASE;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getSmelterWorktreesPath()).toBe(join(homedir(), '.smelter', 'worktrees'));
    });

    test('returns /.smelter/worktrees in Docker', () => {
      process.env.SMELTER_DOCKER = 'true';
      expect(getSmelterWorktreesPath()).toBe(join('/', '.smelter', 'worktrees'));
    });

    test('uses SMELTER_HOME when set', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.WORKTREE_BASE;
      delete process.env.SMELTER_DOCKER;
      process.env.SMELTER_HOME = '/custom/smelter';
      expect(getSmelterWorktreesPath()).toBe(join('/custom/smelter', 'worktrees'));
    });
  });

  describe('getCommandFolderSearchPaths', () => {
    test('returns .smelter/commands and defaults by default', () => {
      const paths = getCommandFolderSearchPaths();
      expect(paths).toEqual(['.smelter/commands', '.smelter/commands/defaults']);
    });

    test('includes configured folder when provided', () => {
      const paths = getCommandFolderSearchPaths('.claude/commands/smelter');
      expect(paths).toEqual([
        '.smelter/commands',
        '.smelter/commands/defaults',
        '.claude/commands/smelter',
      ]);
    });

    test('.smelter/commands has highest priority', () => {
      const paths = getCommandFolderSearchPaths('.custom/commands');
      expect(paths[0]).toBe('.smelter/commands');
    });

    test('.smelter/commands/defaults has second priority', () => {
      const paths = getCommandFolderSearchPaths('.custom/commands');
      expect(paths[1]).toBe('.smelter/commands/defaults');
    });

    test('does not duplicate .smelter/commands if configured', () => {
      const paths = getCommandFolderSearchPaths('.smelter/commands');
      expect(paths).toEqual(['.smelter/commands', '.smelter/commands/defaults']);
    });

    test('does not duplicate .smelter/commands/defaults if configured', () => {
      const paths = getCommandFolderSearchPaths('.smelter/commands/defaults');
      expect(paths).toEqual(['.smelter/commands', '.smelter/commands/defaults']);
    });
  });

  describe('getWorkflowFolderSearchPaths', () => {
    test('returns .smelter/workflows', () => {
      const paths = getWorkflowFolderSearchPaths();
      expect(paths).toEqual(['.smelter/workflows']);
    });
  });

  describe('getSmelterConfigPath', () => {
    test('returns path to config.yaml', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getSmelterConfigPath()).toBe(join(homedir(), '.smelter', 'config.yaml'));
    });
  });

  describe('getHomeWorkflowsPath', () => {
    test('returns ~/.smelter/workflows by default (direct child of ~/.smelter/)', () => {
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getHomeWorkflowsPath()).toBe(join(homedir(), '.smelter', 'workflows'));
    });

    test('returns /.smelter/workflows in Docker', () => {
      process.env.SMELTER_DOCKER = 'true';
      expect(getHomeWorkflowsPath()).toBe(join('/', '.smelter', 'workflows'));
    });

    test('uses SMELTER_HOME when set', () => {
      delete process.env.SMELTER_DOCKER;
      process.env.SMELTER_HOME = '/custom/smelter';
      expect(getHomeWorkflowsPath()).toBe(join('/custom/smelter', 'workflows'));
    });

    test('no double `.smelter/` nesting — must sit next to workspaces/ and worktrees/', () => {
      // Regression guard: the old location was ~/.smelter/.smelter/workflows/.
      // New location must NOT reintroduce the double-nested path.
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getHomeWorkflowsPath()).not.toContain(join('.smelter', '.smelter'));
    });
  });

  describe('getHomeCommandsPath', () => {
    test('returns ~/.smelter/commands by default', () => {
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getHomeCommandsPath()).toBe(join(homedir(), '.smelter', 'commands'));
    });

    test('returns /.smelter/commands in Docker', () => {
      process.env.SMELTER_DOCKER = 'true';
      expect(getHomeCommandsPath()).toBe(join('/', '.smelter', 'commands'));
    });

    test('uses SMELTER_HOME when set', () => {
      delete process.env.SMELTER_DOCKER;
      process.env.SMELTER_HOME = '/custom/smelter';
      expect(getHomeCommandsPath()).toBe(join('/custom/smelter', 'commands'));
    });
  });

  describe('getHomeScriptsPath', () => {
    test('returns ~/.smelter/scripts by default', () => {
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getHomeScriptsPath()).toBe(join(homedir(), '.smelter', 'scripts'));
    });

    test('returns /.smelter/scripts in Docker', () => {
      process.env.SMELTER_DOCKER = 'true';
      expect(getHomeScriptsPath()).toBe(join('/', '.smelter', 'scripts'));
    });

    test('uses SMELTER_HOME when set', () => {
      delete process.env.SMELTER_DOCKER;
      process.env.SMELTER_HOME = '/custom/smelter';
      expect(getHomeScriptsPath()).toBe(join('/custom/smelter', 'scripts'));
    });
  });

  describe('getLegacyHomeWorkflowsPath', () => {
    // This helper only exists so discovery can DETECT files at the old location
    // and emit a deprecation warning. It is not a fallback read path.
    test('returns ~/.smelter/.smelter/workflows (the retired location)', () => {
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getLegacyHomeWorkflowsPath()).toBe(
        join(homedir(), '.smelter', '.smelter', 'workflows')
      );
    });

    test('honors SMELTER_HOME so migration detection works in custom setups', () => {
      delete process.env.SMELTER_DOCKER;
      process.env.SMELTER_HOME = '/custom/smelter';
      expect(getLegacyHomeWorkflowsPath()).toBe(join('/custom/smelter', '.smelter', 'workflows'));
    });
  });

  describe('getAppSmelterBasePath', () => {
    test('returns repo root .smelter path in local development', () => {
      delete process.env.SMELTER_DOCKER;
      delete process.env.WORKSPACE_PATH;
      const path = getAppSmelterBasePath();
      // Should end with .smelter and NOT contain packages/core or packages/paths
      expect(path).toMatch(/\.smelter$/);
      expect(path).not.toContain('packages/core');
      expect(path).not.toContain('packages/paths');
    });

    test('path exists and contains defaults directories', () => {
      delete process.env.SMELTER_DOCKER;
      delete process.env.WORKSPACE_PATH;
      const path = getAppSmelterBasePath();
      // The path should end with .smelter and the directory should exist
      expect(path).toMatch(/\.smelter$/);
      expect(existsSync(path)).toBe(true);
    });
  });

  describe('getDefaultCommandsPath', () => {
    test('returns commands/defaults under app smelter base', () => {
      delete process.env.SMELTER_DOCKER;
      delete process.env.WORKSPACE_PATH;
      const path = getDefaultCommandsPath();
      expect(path).toContain('.smelter');
      expect(path).toContain('commands');
      expect(path).toContain('defaults');
      expect(path).not.toContain('packages/core');
    });
  });

  describe('getDefaultWorkflowsPath', () => {
    test('returns workflows/defaults under app smelter base', () => {
      delete process.env.SMELTER_DOCKER;
      delete process.env.WORKSPACE_PATH;
      const path = getDefaultWorkflowsPath();
      expect(path).toContain('.smelter');
      expect(path).toContain('workflows');
      expect(path).toContain('defaults');
      expect(path).not.toContain('packages/core');
    });
  });

  // =========================================================================
  // Project-centric path functions
  // =========================================================================

  describe('parseOwnerRepo', () => {
    test('parses owner/repo format', () => {
      expect(parseOwnerRepo('acme/widget')).toEqual({ owner: 'acme', repo: 'widget' });
    });

    test('returns null for bare name', () => {
      expect(parseOwnerRepo('widget')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(parseOwnerRepo('')).toBeNull();
    });

    test('returns null for trailing slash', () => {
      expect(parseOwnerRepo('acme/')).toBeNull();
    });

    test('returns null for leading slash', () => {
      expect(parseOwnerRepo('/widget')).toBeNull();
    });

    test('rejects nested paths with more than one slash', () => {
      const result = parseOwnerRepo('acme/nested/widget');
      expect(result).toBeNull();
    });

    test('rejects path traversal in owner', () => {
      expect(parseOwnerRepo('../etc/passwd')).toBeNull();
    });

    test('rejects path traversal in repo', () => {
      expect(parseOwnerRepo('acme/../../etc')).toBeNull();
    });

    test('rejects dot and dotdot segments', () => {
      expect(parseOwnerRepo('./widget')).toBeNull();
      expect(parseOwnerRepo('acme/..')).toBeNull();
      expect(parseOwnerRepo('../widget')).toBeNull();
      expect(parseOwnerRepo('.')).toBeNull();
    });

    test('accepts valid GitHub-style names with dots, hyphens, underscores', () => {
      expect(parseOwnerRepo('my-org/my_repo.js')).toEqual({
        owner: 'my-org',
        repo: 'my_repo.js',
      });
    });

    test('rejects names with spaces', () => {
      expect(parseOwnerRepo('my org/repo')).toBeNull();
    });

    test('rejects names with special characters', () => {
      expect(parseOwnerRepo('acme/repo;rm -rf')).toBeNull();
      expect(parseOwnerRepo('acme/$HOME')).toBeNull();
    });
  });

  describe('getProjectRoot', () => {
    test('returns path under workspaces', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      const result = getProjectRoot('acme', 'widget');
      expect(result).toBe(join(homedir(), '.smelter', 'workspaces', 'acme', 'widget'));
    });

    test('respects SMELTER_HOME', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_DOCKER;
      process.env.SMELTER_HOME = '/custom/smelter';
      expect(getProjectRoot('acme', 'widget')).toBe(
        join('/custom/smelter', 'workspaces', 'acme', 'widget')
      );
    });

    test('works in Docker', () => {
      process.env.SMELTER_DOCKER = 'true';
      expect(getProjectRoot('acme', 'widget')).toBe(
        join('/', '.smelter', 'workspaces', 'acme', 'widget')
      );
    });
  });

  describe('getProjectSourcePath', () => {
    test('appends source/ to project root', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getProjectSourcePath('acme', 'widget')).toBe(
        join(homedir(), '.smelter', 'workspaces', 'acme', 'widget', 'source')
      );
    });
  });

  describe('getProjectWorktreesPath', () => {
    test('appends worktrees/ to project root', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getProjectWorktreesPath('acme', 'widget')).toBe(
        join(homedir(), '.smelter', 'workspaces', 'acme', 'widget', 'worktrees')
      );
    });
  });

  describe('getProjectArtifactsPath', () => {
    test('appends artifacts/ to project root', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getProjectArtifactsPath('acme', 'widget')).toBe(
        join(homedir(), '.smelter', 'workspaces', 'acme', 'widget', 'artifacts')
      );
    });
  });

  describe('getProjectLogsPath', () => {
    test('appends logs/ to project root', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getProjectLogsPath('acme', 'widget')).toBe(
        join(homedir(), '.smelter', 'workspaces', 'acme', 'widget', 'logs')
      );
    });
  });

  describe('getRunArtifactsPath', () => {
    test('returns artifacts/runs/{id}/ path', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getRunArtifactsPath('acme', 'widget', 'run-123')).toBe(
        join(homedir(), '.smelter', 'workspaces', 'acme', 'widget', 'artifacts', 'runs', 'run-123')
      );
    });
  });

  describe('getRunLogPath', () => {
    test('returns logs/{id}.jsonl path', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(getRunLogPath('acme', 'widget', 'run-123')).toBe(
        join(homedir(), '.smelter', 'workspaces', 'acme', 'widget', 'logs', 'run-123.jsonl')
      );
    });
  });

  describe('resolveProjectRootFromCwd', () => {
    test('resolves project root from a path under workspaces', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      const workspacesPath = getSmelterWorkspacesPath();
      const cwd = join(workspacesPath, 'acme', 'widget', 'source');
      expect(resolveProjectRootFromCwd(cwd)).toBe(join(workspacesPath, 'acme', 'widget'));
    });

    test('resolves from worktrees subpath', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      const workspacesPath = getSmelterWorkspacesPath();
      const cwd = join(workspacesPath, 'acme', 'widget', 'worktrees', 'feature-auth');
      expect(resolveProjectRootFromCwd(cwd)).toBe(join(workspacesPath, 'acme', 'widget'));
    });

    test('returns null for path outside workspaces', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      expect(resolveProjectRootFromCwd('/home/user/projects/my-repo')).toBeNull();
    });

    test('returns null for path with only owner (no repo)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_HOME;
      delete process.env.SMELTER_DOCKER;
      const workspacesPath = getSmelterWorkspacesPath();
      expect(resolveProjectRootFromCwd(join(workspacesPath, 'acme'))).toBeNull();
    });

    test('works with SMELTER_HOME override', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.SMELTER_DOCKER;
      process.env.SMELTER_HOME = join('/', 'custom', 'smelter');
      const cwd = join('/', 'custom', 'smelter', 'workspaces', 'acme', 'widget', 'source');
      expect(resolveProjectRootFromCwd(cwd)).toBe(
        join('/', 'custom', 'smelter', 'workspaces', 'acme', 'widget')
      );
    });
  });
});

describe('logSmelterPaths', () => {
  useEnvSnapshot();

  test('does not throw', () => {
    delete process.env.WORKSPACE_PATH;
    delete process.env.SMELTER_HOME;
    delete process.env.SMELTER_DOCKER;
    expect(() => logSmelterPaths()).not.toThrow();
  });
});

describe('validateAppDefaultsPaths', () => {
  test('does not throw for valid paths', async () => {
    await expect(validateAppDefaultsPaths()).resolves.toBeUndefined();
  });

  test('handles missing paths gracefully', async () => {
    const originalEnv = process.env.SMELTER_DOCKER;
    process.env.SMELTER_DOCKER = 'true';
    try {
      // In Docker mode, paths won't exist — should still not throw
      await expect(validateAppDefaultsPaths()).resolves.toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.SMELTER_DOCKER;
      } else {
        process.env.SMELTER_DOCKER = originalEnv;
      }
    }
  });
});

// =========================================================================
// Async filesystem tests (use temp directories for isolation)
// =========================================================================

describe('ensureProjectStructure', () => {
  let tempSmelterHome: string;
  useEnvSnapshot();

  beforeEach(async () => {
    delete process.env.WORKSPACE_PATH;
    delete process.env.SMELTER_DOCKER;
    tempSmelterHome = join(
      tmpdir(),
      `smelter-paths-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.SMELTER_HOME = tempSmelterHome;
  });

  afterEach(async () => {
    await rm(tempSmelterHome, { recursive: true, force: true });
  });

  test('creates all four project subdirectories', async () => {
    await ensureProjectStructure('acme', 'widget');

    const sourcePath = getProjectSourcePath('acme', 'widget');
    const worktreesPath = getProjectWorktreesPath('acme', 'widget');
    const artifactsPath = getProjectArtifactsPath('acme', 'widget');
    const logsPath = getProjectLogsPath('acme', 'widget');

    // All directories should exist
    expect((await lstat(sourcePath)).isDirectory()).toBe(true);
    expect((await lstat(worktreesPath)).isDirectory()).toBe(true);
    expect((await lstat(artifactsPath)).isDirectory()).toBe(true);
    expect((await lstat(logsPath)).isDirectory()).toBe(true);
  });

  test('is idempotent - safe to call twice', async () => {
    await ensureProjectStructure('acme', 'widget');
    await ensureProjectStructure('acme', 'widget');

    const sourcePath = getProjectSourcePath('acme', 'widget');
    expect((await lstat(sourcePath)).isDirectory()).toBe(true);
  });
});

describe('ensureSmelterWorkspacesPath', () => {
  let tempSmelterHome: string;
  useEnvSnapshot();

  beforeEach(async () => {
    delete process.env.WORKSPACE_PATH;
    delete process.env.SMELTER_DOCKER;
    tempSmelterHome = join(
      tmpdir(),
      `smelter-paths-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.SMELTER_HOME = tempSmelterHome;
  });

  afterEach(async () => {
    await rm(tempSmelterHome, { recursive: true, force: true });
  });

  test('creates the workspaces directory when missing', async () => {
    const expected = getSmelterWorkspacesPath();
    expect(existsSync(expected)).toBe(false);

    const returned = await ensureSmelterWorkspacesPath();

    expect(returned).toBe(expected);
    expect((await lstat(expected)).isDirectory()).toBe(true);
  });

  test('is idempotent - safe to call twice', async () => {
    await ensureSmelterWorkspacesPath();
    await ensureSmelterWorkspacesPath();

    const expected = getSmelterWorkspacesPath();
    expect((await lstat(expected)).isDirectory()).toBe(true);
  });
});

describe('createProjectSourceSymlink', () => {
  let tempSmelterHome: string;
  let tempTarget: string;
  useEnvSnapshot();

  beforeEach(async () => {
    delete process.env.WORKSPACE_PATH;
    delete process.env.SMELTER_DOCKER;
    tempSmelterHome = join(
      tmpdir(),
      `smelter-symlink-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.SMELTER_HOME = tempSmelterHome;

    tempTarget = join(
      tmpdir(),
      `smelter-target-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(tempTarget, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempSmelterHome, { recursive: true, force: true });
    await rm(tempTarget, { recursive: true, force: true });
  });

  test.skipIf(isWindows)('creates a symlink pointing to the target', async () => {
    await ensureProjectStructure('acme', 'widget');
    await createProjectSourceSymlink('acme', 'widget', tempTarget);

    const linkPath = getProjectSourcePath('acme', 'widget');
    const stats = await lstat(linkPath);
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await readlink(linkPath)).toBe(tempTarget);
  });

  test.skipIf(isWindows)('is a no-op if symlink already points to same target', async () => {
    await ensureProjectStructure('acme', 'widget');
    await createProjectSourceSymlink('acme', 'widget', tempTarget);
    // Call again - should not throw
    await createProjectSourceSymlink('acme', 'widget', tempTarget);

    const linkPath = getProjectSourcePath('acme', 'widget');
    expect(await readlink(linkPath)).toBe(tempTarget);
  });

  test.skipIf(isWindows)('throws when symlink points to a different target', async () => {
    await ensureProjectStructure('acme', 'widget');
    await createProjectSourceSymlink('acme', 'widget', tempTarget);

    const otherTarget = join(tmpdir(), 'other-target');
    await mkdir(otherTarget, { recursive: true });

    try {
      await expect(createProjectSourceSymlink('acme', 'widget', otherTarget)).rejects.toThrow(
        'already points to'
      );
    } finally {
      await rm(otherTarget, { recursive: true, force: true });
    }
  });

  test.skipIf(isWindows)(
    'is a no-op when real directory with contents exists (clone case)',
    async () => {
      await ensureProjectStructure('acme', 'widget');

      // Put a file in the source dir to simulate a clone
      const sourcePath = getProjectSourcePath('acme', 'widget');
      await writeFile(join(sourcePath, 'README.md'), '# Hello');

      // Should not overwrite the directory with a symlink
      await createProjectSourceSymlink('acme', 'widget', tempTarget);

      const stats = await lstat(sourcePath);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
    }
  );

  test.skipIf(isWindows)(
    'replaces empty directory with symlink (ensureProjectStructure case)',
    async () => {
      await ensureProjectStructure('acme', 'widget');

      // source/ is empty from ensureProjectStructure
      await createProjectSourceSymlink('acme', 'widget', tempTarget);

      const linkPath = getProjectSourcePath('acme', 'widget');
      const stats = await lstat(linkPath);
      expect(stats.isSymbolicLink()).toBe(true);
      expect(await readlink(linkPath)).toBe(tempTarget);
    }
  );

  test.skipIf(isWindows)('creates symlink when source path does not exist', async () => {
    // Only create the parent, not the source dir itself
    const projectRoot = getProjectRoot('acme', 'widget');
    await mkdir(projectRoot, { recursive: true });

    await createProjectSourceSymlink('acme', 'widget', tempTarget);

    const linkPath = getProjectSourcePath('acme', 'widget');
    const stats = await lstat(linkPath);
    expect(stats.isSymbolicLink()).toBe(true);
  });
});
