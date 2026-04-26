#!/usr/bin/env node
/**
 * dev-install.test.mjs — Verify the developer install script is idempotent,
 * conflict-safe, and reversible.
 *
 * Strategy: run the installer against a fake HOME + a fake repo root. We do
 * not touch the real ~/.claude. The installer reads paths from env/argv, so
 * we spawn it as a subprocess with overridden HOME.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readlinkSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const INSTALLER = join(REPO_ROOT, 'scripts', 'dev-install.mjs');

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + label);
  } catch (err) {
    failed++;
    failures.push({ label, message: err.message });
    console.log('  FAIL  ' + label);
    console.log('        ' + err.message);
  }
}

function section(title) { console.log('\n[' + title + ']'); }

/**
 * Stage a fake Smelter repo + fake HOME and run the installer against them.
 * Returns { home, fakeRepo, run(args) → spawnSync result }.
 */
function stageEnv() {
  const root = mkdtempSync(join(tmpdir(), 'devinstall-'));
  const fakeRepo = join(root, 'Smelter');
  const home = join(root, 'home');
  mkdirSync(join(fakeRepo, 'skills'),   { recursive: true });
  mkdirSync(join(fakeRepo, 'commands'), { recursive: true });
  mkdirSync(join(fakeRepo, 'agents'),   { recursive: true });
  mkdirSync(join(fakeRepo, 'hooks'),    { recursive: true });
  mkdirSync(join(fakeRepo, 'scripts'),  { recursive: true });
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  // Write a minimal hooks.json mirroring Smelter's structure.
  writeFileSync(join(fakeRepo, 'hooks', 'hooks.json'), JSON.stringify({
    description: 'test',
    hooks: {
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/foo.mjs"', timeout: 10 }]}],
      UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/bar.mjs"', timeout: 5 }]}],
    },
  }, null, 2));
  // Copy the installer script in (must be resolvable via REPO_ROOT=fakeRepo).
  const installerContent = readFileSync(INSTALLER, 'utf-8');
  writeFileSync(join(fakeRepo, 'scripts', 'dev-install.mjs'), installerContent);
  // Empty installed_plugins.json.
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }));
  return {
    root,
    home,
    fakeRepo,
    run: (args = []) => spawnSync('node', [join(fakeRepo, 'scripts', 'dev-install.mjs'), ...args], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ----------------------------------------------------------------------------
section('Install: first run creates symlinks + hooks section');
// ----------------------------------------------------------------------------
{
  const e = stageEnv();
  try {
    const r = e.run();
    test('exit 0', () => assert.equal(r.status, 0, r.stderr + r.stdout));
    const settings = JSON.parse(readFileSync(join(e.home, '.claude', 'settings.json'), 'utf-8'));
    test('hooks key written', () => assert.ok(settings.hooks && Object.keys(settings.hooks).length === 2));
    test('Stop hook present', () => assert.ok(Array.isArray(settings.hooks.Stop) && settings.hooks.Stop.length === 1));
    test('${CLAUDE_PLUGIN_ROOT} substituted with absolute path', () => {
      const cmd = settings.hooks.Stop[0].hooks[0].command;
      assert.ok(cmd.includes(e.fakeRepo), 'command should contain fake repo path; got ' + cmd);
      assert.ok(!cmd.includes('${CLAUDE_PLUGIN_ROOT}'), 'placeholder still literal');
    });
    test('_smelter_dev_managed tag on matcher group', () => {
      assert.equal(settings.hooks.Stop[0]._smelter_dev_managed, true);
    });
    // realpath-aware comparison (macOS /var ↔ /private/var)
    const expectedRepo = realpathSync(e.fakeRepo);
    test('skills are NOT symlinked globally', () => {
      assert.ok(!existsSync(join(e.home, '.claude', 'skills')));
    });
    test('symlink commands created', () => {
      const target = realpathSync(join(e.home, '.claude', 'commands'));
      assert.equal(target, join(expectedRepo, 'commands'));
    });
    test('agents are NOT symlinked globally', () => {
      assert.ok(!existsSync(join(e.home, '.claude', 'agents')));
    });
  } finally { e.cleanup(); }
}

// ----------------------------------------------------------------------------
section('Idempotency: second run does not duplicate');
// ----------------------------------------------------------------------------
{
  const e = stageEnv();
  try {
    e.run();
    const first = JSON.parse(readFileSync(join(e.home, '.claude', 'settings.json'), 'utf-8'));
    const r2 = e.run();
    test('second run exit 0', () => assert.equal(r2.status, 0, r2.stderr));
    const second = JSON.parse(readFileSync(join(e.home, '.claude', 'settings.json'), 'utf-8'));
    for (const event of Object.keys(first.hooks)) {
      test(`${event} entry count unchanged`, () => {
        assert.equal(second.hooks[event].length, first.hooks[event].length);
      });
    }
  } finally { e.cleanup(); }
}

// ----------------------------------------------------------------------------
section('Migration: untagged legacy Smelter hooks are replaced');
// ----------------------------------------------------------------------------
{
  const e = stageEnv();
  try {
    mkdirSync(join(e.home, '.claude'), { recursive: true });
    writeFileSync(join(e.home, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: '*', hooks: [{ type: 'command', command: `node "${e.fakeRepo}/scripts/bar.mjs"`, timeout: 5 }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'foreign', timeout: 5 }] },
        ],
      },
    }, null, 2));
    const r = e.run();
    test('migration run exit 0', () => assert.equal(r.status, 0, r.stderr));
    const after = JSON.parse(readFileSync(join(e.home, '.claude', 'settings.json'), 'utf-8'));
    const userPrompt = after.hooks.UserPromptSubmit || [];
    test('legacy untagged Smelter hook removed', () => {
      const legacy = userPrompt.filter((entry) => !entry._smelter_dev_managed && JSON.stringify(entry).includes(e.fakeRepo));
      assert.equal(legacy.length, 0);
    });
    test('foreign hook preserved', () => {
      assert.ok(userPrompt.some((entry) => entry.hooks?.[0]?.command === 'foreign'));
    });
    test('single managed UserPromptSubmit hook installed', () => {
      assert.equal(userPrompt.filter((entry) => entry._smelter_dev_managed).length, 1);
    });
  } finally { e.cleanup(); }
}

