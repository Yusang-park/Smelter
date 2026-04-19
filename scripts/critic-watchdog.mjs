#!/usr/bin/env node
/**
 * critic-watchdog.mjs — Hook Layer 1 of Pattern E Adversarial Watchdog.
 *
 * workflow-v2.md §12-8. Triggers on PostToolUse (Edit/Write/Bash).
 * Checks 10 formal rules and blocks CRITICAL violations via exit 2.
 *
 * Input (stdin JSON from Claude Code hook):
 *   { tool_name, tool_input, cwd, session_id, ... }
 *
 * Output (stdout JSON on violation):
 *   { decision: 'block', reason, severity, rule_id }
 *
 * Exit codes:
 *   0 — no violation (allow)
 *   2 — CRITICAL violation (block)
 *   1 — self error (allow to avoid blocking)
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

function readStdinJson() {
  try { return JSON.parse(readFileSync('/dev/stdin', 'utf-8')); } catch { return {}; }
}

function emit(decision, severity, ruleId, reason) {
  console.log(JSON.stringify({ decision, severity, rule_id: ruleId, reason, source: 'critic-watchdog' }));
}

// ===== 10 Rules =====

function rule01_testFileDelete(input) {
  if (input.tool_name !== 'Bash') return null;
  const cmd = input.tool_input?.command || '';
  if (/\brm\b.*\.test\./i.test(cmd) || /\bgit\s+rm\b.*\.test\./i.test(cmd)) {
    return { rule: 'R01', severity: 'CRITICAL', reason: 'test file deletion forbidden (iron law)' };
  }
  return null;
}

function rule02_noVerifyOrForce(input) {
  if (input.tool_name !== 'Bash') return null;
  const cmd = input.tool_input?.command || '';
  if (/--no-verify\b/.test(cmd)) {
    return { rule: 'R02a', severity: 'CRITICAL', reason: '--no-verify forbidden' };
  }
  if (/git\s+(push|reset|checkout)\b.*--force\b/.test(cmd) || /git\s+push\s+-f\b/.test(cmd)) {
    return { rule: 'R02b', severity: 'CRITICAL', reason: '--force forbidden without explicit user request' };
  }
  return null;
}

function rule03_secretsAccess(input) {
  const target = input.tool_input?.file_path || input.tool_input?.path || '';
  if (!target) return null;
  if (/(?:^|\/)\.env(\.|$)/.test(target) || /credentials\.json$/.test(target) || /secrets?\./.test(target)) {
    // Read from .env is sometimes OK in dev, but edit/write is never OK.
    if (input.tool_name === 'Edit' || input.tool_name === 'Write') {
      return { rule: 'R03', severity: 'CRITICAL', reason: `secrets-file write forbidden: ${target}` };
    }
  }
  return null;
}

function rule04_unresolvedFeedbackComplete(input, state) {
  if (!state) return null;
  if (input.tool_name !== 'Bash') return null;
  const cmd = input.tool_input?.command || '';
  if (!/\bgit\s+commit\b/.test(cmd)) return null;
  const unresolved = (state.active_feedback || []).filter(f => !f.resolved);
  if (unresolved.length > 0) {
    return { rule: 'R04', severity: 'CRITICAL', reason: `${unresolved.length} unresolved feedback; cannot commit-complete` };
  }
  return null;
}

function rule05_tddCycleBeforeCoding(input, state) {
  if (!state) return null;
  if (state.current_stage !== 'workflow-coding') return null;
  // If entering coding but no RED cycle recorded, block any src/** write.
  const red = (state.test_cycles || []).filter(c =>
    ['added_case','modified_case'].includes(c.action) && c.run_result === 'fail'
  );
  if (red.length > 0) return null;
  if (state.exempt?.tdd) return null;  // surface exemption
  const target = input.tool_input?.file_path || '';
  if ((input.tool_name === 'Edit' || input.tool_name === 'Write') &&
      target && !/\.test\./.test(target) && /\/src\//.test(target)) {
    return { rule: 'R05', severity: 'CRITICAL', reason: 'workflow-coding entered without RED cycle; write test first' };
  }
  return null;
}

function rule06_whitelistViolation(input, state) {
  if (!state) return null;
  const current = state.current_stage;
  if (!current) return null;
  if (!current.startsWith('workflow-')) return null;
  if (!(state.allowed_skills || []).includes(current)) {
    return { rule: 'R06', severity: 'CRITICAL', reason: `current_stage ${current} not in mode allowed_skills` };
  }
  return null;
}

function rule07_scopeLeak(input, state, cwd) {
  if (!state) return null;
  if (input.tool_name !== 'Edit' && input.tool_name !== 'Write') return null;
  const target = input.tool_input?.file_path || '';
  if (!target) return null;
  // Read plan.md Queue, check if target is referenced.
  const features = join(cwd, '.smt', 'features');
  if (!existsSync(features)) return null;
  const planPath = guessPlanPath(features, state);
  if (!planPath || !existsSync(planPath)) return null;
  const plan = readFileSync(planPath, 'utf-8');
  const relTarget = target.replace(cwd + '/', '');
  // Heuristic: if target's basename doesn't appear in plan at all, flag as HIGH.
  const base = relTarget.split('/').pop();
  if (base && !plan.includes(base)) {
    return { rule: 'R07', severity: 'HIGH', reason: `file '${relTarget}' not referenced in plan.md Queue (possible scope leak)` };
  }
  return null;
}

function rule08_evasionPatterns(input) {
  if (input.tool_name !== 'Edit' && input.tool_name !== 'Write') return null;
  const content = input.tool_input?.new_string || input.tool_input?.content || '';
  if (!content) return null;
  // Count ?? fallback and TODO comments
  const nullishCount = (content.match(/\?\?/g) || []).length;
  const todoCount = (content.match(/\bTODO\b|\bFIXME\b|\bXXX\b/g) || []).length;
  if (nullishCount >= 5) {
    return { rule: 'R08a', severity: 'HIGH', reason: `${nullishCount}× '??' in single edit — likely evasion fallback chain` };
  }
  if (todoCount >= 3) {
    return { rule: 'R08b', severity: 'HIGH', reason: `${todoCount}× TODO/FIXME added — evasion via deferral` };
  }
  return null;
}

function rule09_parallelFileConflict(input, state) {
  if (!state) return null;
  if (input.tool_name !== 'Edit' && input.tool_name !== 'Write') return null;
  const target = input.tool_input?.file_path || '';
  if (!target) return null;
  const runtime = state.team_runtime || {};
  for (const [skill, cfg] of Object.entries(runtime)) {
    if (cfg.pattern !== 'C') continue;
    const agents = cfg.assigned_agents || [];
    const inProgress = agents.filter(a => a.status === 'in_progress');
    if (inProgress.length >= 2) {
      // Warn only; can't know which agent is writing right now.
      return { rule: 'R09', severity: 'HIGH', reason: `${inProgress.length} parallel agents active in ${skill}; coordinate via sync_point` };
    }
  }
  return null;
}

function rule10_sessionLogMissing(input, state, cwd) {
  if (!state) return null;
  if (state.current_stage !== 'done') return null;
  const today = new Date().toISOString().slice(0, 10);
  const logPath = join(cwd, '.smt', 'session', `${today}.md`);
  if (!existsSync(logPath)) {
    return { rule: 'R10', severity: 'MEDIUM', reason: 'complete without session/YYYY-MM-DD.md log' };
  }
  return null;
}

// R11 — E2E pass claim without real-interface artifacts.
// Triggers when the agent tries to record a pass event for workflow-e2e OR
// workflow-verify (Phase 3) while no artifacts/ files exist for the exercised
// surface. This enforces the §8 "real interface" rule: test-runner output alone
// is not a valid E2E pass (see skills/workflow-e2e/SKILL.md).
function rule11_e2ePassWithoutArtifacts(input, state, cwd) {
  if (!state) return null;
  // Fire only when the current stage is an E2E-producing skill.
  const stage = state.current_stage;
  if (stage !== 'workflow-e2e' && stage !== 'workflow-verify') return null;

  // We care about edits that would finalize the stage: writes to a
  // verify_report.md / e2e_review evidence file, or Bash commands that append
  // a pass-shaped event.
  const target = input.tool_input?.file_path || '';
  const content = input.tool_input?.new_string || input.tool_input?.content || '';
  const cmd = input.tool_input?.command || '';
  const looksLikePassClaim =
    /result:\s*['"]?pass['"]?/i.test(content) ||
    /"result"\s*:\s*"pass"/.test(content) ||
    /"current_stage"\s*:\s*"done"/.test(content) ||
    /e2e.*pass(?:ed)?/i.test(cmd);
  const finalizingTool = (input.tool_name === 'Edit' || input.tool_name === 'Write' || input.tool_name === 'Bash');
  if (!finalizingTool || !looksLikePassClaim) return null;

  // Resolve the artifacts directory for the active feature.
  const featuresRoot = join(cwd, '.smt', 'features');
  if (!existsSync(featuresRoot)) {
    return { rule: 'R11', severity: 'CRITICAL', reason: 'E2E pass claim without .smt/features/<slug>/artifacts/ directory' };
  }
  let hasAnyArtifact = false;
  try {
    for (const slug of readdirSync(featuresRoot)) {
      const dir = join(featuresRoot, slug, 'artifacts');
      if (!existsSync(dir)) continue;
      // Count at least one non-empty file (.webm / .png / .log / .transcript / .json / .sql.log / .exit).
      const walk = (d) => {
        for (const f of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, f.name);
          if (f.isDirectory()) { walk(p); continue; }
          if (/\.(webm|mp4|png|jpg|jpeg|log|transcript|json|sql|exit)$/i.test(f.name)) {
            hasAnyArtifact = true;
            return;
          }
        }
      };
      try { walk(dir); } catch {}
      if (hasAnyArtifact) break;
    }
  } catch {}

  if (!hasAnyArtifact) {
    return {
      rule: 'R11',
      severity: 'CRITICAL',
      reason: `E2E / verify stage ${stage} tried to record pass without any real-interface artifact — §8 violation (test-runner output is not E2E evidence)`,
    };
  }
  return null;
}

// ===== Helpers =====

function guessPlanPath(featuresRoot, state) {
  if (!state?.task_id) return null;
  // Look for any feature dir containing a plan.md
  try {
    for (const slug of readdirSync(featuresRoot)) {
      const p = join(featuresRoot, slug, 'task', 'plan.md');
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

function readActiveState(cwd) {
  const active = join(cwd, '.smt', 'active_task');
  if (existsSync(active)) {
    try {
      const target = readFileSync(active, 'utf-8').trim();
      if (existsSync(target)) return JSON.parse(readFileSync(target, 'utf-8'));
    } catch {}
  }
  return null;
}

// ===== Main =====

export const RULES = [
  rule01_testFileDelete, rule02_noVerifyOrForce, rule03_secretsAccess,
  rule04_unresolvedFeedbackComplete, rule05_tddCycleBeforeCoding,
  rule06_whitelistViolation, rule07_scopeLeak, rule08_evasionPatterns,
  rule09_parallelFileConflict, rule10_sessionLogMissing,
  rule11_e2ePassWithoutArtifacts,
];

export function runAll(input, state, cwd) {
  const hits = [];
  for (const rule of RULES) {
    try {
      const r = rule(input, state, cwd);
      if (r) hits.push(r);
    } catch (e) {
      // Never block on our own error.
      continue;
    }
  }
  return hits;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const input = readStdinJson();
  const cwd = input.cwd || process.cwd();
  const state = readActiveState(cwd);
  const hits = runAll(input, state, cwd);

  const critical = hits.find(h => h.severity === 'CRITICAL');
  if (critical) {
    emit('block', 'CRITICAL', critical.rule, critical.reason);
    process.exit(2);
  }

  const high = hits.filter(h => h.severity === 'HIGH');
  if (high.length) {
    emit('warn', 'HIGH', high.map(h => h.rule).join(','), high.map(h => h.reason).join('; '));
    process.exit(0);
  }

  const med = hits.filter(h => h.severity === 'MEDIUM');
  if (med.length) {
    emit('warn', 'MEDIUM', med.map(h => h.rule).join(','), med.map(h => h.reason).join('; '));
  }
  process.exit(0);
}
