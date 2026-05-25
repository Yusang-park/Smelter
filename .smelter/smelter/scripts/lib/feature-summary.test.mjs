import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getActiveFeatureSummary, writeFeatureSummary } from './feature-summary.mjs';

function makeProject() {
  return mkdtempSync(join(tmpdir(), 'smt-summary-'));
}

{
  const dir = makeProject();
  const stateDir = join(dir, '.smt', 'state');
  const featureStateDir = join(dir, '.smt', 'features', 'demo', 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(featureStateDir, { recursive: true });
  writeFileSync(join(stateDir, 'active-feature-test.json'), JSON.stringify({ slug: 'demo' }));
  writeFeatureSummary(dir, 'demo', {
    surface: ['hook'],
    e2e_required: true,
    e2e_done: false,
    status: 'in_progress',
  });
  const summary = getActiveFeatureSummary(dir, 'test');
  assert.equal(summary.slug, 'demo');
  assert.equal(summary.e2e_required, true);
  assert.equal(summary.e2e_done, false);
  rmSync(dir, { recursive: true, force: true });
  console.log('feature-summary case 1 (active feature summary) OK');
}

{
  const dir = makeProject();
  const stateDir = join(dir, '.smt', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'active-feature-test.json'), JSON.stringify({ slug: 'demo' }));
  const summary = getActiveFeatureSummary(dir, 'test');
  assert.equal(summary, null);
  rmSync(dir, { recursive: true, force: true });
  console.log('feature-summary case 2 (missing summary returns null) OK');
}

console.log('feature-summary: OK');
