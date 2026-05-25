#!/usr/bin/env node

import { evaluatePhaseToolUse } from './phase-gate.mjs';

export function evaluateToolUse(state, { toolName, filePath = '', command = '' } = {}) {
  return evaluatePhaseToolUse(state, { toolName, filePath, command });
}
