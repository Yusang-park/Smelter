#!/usr/bin/env node

import yaml from 'js-yaml';

const VERSION = '0.51';

const TASK_CHECKS = Object.freeze(['goal', 'approach', 'queue', 'works', 'omissions', 'verified', 'team_runtime']);
const TASK_COMPLETED_CHECKS = Object.freeze(['goal', 'approach', 'works', 'omissions', 'verified', 'team_runtime']);
const REVIEW_CHECKS = Object.freeze(['works', 'omissions', 'verified', 'side_effects', 'decision']);

function splitFrontmatter(text) {
  const raw = String(text || '');
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { frontmatter: null, body: raw };
  try {
    return { frontmatter: yaml.load(match[1]) || {}, body: raw.slice(match[0].length) };
  } catch {
    return { frontmatter: null, body: raw.slice(match[0].length) };
  }
}

function checkboxMap(body) {
  const checks = new Map();
  const re = /^\s*-\s*\[([ xX])\]\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/gm;
  for (const match of body.matchAll(re)) {
    checks.set(match[2].toLowerCase(), match[1].toLowerCase() === 'x');
  }
  return checks;
}

function requireVersion(frontmatter, errors) {
  if (String(frontmatter?.schema_version ?? '') !== VERSION) {
    errors.push(`schema_version must be ${VERSION}`);
  }
}

function requireChecks(checks, required, errors) {
  if (checks.size === 0) errors.push('checkbox checklist is required');
  for (const key of required) {
    if (!checks.has(key)) errors.push(`missing checkbox: ${key}`);
  }
}

function requireChecked(checks, required, errors, prefix = '') {
  for (const key of required) {
    if (checks.has(key) && !checks.get(key)) errors.push(`${prefix}requires checked checkbox: ${key}`);
  }
}

export function validateTaskArtifact(text) {
  const errors = [];
  const { frontmatter, body } = splitFrontmatter(text);
  requireVersion(frontmatter, errors);
  if (!frontmatter || typeof frontmatter.target_type !== 'string' || frontmatter.target_type.trim() === '') {
    errors.push('target_type frontmatter is required');
  }
  const checks = checkboxMap(body);
  requireChecks(checks, TASK_CHECKS, errors);
  requireChecked(checks, TASK_COMPLETED_CHECKS, errors);
  return errors;
}

export function validateTaskReviewArtifact(text) {
  const errors = [];
  const { frontmatter, body } = splitFrontmatter(text);
  requireVersion(frontmatter, errors);
  const verdict = String(frontmatter?.verdict ?? '');
  if (!/^(pass|fail|reshape)$/.test(verdict)) errors.push('verdict must be pass, fail, or reshape');
  if (verdict === 'pass' && Number(frontmatter?.consensus ?? 0) < 0.95) {
    errors.push('pass verdict requires consensus >= 0.95');
  }
  const checks = checkboxMap(body);
  requireChecks(checks, REVIEW_CHECKS, errors);
  if (verdict === 'pass') {
    requireChecked(checks, REVIEW_CHECKS, errors, 'pass verdict ');
  }
  return errors;
}
