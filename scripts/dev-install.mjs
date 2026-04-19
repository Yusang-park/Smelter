#!/usr/bin/env node
/**
 * dev-install.mjs — Developer-mode setup for Smelter.
 *
 * Goals:
 *   1. End-user install stays simple: `claude plugin install smelter@smelter-marketplace`.
 *      Plugin manifest (plugin.json + hooks/hooks.json with ${CLAUDE_PLUGIN_ROOT})
 *      handles everything for them. This script does NOT touch that path.
 *   2. Developer testing requires no special ritual: run once, edits to this repo
 *      instantly reflect in every new Claude Code session.
 *   3. No duplicate hook registration. Script refuses to run if Smelter is
 *      already installed as a plugin (that would cause double-fire).
 *
 * What it does:
 *   - Creates symlinks `~/.claude/{skills,commands,agents}` → `<repo>/...`
 *     (skills/commands/agents are auto-discovered by Claude Code; symlinking
 *      avoids any sync step for day-to-day edits.)
 *   - Reads `<repo>/hooks/hooks.json`, substitutes `${CLAUDE_PLUGIN_ROOT}` with
 *     the absolute repo path, and merges the result into the `hooks` key of
 *     `~/.claude/settings.json`.
 *   - Tags the written section with `_smelter_dev_managed: true` so subsequent
 *     runs replace (not duplicate) the developer entry.
 *
 * Invariants:
 *   - Idempotent: running N times is equivalent to running once.
 *   - Non-destructive: existing `hooks` entries from other tools are preserved;
 *     only sections tagged `_smelter_dev_managed` are rewritten.
 *   - Fails fast if the user has the production plugin installed.
 *
 * Usage:
 *   node scripts/dev-install.mjs             # install dev mode
 *   node scripts/dev-install.mjs --uninstall # remove only the Smelter dev entries
 *   node scripts/dev-install.mjs --force     # bypass plugin-conflict check
 *   node scripts/dev-install.mjs --dry-run   # show the plan without writing
 */

import {
  existsSync, readFileSync, writeFileSync,
  symlinkSync, unlinkSync, lstatSync, mkdirSync, readlinkSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const INSTALLED_PLUGINS = join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
const DEV_TAG = '_smelter_dev_managed';

const SYMLINK_TARGETS = [
  { link: join(CLAUDE_DIR, 'skills'),   target: join(REPO_ROOT, 'skills') },
  { link: join(CLAUDE_DIR, 'commands'), target: join(REPO_ROOT, 'commands') },
  { link: join(CLAUDE_DIR, 'agents'),   target: join(REPO_ROOT, 'agents') },
];

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const FORCE = args.has('--force');
const UNINSTALL = args.has('--uninstall');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg)  { console.log('[dev-install] ' + msg); }
function warn(msg) { console.warn('[dev-install] WARN: ' + msg); }
function die(msg)  { console.error('[dev-install] ERROR: ' + msg); process.exit(2); }

function readJsonSafe(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch (err) { die(`cannot parse ${path}: ${err.message}`); }
}

function writeJson(path, obj) {
  if (DRY_RUN) { log(`(dry-run) would write ${path}`); return; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

function isSymlinkTo(link, target) {
  try {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) return false;
    return readlinkSync(link) === target;
  } catch { return false; }
}

function ensureSymlink(link, target) {
  if (isSymlinkTo(link, target)) {
    log(`symlink OK: ${link} → ${target}`);
    return;
  }
  if (existsSync(link) || existsSync(link) === false && lstatExists(link)) {
    // Existing entry is a file/dir/bad symlink — refuse to overwrite unless --force.
    if (!FORCE) {
      die(`${link} already exists and is not the expected symlink. Re-run with --force to replace, or remove manually.`);
    }
    if (!DRY_RUN) unlinkSync(link);
    log(`removed existing ${link}`);
  }
  if (DRY_RUN) { log(`(dry-run) would symlink ${link} → ${target}`); return; }
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link);
  log(`symlinked ${link} → ${target}`);
}

function lstatExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

function removeSymlink(link) {
  if (!lstatExists(link)) return;
  const stat = lstatSync(link);
  if (!stat.isSymbolicLink()) {
    warn(`${link} is not a symlink; leaving it alone`);
    return;
  }
  if (DRY_RUN) { log(`(dry-run) would remove symlink ${link}`); return; }
  unlinkSync(link);
  log(`removed symlink ${link}`);
}

