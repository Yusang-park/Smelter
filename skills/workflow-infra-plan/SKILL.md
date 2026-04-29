---
name: workflow-infra-plan
version: 0.55
type: workflow
consumes: investigation.md
produces: infra-plan.md
default_pattern: C
default_agent: architect
can_delegate_to: [architect, security-reviewer, researcher]
gate:
  postcondition:
    - file_exists: "infra-plan.md"
    - inventory_recorded: true
    - risk_and_backup_plan_recorded: true
    - destructive_approval_required_when_applicable: true
---

# workflow-infra-plan

## Overview

Turns infrastructure investigation into an executable operations plan. This mode is for cloud resources, infrastructure-as-code, deploy/runtime resources, and teardown/provisioning work.

Announce at start: "I'm using workflow-infra-plan because this affects infrastructure, not product-code TDD."

## Required Plan Content

Write `infra-plan.md` with:

- `## Goal` — requested infrastructure outcome.
- `## Inventory` — accounts/profiles, regions, stages, stacks, services, resource names, and ownership evidence.
- `## Scope` — exact resources in scope and out of scope.
- `## Risk` — destructive effects, data loss, downtime, shared-resource impact, permission risk.
- `## Backup / Export` — backups, snapshots, exports, or explicit reason none applies.
- `## Execution Plan` — exact commands, expected outputs, and ordering.
- `## Verification Plan` — read/list/health checks after execution.
- `## Documentation Updates` — files such as `Infra.md` that must record discovered/changed infrastructure.
- `## Approval Gate` — explicit user approval requirement when the plan mutates shared or destructive infrastructure.

## Rules

- Read/list before mutate.
- Prefer dry-run/plan modes where tools support them.
- Ask one concise confirmation only when the next step is destructive, irreversible, or credential/account scoped.
- Do not use `workflow-write-test`; infrastructure work is TDD-exempt by contract.

## Terminal State — Required Next Skill

**REQUIRED NEXT SKILL:** `workflow-infra-plan-review`
