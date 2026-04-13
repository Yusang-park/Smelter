#!/usr/bin/env node
// session-start-archon.mjs
// Injects TDD + caveman context at session start

const TDD_CONTEXT = `[ARCHON HARNESS — TDD + E2E MODE]
You MUST follow Test-Driven Development:
1. Write tests FIRST (RED) — before any implementation code
2. Run tests — they MUST fail initially
3. Write minimal code to pass tests (GREEN)
4. Refactor (IMPROVE)
5. After all code changes, E2E tests will run automatically

CRITICAL RULES:
- NEVER write implementation before tests
- ALWAYS create test file before source file
- If tests don't exist for a feature, write them first
- E2E tests are mandatory — they will run automatically after your changes`;

const CAVEMAN_CONTEXT = `[RESPONSE STYLE: CONCISE]
Remove filler words, pleasantries, and hedging from all responses.
Keep articles, grammar, and complete sentences intact.
Technical terms, code blocks, and error messages must be exact and unchanged.
If safety warnings, security issues, or irreversible actions are involved, use full clear prose regardless.`;

process.stdout.write(JSON.stringify({
  type: 'system_prompt_prefix',
  content: CAVEMAN_CONTEXT + '\n\n' + TDD_CONTEXT,
}));