function substituteHookPaths(hooksJson) {
  // Deep-clone then replace ${CLAUDE_PLUGIN_ROOT} with the absolute repo path.
  const str = JSON.stringify(hooksJson).replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, REPO_ROOT);
  return JSON.parse(str);
}

function detectPluginConflict() {
  const data = readJsonSafe(INSTALLED_PLUGINS, { version: 2, plugins: {} });
  const plugins = data.plugins || {};
  const keys = Object.keys(plugins).filter(k => /smelter/i.test(k));
  if (keys.length > 0) {
    return `Smelter is installed as a plugin (${keys.join(', ')}). Running dev-install would cause duplicate hook execution. Uninstall the plugin first or re-run with --force.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function install() {
  // 1. Pre-flight: refuse if plugin is active.
  const conflict = detectPluginConflict();
  if (conflict) {
    if (!FORCE) die(conflict);
    warn(conflict + ' (proceeding due to --force)');
  }

  // 2. Symlinks for skills/commands/agents.
  for (const { link, target } of SYMLINK_TARGETS) {
    if (!existsSync(target)) die(`expected repo path missing: ${target}`);
    ensureSymlink(link, target);
  }

  // 3. Load hooks.json and substitute paths.
  const hooksPath = join(REPO_ROOT, 'hooks', 'hooks.json');
  if (!existsSync(hooksPath)) die(`hooks.json missing at ${hooksPath}`);
  const hooksBlob = readJsonSafe(hooksPath, {});
  if (!hooksBlob.hooks || typeof hooksBlob.hooks !== 'object') {
    die(`hooks.json does not contain a "hooks" object`);
  }
  const resolved = substituteHookPaths(hooksBlob.hooks);

  // 4. Merge into settings.json.
  const settings = readJsonSafe(SETTINGS_PATH, {});
  const existing = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const eventNames = new Set([...Object.keys(existing), ...Object.keys(resolved)]);
  const merged = {};

  for (const event of eventNames) {
    const prevEntries = Array.isArray(existing[event]) ? existing[event] : [];
    const nextEntries = Array.isArray(resolved[event]) ? resolved[event] : [];
    // Drop previous dev-managed entries for this event; keep foreign entries.
    const keptPrev = prevEntries.filter(e => !e?.[DEV_TAG]);
    // Tag new entries so later uninstall can find them.
    const taggedNext = nextEntries.map(e => ({ ...e, [DEV_TAG]: true }));
    merged[event] = [...keptPrev, ...taggedNext];
  }

  settings.hooks = merged;
  settings._smelter_dev_note =
    'hooks entries tagged with _smelter_dev_managed are generated by scripts/dev-install.mjs from '
    + REPO_ROOT + '/hooks/hooks.json — re-run the script to refresh; run with --uninstall to remove.';

  writeJson(SETTINGS_PATH, settings);
  log(`hooks merged into ${SETTINGS_PATH} (${Object.keys(merged).length} event groups)`);
  log('install complete. Start a new Claude Code session to activate.');
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

function uninstall() {
  // 1. Remove symlinks.
  for (const { link, target } of SYMLINK_TARGETS) {
    if (isSymlinkTo(link, target)) removeSymlink(link);
  }

  // 2. Strip dev-managed hooks from settings.json.
  if (!existsSync(SETTINGS_PATH)) {
    log('settings.json missing; nothing to strip');
    return;
  }
  const settings = readJsonSafe(SETTINGS_PATH, {});
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    log('no hooks section in settings.json; nothing to strip');
  } else {
    const cleaned = {};
    let removed = 0;
    for (const [event, entries] of Object.entries(settings.hooks)) {
      const kept = Array.isArray(entries) ? entries.filter(e => !e?.[DEV_TAG]) : entries;
      removed += (Array.isArray(entries) ? entries.length : 0) - (Array.isArray(kept) ? kept.length : 0);
      if (Array.isArray(kept) && kept.length === 0) continue; // drop empty event groups
      cleaned[event] = kept;
    }
    if (Object.keys(cleaned).length === 0) {
      delete settings.hooks;
    } else {
      settings.hooks = cleaned;
    }
    delete settings._smelter_dev_note;
    writeJson(SETTINGS_PATH, settings);
    log(`removed ${removed} dev-managed hook entries from settings.json`);
  }
  log('uninstall complete.');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (DRY_RUN) log('DRY RUN — no files will be modified');
log(`repo root: ${REPO_ROOT}`);
log(`claude dir: ${CLAUDE_DIR}`);
log(`mode: ${UNINSTALL ? 'uninstall' : 'install'}${FORCE ? ' (force)' : ''}`);
console.log('');

if (UNINSTALL) uninstall();
else install();
