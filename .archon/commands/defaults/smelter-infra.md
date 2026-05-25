# Smelter: /infra — Infrastructure Operations

Run the `infra` mode on $ARGUMENTS. Use for cloud/resource operations, infrastructure-as-code edits, deploy-resource changes, and destructive actions such as teardown, stack removal, bucket/table deletion, IAM/domain changes, or Serverless/Terraform/Pulumi/CloudFormation operations.

Backed by the Archon-native `smelter-infra` workflow. Pipeline `infra_ops`: investigate → investigate-review → infra-plan → infra-plan-review → infra-execute → verify → human-check.

## Task
$ARGUMENTS

## Protocol

1. Inventory first: identify accounts, profiles, regions, stacks, resources, data stores, and ownership boundaries.
2. Write `infra-plan.md` before running mutating infrastructure commands.
3. For destructive or shared infrastructure, get explicit user approval in the plan before execution; if approval is missing, stop at `infra-plan-review`.
4. Execute the smallest scoped action and record commands/results in `infra-execute.md`.
5. Update project-facing infrastructure notes when resources are discovered or changed; use `Infra.md` when the task asks for an infrastructure inventory.
6. Run `workflow-verify`, then `workflow-human-check` before completion or commit.

## Safety Contract

- Do not route infrastructure teardown through `/fix` or `/implement`.
- Do not run destructive cloud commands from a pasted transcript alone; confirm scope, account/profile, region/stage, backup/export needs, and excluded resources.
- Prefer read/list/dry-run commands before mutation.
- Never touch explicitly read-only external data systems unless the user separately authorizes that exact system and operation.
