import type { HarnessRule } from '../types.js';

export const DEFAULT_RULES: HarnessRule[] = [
  {
    id: 'e2e-on-complete',
    name: 'E2E on Complete',
    description: 'Automatically run E2E tests when Claude finishes coding',
    trigger: 'on-complete',
    enabled: true,
  },
  {
    id: 'e2e-retry-on-fail',
    name: 'Auto-fix on E2E Fail',
    description: 'Send E2E failures back to Claude for automatic fix',
    trigger: 'on-e2e-result',
    enabled: true,
  },
  {
    id: 'card-on-e2e',
    name: 'Card on E2E Complete',
    description: 'Create a Kanban card with E2E results automatically',
    trigger: 'on-e2e-result',
    enabled: true,
  },
  {
    id: 'system-prompt-inject',
    name: 'Harness Context Injection',
    description: 'Inject E2E requirement reminder into every chat session',
    trigger: 'on-keyword',
    enabled: true,
  },
  {
    id: 'tdd-enforce',
    name: 'TDD Enforce',
    description: 'Force test-first development (RED → GREEN → REFACTOR)',
    trigger: 'on-complete',
    enabled: true,
  },
  {
    id: 'task-on-start',
    name: 'Task on Start',
    description: 'Auto-create task card when development begins',
    trigger: 'on-keyword',
    enabled: true,
  },
  {
    id: 'review-on-e2e',
    name: 'Review on E2E',
    description: 'Move task to Review after E2E completion with artifacts',
    trigger: 'on-e2e-result',
    enabled: true,
  },
  {
    id: 'save-artifacts',
    name: 'Save Artifacts',
    description: 'Save video/screenshots/logs to .linear-harness/e2e-results/',
    trigger: 'on-e2e-result',
    enabled: true,
  },
];

export const TDD_E2E_SYSTEM_PROMPT = `[LINEAR HARNESS — TDD + E2E MODE]
You MUST follow Test-Driven Development:
1. Write tests FIRST (RED) — before any implementation code
2. Run tests — they MUST fail initially
3. Write minimal code to pass tests (GREEN)
4. Refactor (IMPROVE)
5. After all code changes, E2E tests will run automatically
6. E2E results will be captured with video and screenshots
7. Results go to review for user approval

CRITICAL RULES:
- NEVER write implementation before tests
- ALWAYS create test file before source file
- If tests don't exist for a feature, write them first
- E2E tests are mandatory — they will run automatically after your changes`;

export const CAVEMAN_SYSTEM_PROMPT = `[RESPONSE STYLE: CONCISE]
Remove filler words, pleasantries, and hedging from all responses.
Keep articles, grammar, and complete sentences intact.
Technical terms, code blocks, and error messages must be exact and unchanged.
If safety warnings, security issues, or irreversible actions are involved, use full clear prose regardless of this instruction.
Higher-priority task instructions take precedence over this style instruction.`;

export const HARNESS_CONFIG = {
  maxRetries: 3,
  systemPrompt: `[LINEAR HARNESS — E2E MODE]
You MUST follow Test-Driven Development:
1. Write tests FIRST (RED) — before any implementation
2. Run tests — they MUST fail initially
3. Write minimal code to pass tests (GREEN)
4. Refactor (IMPROVE)
5. After all code changes, E2E tests will run automatically

Rules:
- Never skip writing tests
- Test file must exist before implementation file
- E2E tests will capture video and screenshots
- Results go to review for user approval`,
} as const;

export const E2E_MAX_RETRIES = 3;

export const E2E_CONFIG = {
  defaultTimeout: 60000,
  videoDir: 'test-results/videos',
  screenshotDir: 'test-results/screenshots',
} as const;
