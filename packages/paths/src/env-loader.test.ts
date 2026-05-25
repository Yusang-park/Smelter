import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { loadSmelterEnv } from './env-loader';

/**
 * loadSmelterEnv covers the read side of the three-path env model (#1302):
 *   ~/.smelter/.env         → home scope, override: true
 *   <cwd>/.smelter/.env     → repo scope, override: true (wins over home)
 *
 * Tests drive the home scope via SMELTER_HOME and the repo scope via the `cwd`
 * argument. Both are tmpdirs; no real ~/.smelter/ is touched.
 */

const tmpRoot = join(import.meta.dir, '__env-loader-test-tmp__');
const smelterHomeDir = join(tmpRoot, 'smelter-home');
const repoDir = join(tmpRoot, 'repo');

// Keys we set/clear in tests. Using namespaced names to avoid collisions with
// anything a developer might have in their real shell env.
const TEST_KEYS = ['TEST_EL_HOME_ONLY', 'TEST_EL_REPO_ONLY', 'TEST_EL_OVERLAP', 'TEST_EL_OTHER'];

let originalSmelterHome: string | undefined;
let stderrSpy: ReturnType<typeof spyOn>;
let stderrWrites: string[];
let consoleErrorSpy: ReturnType<typeof spyOn>;
let consoleErrorMessages: string[];

beforeEach(() => {
  mkdirSync(smelterHomeDir, { recursive: true });
  mkdirSync(join(repoDir, '.smelter'), { recursive: true });

  originalSmelterHome = process.env.SMELTER_HOME;
  process.env.SMELTER_HOME = smelterHomeDir;

  for (const k of TEST_KEYS) delete process.env[k];

  stderrWrites = [];
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });

  consoleErrorMessages = [];
  consoleErrorSpy = spyOn(console, 'error').mockImplementation((msg: unknown) => {
    consoleErrorMessages.push(String(msg));
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  rmSync(tmpRoot, { recursive: true, force: true });

  if (originalSmelterHome === undefined) delete process.env.SMELTER_HOME;
  else process.env.SMELTER_HOME = originalSmelterHome;

  for (const k of TEST_KEYS) delete process.env[k];
});

describe('loadSmelterEnv', () => {
  it('loads keys from ~/.smelter/.env and emits a [smelter] loaded line', () => {
    writeFileSync(
      join(smelterHomeDir, '.env'),
      'TEST_EL_HOME_ONLY=from-home\nTEST_EL_OTHER=keep\n'
    );

    loadSmelterEnv(repoDir);

    expect(process.env.TEST_EL_HOME_ONLY).toBe('from-home');
    expect(process.env.TEST_EL_OTHER).toBe('keep');
    // Tilde-shortening of the rendered path is opportunistic (only when the
    // tmpdir lives under `homedir()`). On Windows CI the tmpdir is on a
    // different drive and the path renders absolute, so we match on count and
    // the smelter-home tmpdir segment rather than a literal `~` prefix.
    const line = stderrWrites.find(
      s => s.includes('[smelter] loaded') && !s.includes('repo scope')
    );
    expect(line).toBeDefined();
    expect(line).toContain('loaded 2 keys');
    expect(line).toContain(join('smelter-home', '.env'));
  });

  it('loads keys from <cwd>/.smelter/.env and marks it as repo scope', () => {
    writeFileSync(join(repoDir, '.smelter', '.env'), 'TEST_EL_REPO_ONLY=from-repo\n');

    loadSmelterEnv(repoDir);

    expect(process.env.TEST_EL_REPO_ONLY).toBe('from-repo');
    const line = stderrWrites.find(s => s.includes('repo scope, overrides user scope'));
    expect(line).toBeDefined();
    expect(line).toContain('loaded 1 keys');
    // Path rendering tildes anything under the user's home directory — assert
    // on the suffix (the `.smelter/.env` segment) rather than the full path,
    // because the tmpdir may or may not live under $HOME on CI.
    expect(line).toContain(join('.smelter', '.env'));
  });

  it('repo scope overrides home scope on overlapping keys', () => {
    writeFileSync(join(smelterHomeDir, '.env'), 'TEST_EL_OVERLAP=from-home\n');
    writeFileSync(join(repoDir, '.smelter', '.env'), 'TEST_EL_OVERLAP=from-repo\n');

    loadSmelterEnv(repoDir);

    expect(process.env.TEST_EL_OVERLAP).toBe('from-repo');
  });

  it('emits nothing when neither file exists', () => {
    loadSmelterEnv(repoDir);
    const anyLoaded = stderrWrites.find(s => s.includes('[smelter] loaded'));
    expect(anyLoaded).toBeUndefined();
  });

  it('emits no loaded line when a file exists but is empty', () => {
    writeFileSync(join(smelterHomeDir, '.env'), '');
    writeFileSync(join(repoDir, '.smelter', '.env'), '');

    loadSmelterEnv(repoDir);

    const anyLoaded = stderrWrites.find(s => s.includes('[smelter] loaded'));
    expect(anyLoaded).toBeUndefined();
  });

  it('exits with error when env file has a dotenv-unparseable layout', () => {
    // dotenv.parse is very permissive — lines without `=` are silently ignored,
    // so syntactic errors that actually surface are rare. We instead simulate
    // a permission-style failure by writing a path that cannot be read: pass a
    // directory in place of a file. dotenv.config returns an error for EISDIR.
    // (Use the home slot since the repo path derives from cwd inside the fn.)
    rmSync(join(smelterHomeDir, '.env'), { force: true });
    mkdirSync(join(smelterHomeDir, '.env'), { recursive: true }); // directory at .env path

    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      expect(() => loadSmelterEnv(repoDir)).toThrow('process.exit called');
      const msg = consoleErrorMessages.find(s => s.startsWith('Error loading .env'));
      expect(msg).toBeDefined();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
