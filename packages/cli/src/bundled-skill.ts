/**
 * Bundled Smelter skill files for binary distribution
 *
 * These static imports are resolved at compile time and embedded into the binary.
 * When running as a standalone binary (without Bun), these provide the skill files
 * without needing filesystem access to the source repo.
 *
 * Import syntax uses `with { type: 'text' }` to import file contents as strings.
 */

// =============================================================================
// Skill Files (21 total)
// =============================================================================

import skillMd from '../../../.claude/skills/smelter/SKILL.md' with { type: 'text' };
import commandTemplate from '../../../.claude/skills/smelter/examples/command-template.md' with { type: 'text' };
import dagWorkflow from '../../../.claude/skills/smelter/examples/dag-workflow.yaml' with { type: 'text' };
import cliGuide from '../../../.claude/skills/smelter/guides/cli.md' with { type: 'text' };
import configGuide from '../../../.claude/skills/smelter/guides/config.md' with { type: 'text' };
import discordGuide from '../../../.claude/skills/smelter/guides/discord.md' with { type: 'text' };
import githubGuide from '../../../.claude/skills/smelter/guides/github.md' with { type: 'text' };
import serverGuide from '../../../.claude/skills/smelter/guides/server.md' with { type: 'text' };
import setupGuide from '../../../.claude/skills/smelter/guides/setup.md' with { type: 'text' };
import slackGuide from '../../../.claude/skills/smelter/guides/slack.md' with { type: 'text' };
import telegramGuide from '../../../.claude/skills/smelter/guides/telegram.md' with { type: 'text' };
import authoringCommands from '../../../.claude/skills/smelter/references/authoring-commands.md' with { type: 'text' };
import cliCommands from '../../../.claude/skills/smelter/references/cli-commands.md' with { type: 'text' };
import dagAdvanced from '../../../.claude/skills/smelter/references/dag-advanced.md' with { type: 'text' };
import goodPractices from '../../../.claude/skills/smelter/references/good-practices.md' with { type: 'text' };
import interactiveWorkflows from '../../../.claude/skills/smelter/references/interactive-workflows.md' with { type: 'text' };
import parameterMatrix from '../../../.claude/skills/smelter/references/parameter-matrix.md' with { type: 'text' };
import repoInit from '../../../.claude/skills/smelter/references/repo-init.md' with { type: 'text' };
import troubleshooting from '../../../.claude/skills/smelter/references/troubleshooting.md' with { type: 'text' };
import variables from '../../../.claude/skills/smelter/references/variables.md' with { type: 'text' };
import workflowDag from '../../../.claude/skills/smelter/references/workflow-dag.md' with { type: 'text' };

// =============================================================================
// Export
// =============================================================================

/**
 * Bundled skill files - relative path within .claude/skills/smelter/ -> content
 */
export const BUNDLED_SKILL_FILES: Record<string, string> = {
  'SKILL.md': skillMd,
  'examples/command-template.md': commandTemplate,
  'examples/dag-workflow.yaml': dagWorkflow,
  'guides/cli.md': cliGuide,
  'guides/config.md': configGuide,
  'guides/discord.md': discordGuide,
  'guides/github.md': githubGuide,
  'guides/server.md': serverGuide,
  'guides/setup.md': setupGuide,
  'guides/slack.md': slackGuide,
  'guides/telegram.md': telegramGuide,
  'references/authoring-commands.md': authoringCommands,
  'references/cli-commands.md': cliCommands,
  'references/dag-advanced.md': dagAdvanced,
  'references/good-practices.md': goodPractices,
  'references/interactive-workflows.md': interactiveWorkflows,
  'references/parameter-matrix.md': parameterMatrix,
  'references/repo-init.md': repoInit,
  'references/troubleshooting.md': troubleshooting,
  'references/variables.md': variables,
  'references/workflow-dag.md': workflowDag,
};
