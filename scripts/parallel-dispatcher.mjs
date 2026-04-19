#!/usr/bin/env node
/**
 * parallel-dispatcher.mjs — Pattern C Parallel Delegation orchestrator.
 *
 * workflow-v2.md §12-5. Given a skill's team_runtime config, produce
 * the list of parallel tasks + sync point + aggregator spec.
 *
 * This script does NOT execute the agents (that's the harness's job).
 * It computes the dispatch plan from state.json + SKILL.md templates.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_ROOT_DEFAULT = join(process.cwd(), 'skills');

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-z_][a-z0-9_]*):\s*(.*)$/i);
    if (!mm) continue;
    const [, k, v] = mm;
    out[k] = v.trim();
  }
  return out;
}

function parseSkillTemplate(skillName, skillsRoot = SKILLS_ROOT_DEFAULT) {
  const path = join(skillsRoot, skillName, 'SKILL.md');
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf-8');
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};
  // naive YAML-ish parser for our known fields
  const body = fm[1];
  const result = {
    name: skillName,
    default_pattern: extractScalar(body, 'default_pattern') || 'A',
    default_agent: extractScalar(body, 'default_agent') || 'executor',
    supports_patterns: extractList(body, 'supports_patterns') || ['A'],
    team_template: parseTeamTemplate(body),
  };
  return result;
}

function extractScalar(body, key) {
  const m = body.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

function extractList(body, key) {
  const m = body.match(new RegExp(`^${key}:\\s*\\[([^\\]]+)\\]`, 'm'));
  if (!m) return null;
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
}

function parseTeamTemplate(body) {
  // Best-effort: capture "team_template:\n  C:\n    ..." block
  const templates = {};
  const blockRe = /^team_template:\s*\n([\s\S]*?)(?=\n[a-z_]+:|\n---|$)/m;
  const bm = body.match(blockRe);
  if (!bm) return templates;
  const block = bm[1];
  const patternBlocks = block.split(/\n(?=\s{2}[A-E]:)/);
  for (const pb of patternBlocks) {
    const pm = pb.match(/^\s*([A-E]):\s*\n([\s\S]*)$/);
    if (!pm) continue;
    const [, pid, cfg] = pm;
    const entry = {};
    for (const line of cfg.split('\n')) {
      const lm = line.match(/^\s+([a-z_]+):\s*(.+)$/);
      if (!lm) continue;
      entry[lm[1]] = lm[2].trim().replace(/^['"]|['"]$/g, '');
    }
    templates[pid] = entry;
  }
  return templates;
}

/**
 * Build dispatch plan for a skill.
 * state.team_runtime[skill] + SKILL.md template → concrete agent plan.
 */
export function buildDispatchPlan(skillName, state, skillsRoot) {
  const template = parseSkillTemplate(skillName, skillsRoot);
  const runtime = (state?.team_runtime || {})[skillName];
  const pattern = runtime?.pattern || template?.default_pattern || 'A';

  const plan = {
    skill: skillName,
    pattern,
    tasks: [],
    sync_point: null,
    aggregator: null,
    conflict_resolver: null,
  };

  if (pattern === 'A') {
    const agent = runtime?.assigned_agents?.[0]?.agent_type || template?.default_agent || 'executor';
    plan.tasks = [{ id: 'single', agent, scope: 'full' }];
    return plan;
  }

  if (pattern === 'C') {
    const tpl = template?.team_template?.C || {};
    const agents = runtime?.assigned_agents || [];
    plan.tasks = agents.length > 0
      ? agents.map(a => ({ id: a.id, agent: a.agent_type, scope: a.area || a.scope || 'unknown' }))
      : [{ id: 'default', agent: template?.default_agent || 'executor', scope: 'full' }];
    plan.sync_point = tpl.sync_point || runtime?.sync_point || 'merge';
    plan.aggregator = tpl.aggregator || runtime?.aggregator || 'architect';
    plan.conflict_resolver = tpl.conflict_resolver || 'conflict-resolver';
    return plan;
  }

  if (pattern === 'B') {
    const tpl = template?.team_template?.B || {};
    const agents = runtime?.assigned_agents || [];
    plan.tasks = agents.map(a => ({ id: a.id, agent: a.agent_type, scope: 'review' }));
    plan.aggregator = tpl.aggregator || runtime?.aggregator || 'arbitrator';
    plan.consensus_threshold = parseFloat(tpl.consensus_threshold) || 0.95;
    plan.max_rounds = parseInt(tpl.max_rounds) || 5;
    return plan;
  }

  if (pattern === 'D') {
    const tpl = template?.team_template?.D || {};
    plan.lead = tpl.lead || runtime?.lead || template?.default_agent;
    plan.sub_agents = runtime?.sub_agents || [];
    plan.tasks = [{ id: 'lead', agent: plan.lead, scope: 'direction' }];
    for (const sub of plan.sub_agents) {
      plan.tasks.push({ id: `sub-${sub}`, agent: sub, scope: 'delegated' });
    }
    return plan;
  }

  return plan;
}

/**
 * Check if sync point is reached (all parallel agents done).
 */
export function isSyncPointReached(skillName, state) {
  const runtime = (state?.team_runtime || {})[skillName];
  if (!runtime || runtime.pattern !== 'C') return true;  // non-parallel is auto-synced
  const agents = runtime.assigned_agents || [];
  if (agents.length === 0) return false;
  return agents.every(a => a.status === 'done' || a.status === 'failed');
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const skill = process.argv[2];
  const statePath = process.argv[3];
  if (!skill) { console.error('usage: parallel-dispatcher.mjs <skill> [state.json]'); process.exit(2); }
  const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf-8')) : null;
  const plan = buildDispatchPlan(skill, state);
  console.log(JSON.stringify(plan, null, 2));
}
