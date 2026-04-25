#!/usr/bin/env node

function isSourcePath(filePath) {
  if (!filePath) return false;
  if (/[\/\\]\.smt[\/\\]/.test(filePath)) return false;
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|pl|java|kt|kts|scala|groovy|c|cc|cpp|cxx|h|hh|hpp|hxx|swift|m|mm|sh|bash|zsh|fish|sql|prisma|graphql|gql|toml|vue|svelte|astro|css|scss|sass|less|html|htm|xml|tf|tfvars|lua|r|jl|dart|ex|exs|erl|clj|cljs)$/i.test(filePath);
}

function isTestPath(filePath) {
  const path = String(filePath || '');
  return /(?:^|[\/\\])(?:test|tests|spec|e2e)[\/\\]/i.test(path) ||
    /(?:^|[\/\\])[^\/\\]+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|sh)$/i.test(path);
}

function isArtifactPath(filePath) {
  return /[\/\\]\.smt[\/\\]features[\/\\][^\/\\]+[\/\\](?:task|artifacts)[\/\\]/.test(String(filePath || ''));
}

function isWriteTool(toolName) {
  return ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName);
}

function looksLikeGitCommit(command) {
  return /(^|[\s;&|])(?:[\w/.-]*\/)?git(?:\s+-C\s+\S+)?\s+commit\b/i.test(String(command || ''));
}

function hasRedTest(state) {
  const hasV4RedEvent = Array.isArray(state?.events) && state.events.some((e) => e?.type === 'test_red');
  const hasLegacyRedCycle = Array.isArray(state?.test_cycles) && state.test_cycles.some((c) =>
    c?.run_result === 'fail' && ['added_case', 'modified_case'].includes(c?.action)
  );
  return hasV4RedEvent || hasLegacyRedCycle;
}

export function evaluateToolUse(state, { toolName, filePath = '', command = '' } = {}) {
  if (!state) return { decision: 'allow', reason: 'no v0.4 state' };

  if (toolName === 'Bash' && looksLikeGitCommit(command)) {
    if (['write', 'freeform'].includes(state.task_type) && state.step !== 'DONE') {
      return { decision: 'block', reason: `git commit blocked until HUMAN_CHECK passes (task_type=${state.task_type}, step=${state.step})` };
    }
    return { decision: 'allow', reason: 'commit allowed' };
  }

  if (!isWriteTool(toolName)) return { decision: 'allow', reason: 'non-write tool' };

  if (isArtifactPath(filePath)) {
    if (state.allowed_actions?.includes('write_artifact')) return { decision: 'allow', reason: 'artifact write allowed' };
    return { decision: 'block', reason: `artifact write not allowed at step=${state.step}` };
  }

  if (isSourcePath(filePath)) {
    if (state.task_type === 'read') return { decision: 'block', reason: 'source write blocked for task_type=read' };
    if (state.task_type === 'design') return { decision: 'block', reason: 'source write blocked for task_type=design' };
    if (state.task_type === 'verify') return { decision: 'block', reason: 'source write blocked for task_type=verify' };
    if (state.task_type === 'write') {
      if (isTestPath(filePath)) {
        if (state.step === 'TEST_DESIGN' && state.allowed_actions?.includes('write_test')) {
          return { decision: 'allow', reason: 'test write allowed during TEST_DESIGN' };
        }
        return { decision: 'block', reason: `test write blocked at step=${state.step}` };
      }
      if (state.step !== 'EXECUTE') return { decision: 'block', reason: `source write blocked at step=${state.step}` };
      if (!hasRedTest(state)) return { decision: 'block', reason: 'source write requires red test evidence before EXECUTE' };
      return { decision: 'allow', reason: 'write EXECUTE with red test evidence' };
    }
    if (state.task_type === 'freeform') {
      if (state.step === 'EXECUTE') return { decision: 'allow', reason: 'freeform execute write allowed' };
      return { decision: 'block', reason: `freeform write blocked at step=${state.step}` };
    }
  }

  return { decision: 'allow', reason: 'ungated write surface' };
}
