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
    description: 'Create a Blueprint card with E2E results automatically',
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
    description: 'Save video/screenshots/logs to .smt/features/<slug>/artifacts/',
    trigger: 'on-e2e-result',
    enabled: true,
  },
  {
    id: 'caveman-compress',
    name: 'Caveman Token Compress',
    description: 'Reduce output tokens ~75% using caveman-speak while preserving technical accuracy',
    trigger: 'on-keyword',
    enabled: true,
  },
];

export const TDD_E2E_SYSTEM_PROMPT = `[SMELTER — TDD + E2E MODE]
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
- E2E tests are mandatory — they will run automatically after your changes
- Keep files focused. Avoid creating files over 500 lines unless truly unavoidable.
- Prefer extending existing structure over duplicating logic.
- Do not add fallback branches that silently mask missing data or broken assumptions.

STEP OUTPUT (REQUIRED):
When entering each workflow step, output a header in English:
  "--- Step N: [Step Name] ---"
Followed by one line describing the step goal.
Example: "--- Step 3: Planning ---"
         "Goal: Create implementation plan with checkbox task tree."

SCOPED E2E (REQUIRED):
Only run E2E tests related to changed files — NOT the full test suite.
1. Identify changed files: git diff --name-only
2. Map to related E2E spec files
3. Run only those specs: npx playwright test <spec1> <spec2>
Full regression only when explicitly requested.`;

export const CAVEMAN_SYSTEM_PROMPT = `[RESPONSE STYLE: CONCISE]
Remove filler words, pleasantries, and hedging from all responses.
Keep articles, grammar, and complete sentences intact.
Technical terms, code blocks, and error messages must be exact and unchanged.
If safety warnings, security issues, or irreversible actions are involved, use full clear prose regardless of this instruction.
Higher-priority task instructions take precedence over this style instruction.`;

export const HARNESS_CONFIG = {
  maxRetries: 3,
  systemPrompt: `[SMELTER — WORKFLOW MODE]
Follow the 11-step workflow defined in core/WORKFLOW.md.

TDD RULES:
- Write tests FIRST (RED) — before any implementation
- Run tests — they MUST fail initially
- Write minimal code to pass tests (GREEN)
- Refactor (IMPROVE)
- Minimum 10 tests per feature (use tdd-linear skill)

GLOBAL EXECUTION RULES:
- Keep files focused; avoid creating files over 500 lines unless there is a clear reason.
- Prefer reuse over duplicate implementations.
- Do not hide failures behind fallback chains. Missing data and invalid states should be handled explicitly.

STEP OUTPUT (REQUIRED):
When entering each workflow step, output in English:
  "--- Step N: [Step Name] ---"
  "Goal: <one-line description>"

SCOPED E2E (REQUIRED):
Only run E2E tests for changed files. Never run the full suite unless asked.
  git diff --name-only → identify affected specs → run only those

ARTIFACTS:
- Frontend: video + screenshots required
- Backend/API: log file required`,
} as const;

export const E2E_MAX_RETRIES = 3;

export const E2E_CONFIG = {
  defaultTimeout: 60000,
  videoDir: 'test-results/videos',
  screenshotDir: 'test-results/screenshots',
} as const;