// ----------------------------------------------------------------------------
section('Plugin conflict: installer refuses when plugin is registered');
// ----------------------------------------------------------------------------
{
  const e = stageEnv();
  try {
    writeFileSync(
      join(e.home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { smelter: { name: 'smelter' } } }),
    );
    const r = e.run();
    test('exit code 2 on conflict', () => assert.equal(r.status, 2));
    test('error mentions duplicate hook execution', () => {
      assert.match(r.stderr, /duplicate hook execution/i);
    });
    test('settings.json NOT touched on conflict', () => {
      assert.ok(!existsSync(join(e.home, '.claude', 'settings.json')));
    });
  } finally { e.cleanup(); }
}

// ----------------------------------------------------------------------------
section('--force: bypass plugin conflict');
// ----------------------------------------------------------------------------
{
  const e = stageEnv();
  try {
    writeFileSync(
      join(e.home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { smelter: { name: 'smelter' } } }),
    );
    const r = e.run(['--force']);
    test('exit 0 with --force', () => assert.equal(r.status, 0, r.stderr));
    test('warning emitted on stderr', () => assert.match(r.stderr, /proceeding due to --force/));
    test('settings.json created anyway', () => assert.ok(existsSync(join(e.home, '.claude', 'settings.json'))));
  } finally { e.cleanup(); }
}

// ----------------------------------------------------------------------------
section('--uninstall: removes dev-managed entries only');
// ----------------------------------------------------------------------------
{
  const e = stageEnv();
  try {
    e.run();
    // Add a foreign hooks entry that must survive uninstall.
    const s = JSON.parse(readFileSync(join(e.home, '.claude', 'settings.json'), 'utf-8'));
    s.hooks.Stop.push({ matcher: '*', hooks: [{ type: 'command', command: 'other', timeout: 5 }] });
    writeFileSync(join(e.home, '.claude', 'settings.json'), JSON.stringify(s, null, 2));
    const r = e.run(['--uninstall']);
    test('uninstall exit 0', () => assert.equal(r.status, 0, r.stderr));
    const after = JSON.parse(readFileSync(join(e.home, '.claude', 'settings.json'), 'utf-8'));
    test('dev entries stripped', () => {
      const remaining = (after.hooks?.Stop || []).filter(e => e._smelter_dev_managed);
      assert.equal(remaining.length, 0);
    });
    test('foreign entry preserved', () => {
      assert.ok((after.hooks?.Stop || []).some(e => e.hooks?.[0]?.command === 'other'));
    });
    test('global command symlink removed', () => {
      assert.ok(!existsSync(join(e.home, '.claude', 'skills')));
      assert.ok(!existsSync(join(e.home, '.claude', 'commands')));
      assert.ok(!existsSync(join(e.home, '.claude', 'agents')));
    });
    test('_smelter_dev_note cleared', () => {
      assert.ok(!('_smelter_dev_note' in after));
    });
  } finally { e.cleanup(); }
}

// ----------------------------------------------------------------------------
section('--dry-run: no filesystem changes');
// ----------------------------------------------------------------------------
{
  const e = stageEnv();
  try {
    const r = e.run(['--dry-run']);
    test('dry-run exit 0', () => assert.equal(r.status, 0, r.stderr));
    test('no settings.json written', () => assert.ok(!existsSync(join(e.home, '.claude', 'settings.json'))));
    test('no symlinks created', () => assert.ok(!existsSync(join(e.home, '.claude', 'skills'))));
  } finally { e.cleanup(); }
}

// ----------------------------------------------------------------------------
console.log('');
console.log(`\ndev-install: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f.label + ': ' + f.message);
  process.exit(1);
}
