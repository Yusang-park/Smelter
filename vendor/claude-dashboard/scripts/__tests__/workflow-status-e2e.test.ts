/**
 * @handbook 8.2-e2e
 * @covers scripts/widgets/workflow-status.ts
 *
 * End-to-end: spawn the built `dist/index.js` and assert the rendered HUD line.
 * Guards against the v1 `step-` literal reappearing and verifies the v2 pipeline
 * from `.smt/features/<slug>/task/<slug>.state.json` → stdout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', '..', 'dist', 'index.js');

function seed(fixtureDir: string, slug: string, sessionId: string, state: Record<string, unknown>) {
  const stateDir = join(fixtureDir, '.smt', 'state');
  const taskDir = join(fixtureDir, '.smt', 'features', slug, 'task');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(stateDir, `active-feature-${sessionId}.json`),
    JSON.stringify({ slug, session_id: sessionId, updated_at: Date.now() }),
  );
  writeFileSync(join(taskDir, `${slug}.state.json`), JSON.stringify(state));
}

function runHud(fixtureDir: string, sessionId: string): string {
  const stdin = JSON.stringify({
    model: { display_name: 'Opus' },
    context_window: {
      context_window_size: 200000,
      current_usage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    cost: { total_cost_usd: 0.1 },
    session_id: sessionId,
    workspace: { current_dir: fixtureDir, project_dir: fixtureDir },
  });
  const r = spawnSync('node', [DIST], { input: stdin, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`dist/index.js exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

describe('workflow-status HUD (dist e2e)', () => {
  let fixtureDir = '';

  beforeEach(() => {
    if (!existsSync(DIST)) throw new Error(`dist not built: ${DIST} — run node scripts/build.js`);
    fixtureDir = mkdtempSync(join(tmpdir(), 'smt-workflow-e2e-'));
  });

  afterEach(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('renders MODE · slug · current_stage from v2 .state.json', () => {
    seed(fixtureDir, 'fix-hud-step', 'e2e-sess-1', {
      mode: 'fix',
      current_stage: 'workflow-coding',
    });
    const out = runHud(fixtureDir, 'e2e-sess-1');
    expect(out).toContain('FIX MODE · fix-hud-step · workflow-coding');
    expect(out).not.toMatch(/step-\d+/);
  });

  it('omits the stage segment when current_stage is null', () => {
    seed(fixtureDir, 'plan-new-thing', 'e2e-sess-2', {
      mode: 'plan',
      current_stage: null,
    });
    const out = runHud(fixtureDir, 'e2e-sess-2');
    expect(out).toContain('PLAN MODE · plan-new-thing');
    expect(out).not.toContain('null');
    expect(out).not.toMatch(/step-\d+/);
  });

  it('does not fall back to legacy workflow.json', () => {
    // No .state.json; only legacy workflow.json — the HUD must NOT render it.
    const slug = 'legacy-bypass';
    const stateDir = join(fixtureDir, '.smt', 'state');
    const legacyDir = join(fixtureDir, '.smt', 'features', slug, 'state');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'active-feature-e2e-sess-3.json'),
      JSON.stringify({ slug, session_id: 'e2e-sess-3', updated_at: Date.now() }),
    );
    writeFileSync(
      join(legacyDir, 'workflow.json'),
      JSON.stringify({ command: 'fix', step: 'step-1' }),
    );
    const out = runHud(fixtureDir, 'e2e-sess-3');
    expect(out).not.toContain('FIX MODE');
    expect(out).not.toContain(slug);
    expect(out).not.toMatch(/step-\d+/);
  });
});
