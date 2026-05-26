#!/usr/bin/env node
// Standalone Claude Code statusline HUD. No Smelter/Archon state dependencies.
// Renders: model · git branch · context% · session tokens · cost · duration
// Reads the statusline JSON payload on stdin; every segment is best-effort and
// omitted when its data is unavailable, so a partial payload still renders.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const SEP = `${DIM} · ${RESET}`;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function modelLabel(payload) {
  const name = payload?.model?.display_name;
  if (!name) return null;
  // "Opus 4.7 (1M context)" -> "Opus 4.7"
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim() || null;
}

function gitBranch(cwd) {
  if (!cwd) return null;
  try {
    const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

// Sum every assistant turn's token usage in the current session transcript.
// Returns { sessionTokens, lastContextTokens } where lastContextTokens is the
// most recent turn's input-side total (≈ current context fill).
function readTranscript(path) {
  if (!path) return { sessionTokens: 0, lastContextTokens: 0 };
  let sessionTokens = 0;
  let lastContextTokens = 0;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const u = row?.message?.usage;
      if (!u) continue;
      const input = u.input_tokens ?? 0;
      const output = u.output_tokens ?? 0;
      const cacheCreate = u.cache_creation_input_tokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      sessionTokens += input + output + cacheCreate + cacheRead;
      const contextTokens = input + cacheCreate + cacheRead;
      if (contextTokens > 0) lastContextTokens = contextTokens;
    }
  } catch {
    /* unreadable transcript */
  }
  return { sessionTokens, lastContextTokens };
}

function contextPercent(payload, lastContextTokens) {
  const cw = payload?.context_window;
  // Prefer values Claude Code computes when present.
  if (typeof cw?.used_percentage === "number") return Math.round(cw.used_percentage);
  const size = cw?.context_window_size || (/\[1m\]/i.test(payload?.model?.id ?? "") ? 1_000_000 : 200_000);
  const used = typeof cw?.current_usage === "number" ? cw.current_usage : lastContextTokens;
  if (!used || !size) return null;
  return Math.round((used / size) * 100);
}

function colorForPercent(pct) {
  if (pct >= 80) return RED;
  if (pct >= 50) return YELLOW;
  return GREEN;
}

function formatTokens(n) {
  if (!n) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function formatCost(payload) {
  const usd = payload?.cost?.total_cost_usd;
  if (typeof usd !== "number") return null;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(payload) {
  const ms = payload?.cost?.total_duration_ms;
  if (typeof ms !== "number" || ms <= 0) return null;
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return null;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  return `${m}m`;
}

function main() {
  const payload = readStdin();
  const cwd = payload?.workspace?.current_dir || payload?.cwd;
  const { sessionTokens, lastContextTokens } = readTranscript(payload?.transcript_path);

  const segments = [];

  const model = modelLabel(payload);
  if (model) segments.push(model);

  const branch = gitBranch(cwd);
  if (branch) segments.push(branch);

  const pct = contextPercent(payload, lastContextTokens);
  if (pct !== null) segments.push(`${colorForPercent(pct)}${pct}%${RESET}`);

  const tokens = formatTokens(sessionTokens || (payload?.context_window?.total_input_tokens ?? 0) + (payload?.context_window?.total_output_tokens ?? 0));
  if (tokens) segments.push(`${DIM}${tokens}${RESET}`);

  const cost = formatCost(payload);
  if (cost) segments.push(`${DIM}${cost}${RESET}`);

  const duration = formatDuration(payload);
  if (duration) segments.push(`${DIM}${duration}${RESET}`);

  process.stdout.write(segments.join(SEP));
}

main();
