#!/usr/bin/env node
/**
 * critic-watchdog.mjs — Hook Layer 1 of Pattern E Adversarial Watchdog.
 *
 * workflow-v2.md §12-8. Triggers on PostToolUse (Edit/Write/Bash).
 * Checks 13 formal rules and blocks CRITICAL violations via exit 2.
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

// Emit a Claude Code hook response. The Claude Code hook schema only allows a
// fixed set of root-level keys (`continue`, `decision`, `reason`, `systemMessage`,
// `suppressOutput`, `additionalContext`, `hookSpecificOutput`); extra fields
// trigger "(root): Invalid input" validation errors. Internal metadata
// (severity, rule id, source) is logged to stderr instead.
function emitBlock(ruleId, severity, reason) {
  process.stderr.write(`[critic-watchdog ${severity}] ${ruleId}: ${reason}\n`);
  console.log(JSON.stringify({ decision: 'block', reason }));
}

function emitWarn(ruleIds, severity, reason) {
  process.stderr.write(`[critic-watchdog ${severity}] ${ruleIds}: ${reason}\n`);
  console.log(JSON.stringify({ continue: true, systemMessage: `[critic-watchdog ${severity}] ${reason}` }));
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

// R12 — block src/scripts edits when a workflow command is active but the
// agent hasn't entered a workflow skill yet. Plugs the bypass where /fix (or
// any mode command) seeds an active-feature pointer but the agent jumps
// straight to Edit/Write without invoking workflow-investigate.
//
// Fires when ALL of the following hold:
//   - tool is Edit or Write
//   - target is under src/ or scripts/ (project code), NOT a *.test.* file
//   - a workflow command is active (state exists with current_stage=null, OR
//     active-feature.json pointer exists without a .state.json)
//
// Deliberately does NOT fire when .smt/ does not exist (non-Smelter project)
// or when the edit targets a test file (tests-first is the intended escape).
function rule12_workflowStageRequired(input, state, cwd) {
  if (input.tool_name !== 'Edit' && input.tool_name !== 'Write') return null;
  const target = input.tool_input?.file_path || '';
  if (!target) return null;
  const rel = cwd ? target.replace(cwd + '/', '') : target;
  const base = rel.split('/').pop() || '';
  const smelterSelfEdit = /(^|\/)(skills|scripts|document)\//.test(rel) && cwd.includes('/Smelter');
  // Smelter test files use two naming conventions:
  //   foo.test.mjs / foo.spec.mjs  (suffix form — most scripts + frontend)
  //   test-foo.mjs / foo-test.mjs  (prefix/infix form — hook test scaffolds)
  // Both must be exempt so TDD-first edits are never blocked by R12.
  const isTest = /\.test\.|\.spec\./.test(base)
    || /^test[-_]/.test(base)
    || /[-_]test\./.test(base)
    || /\/tests?\//.test(rel)
    || /\/spec\//.test(rel)
    || /\/__tests__\//.test(rel);
  if (isTest) return null;
  const isCode = /^(?:src|scripts|bin|lib)\//.test(rel) || /\/(?:src|scripts|bin|lib)\//.test(rel) || smelterSelfEdit;
  if (!isCode) return null;

  if (state) {
    if (state.current_stage === null || state.current_stage === undefined) {
      return {
        rule: 'R12',
        severity: 'CRITICAL',
        reason: `workflow active (mode=${state.mode}) but current_stage is null — invoke workflow-investigate before editing ${rel}`,
      };
    }
    return null;
  }

  // state === null: still block if the user IS inside a workflow command, i.e.
  // an active-feature pointer was seeded by keyword-detector. Without this
  // guard the agent can bypass the entire workflow by writing code before any
  // workflow skill runs. Session-aware: prefer per-session pointer so a
  // concurrent session's workflow state doesn't trigger R12 here.
  if (!cwd) return null;
  const sessionId = input.session_id;
  const activePointer = sessionId
    ? join(cwd, '.smt', 'state', `active-feature-${sessionId}.json`)
    : join(cwd, '.smt', 'state', 'active-feature.json');
  if (!existsSync(activePointer)) return null;
  return {
    rule: 'R12',
    severity: 'CRITICAL',
    reason: `workflow command active (see ${activePointer.replace(cwd + '/', '')}) but no .state.json — invoke workflow-investigate first; editing ${rel} is a workflow bypass`,
  };
}

// R13 — Bash-based state.json write bypass (defense-in-depth).
//
// pre-tool-enforcer blocks agent Write/Edit on .state.json, but Bash commands
// like `node -e "fs.writeFileSync('.smt/.../x.state.json', ...)"` reach
// PostToolUse without being caught there. R13 scans Bash commands for this
// pattern. Skipped when SMT_HOOK_WRITE=1 is set (hook-owned writes).
// Unwrap `bash -c '<body>'` / `sh -c "<body>"` etc. Returns the body when
// the whole command is a single quoted `-c '<body>'` invocation; otherwise
// returns the original command unchanged. Used by R13 so a read-only
// `ls`/`cat` wrapped in `bash -c` is not misread as interpreter-exec.
export function unwrapShellCExec(cmd) {
  if (typeof cmd !== 'string') return cmd;
  const trimmed = cmd.trim();
  const m = trimmed.match(/^(?:bash|sh|zsh)\s+-c\s+(['"])([\s\S]*)\1\s*$/);
  if (!m) return cmd;
  return m[2];
}

function isPureReadCmd(src) {
  // A pure-read body may still contain `;` or `&&`/`||` between read-only
  // commands. Split on statement separators and require every sub-command
  // to start with an allowed read tool.
  const READ_TOOLS = /^\s*(?:cat|head|tail|less|more|wc|file|stat|ls|grep|rg|jq|sort|uniq|diff|md5sum|sha256sum|echo|printf|true|:)\b/i;
  const statements = String(src || '').split(/(?:\|\||&&|[;|])/).map(s => s.trim()).filter(Boolean);
  if (statements.length === 0) return false;
  return statements.every(s => READ_TOOLS.test(s));
}

function rule13_bashStateJsonWrite(input) {
  if (input.tool_name !== 'Bash') return null;
  const cmdRaw = input.tool_input?.command || '';
  if (!cmdRaw) return null;

  // Analyze both the raw command and the unwrapped body (for `bash -c '…'`).
  // Protection + read-only checks use the effective body so a read-only
  // wrapper isn't misread as interpreter-exec.
  const cmd = cmdRaw;
  const body = unwrapShellCExec(cmdRaw);

  // Protected paths: .state.json and active_task pointer family.
  const mentionsProtected =
    /\.state\.json\b/i.test(body) ||
    /\.smt[\/\\]active_task\b/.test(body) ||
    /\.smt[\/\\]state[\/\\]active-feature/.test(body);
  if (!mentionsProtected) return null;

  // Pure-read commands on protected paths are allowed. Check the unwrapped
  // body so `bash -c 'ls .smt/state/active-feature*.json'` is accepted.
  if (isPureReadCmd(body)) return null;

  // Mutating primitives (language-agnostic). Path-mention + mutating-verb
  // beats per-language verb enumeration.
  //
  // Interpreter flags that evaluate arbitrary code: -e / -c / -m / -i.
  // `python -c`, `perl -e`, `ruby -e`, `node -e`, `bash -c`, etc. Checked
  // on the unwrapped body so `bash -c 'ls'` does NOT look like interpreter
  // exec of a mutating script.
  const interpreterExec = /\b(?:node|python[23]?|perl|ruby|deno|bun|php|awk)\s+-(?:[iIem]|-eval|-exec)\b/.test(body)
    || /\b(?:bash|sh|zsh)\s+-(?:[iIem]|-eval|-exec)\b/.test(body);
  const shellMutators = /\b(?:cp|mv|install|rsync|ln|touch|truncate|dd|tee|shred|rm|sed)\b/.test(body);
  const apiWriters = /\bwriteFile(?:Sync)?\b/.test(body) || /\bcreateWriteStream\b/.test(body);
  const openForWrite = /\bopen\s*\(\s*['"][^'"]+['"]\s*,\s*['"][wa]/.test(body);
  // Redirects: the protected path must be the actual redirect target token
  // (ends with .state.json or active_task AND lies immediately after >/>>).
  const redirectTarget = />>?\s*['"]?[^|&;\s"']*(?:\.state\.json|\.smt[\/\\]active_task)['"]?(?:\s|$|&|;|\|)/.test(body);
  const heredocToTarget = /<<[-~]?\s*['"]?\w+['"]?[\s\S]*?>\s*['"]?[^|&;\s"']*(?:\.state\.json|\.smt[\/\\]active_task)/.test(body);
  const mutates = interpreterExec || shellMutators || apiWriters || openForWrite || redirectTarget || heredocToTarget;
  if (!mutates) return null;

  // False-positive shield: benign `echo "...state.json..." > not-protected-path`
  // — if the command has NO interpreter-exec, NO shell-mutator, NO api-writer,
  // NO open-for-write, and the only trigger was a redirect, require the
  // redirect target itself to reference the protected path.
  if (!interpreterExec && !shellMutators && !apiWriters && !openForWrite && !redirectTarget && !heredocToTarget) return null;

  return {
    rule: 'R13',
    severity: 'CRITICAL',
    reason: `Bash command mentions a protected workflow state/pointer path with a mutating primitive — bypasses the skill-driven gate. Invoke the appropriate workflow-* skill instead. (cmd head: ${cmd.slice(0, 120)})`,
  };
}

// R14 — E2E pass claim without verified effect evidence.
//
// Artifacts alone are insufficient. If workflow-e2e / workflow-verify claims
// pass, state.scenarios[] must exist and every scenario must carry populated
// effect_evidence with a valid non-ack-only type and a reference.
function rule14_e2ePassWithoutEffectEvidence(input, state) {
  if (!state) return null;
  const stage = state.current_stage;
  if (stage !== 'workflow-e2e' && stage !== 'workflow-verify') return null;

  const content = input.tool_input?.new_string || input.tool_input?.content || '';
  const cmd = input.tool_input?.command || '';
  const finalizingTool = input.tool_name === 'Edit' || input.tool_name === 'Write' || input.tool_name === 'Bash';
  const looksLikePassClaim =
    /result:\s*['"]?pass['"]?/i.test(content) ||
    /"result"\s*:\s*"pass"/.test(content) ||
    /"current_stage"\s*:\s*"done"/.test(content) ||
    /e2e.*pass(?:ed)?/i.test(cmd);
  if (!finalizingTool || !looksLikePassClaim) return null;

  const scenarios = Array.isArray(state.scenarios) ? state.scenarios : [];
  if (scenarios.length === 0) {
    return {
      rule: 'R14',
      severity: 'CRITICAL',
      reason: `E2E / verify stage ${stage} tried to record pass without state.scenarios[] effect evidence — cause: effect_unverified`,
    };
  }

  for (const scenario of scenarios) {
    const effect = scenario?.effect_evidence;
    if (!effect || typeof effect !== 'object') {
      return {
        rule: 'R14',
        severity: 'CRITICAL',
        reason: `scenario '${scenario?.name ?? '(unnamed)'}' is missing effect_evidence — cause: effect_unverified`,
      };
    }
    if (effect.type === 'ack_only' || !effect.type) {
      return {
        rule: 'R14',
        severity: 'CRITICAL',
        reason: `scenario '${scenario?.name ?? '(unnamed)'}' has invalid effect_evidence.type='${effect.type ?? ''}' — cause: effect_unverified`,
      };
    }
    if (!effect.reference) {
      return {
        rule: 'R14',
        severity: 'CRITICAL',
        reason: `scenario '${scenario?.name ?? '(unnamed)'}' has empty effect_evidence.reference — cause: effect_unverified`,
      };
    }
  }
  return null;
}

// R15 — Stage-skipping code edit. When the agent edits source code but
// current_stage != 'workflow-coding' AND the mode allows 'workflow-coding',
// block with guidance so the agent invokes the proper Skill first. This is
// the "watchdog prevents stage skipping" enforcement (see workflow-chain
// enforcement plan §D4). Distinct from R12 (null-stage bypass) and R05
// (coding stage entered without RED cycle).
export function rule15_stageSkipOnCodeEdit(input, state) {
  if (!state) return null;
  if (input.tool_name !== 'Edit' && input.tool_name !== 'Write') return null;
  const target = input.tool_input?.file_path || '';
  if (!target) return null;

  // Normalize relative path, strip cwd prefix if present.
  const rel = target;
  const base = (rel.split('/').pop() || '').toLowerCase();

  // Exempt test / spec files — TDD-first writes must pass.
  const isTest = /\.test\.|\.spec\./.test(base)
    || /^test[-_]/.test(base)
    || /[-_]test\./.test(base)
    || /\/tests?\//.test(rel)
    || /\/spec\//.test(rel)
    || /\/__tests__\//.test(rel);
  if (isTest) return null;

  // Only trigger on recognizable source-code paths.
  const isCode =
    /(?:^|\/)(?:src|scripts|bin|lib|hooks)\//.test(rel) ||
    // Smelter self-edits count as code.
    (/(?:skills|scripts|document)\//.test(rel) && (input.cwd || '').includes('/Smelter'));
  if (!isCode) return null;

  // Skip if mode does not allow workflow-coding (e.g., plan mode terminates
  // before any coding skill). In that case R12 / R06 govern.
  const allowed = Array.isArray(state.allowed_skills) ? state.allowed_skills : [];
  if (!allowed.includes('workflow-coding')) return null;

  // Stage must be in workflow-coding OR the preparatory workflow-write-test.
  // write-test may edit test files but NOT source code — test-file exemption
  // above already covers that. Source-code edits during write-test still
  // violate.
  if (state.current_stage === 'workflow-coding') return null;

  return {
    rule: 'R15',
    severity: 'CRITICAL',
    reason: `code edit at ${rel} but current_stage='${state.current_stage}' — invoke Skill(skill: 'workflow-coding') first to enter the coding stage (stage-skip forbidden)`,
  };
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

function readActiveState(cwd, sessionId) {
  // Session-isolated: per-session pointer primary, non-scoped pointer as
  // session-less fallback (legacy CLI / sim only). Global `.smt/active_task`
  // was deprecated in the session-isolation migration — concurrent sessions
  // would overwrite it.
  const pointerPath = sessionId
    ? join(cwd, '.smt', 'state', `active-feature-${sessionId}.json`)
    : join(cwd, '.smt', 'state', 'active-feature.json');
  if (!existsSync(pointerPath)) return null;
  try {
    const ptr = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    if (!ptr?.slug) return null;
    const candidate = join(cwd, '.smt', 'features', ptr.slug, 'task', `${ptr.slug}.state.json`);
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf-8'));
  } catch {}
  return null;
}

// ===== Main =====

export const RULES = [
  rule01_testFileDelete, rule02_noVerifyOrForce, rule03_secretsAccess,
  rule04_unresolvedFeedbackComplete, rule05_tddCycleBeforeCoding,
  rule06_whitelistViolation, rule07_scopeLeak, rule08_evasionPatterns,
  rule09_parallelFileConflict, rule10_sessionLogMissing,
  rule11_e2ePassWithoutArtifacts,
  rule12_workflowStageRequired,
  rule13_bashStateJsonWrite,
  rule14_e2ePassWithoutEffectEvidence,
  rule15_stageSkipOnCodeEdit,
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
  const state = readActiveState(cwd, input.session_id);
  const hits = runAll(input, state, cwd);

  const critical = hits.find(h => h.severity === 'CRITICAL');
  if (critical) {
    emitBlock(critical.rule, 'CRITICAL', critical.reason);
    process.exit(2);
  }

  const high = hits.filter(h => h.severity === 'HIGH');
  if (high.length) {
    emitWarn(high.map(h => h.rule).join(','), 'HIGH', high.map(h => h.reason).join('; '));
    process.exit(0);
  }

  const med = hits.filter(h => h.severity === 'MEDIUM');
  if (med.length) {
    emitWarn(med.map(h => h.rule).join(','), 'MEDIUM', med.map(h => h.reason).join('; '));
  }
  process.exit(0);
}
