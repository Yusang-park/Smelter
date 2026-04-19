# Plan: {{FEATURE_NAME}}

## Goal
{{ONE_LINE_GOAL}}

## Background
{{CONTEXT_AND_WHY}}

## Scope
### In scope
- 

### Out of scope
- 

## Architecture Decision
{{KEY_TECHNICAL_DECISIONS}}

## Phases

### Phase 1: Setup
- [ ] 

### Phase 2: Core Implementation
- [ ] 

### Phase 3: Tests
- [ ] Unit tests
- [ ] Integration tests
- [ ] E2E tests

### Phase 4: Verification
- [ ] `tsc --noEmit` passes
- [ ] All tests green
- [ ] E2E passes

## Risks
| Risk | Mitigation |
|------|-----------|
| | |

## Automation Summary Contract
- Human-readable plan/checklists live in markdown documents.
- Machine-readable automation state lives in `.smt/features/<slug>/state/summary.json`.
- Hooks should prefer `summary.json` over scanning large task documents for E2E/test/review gating.

## Dependencies
- 

---
Created: {{DATE}}
