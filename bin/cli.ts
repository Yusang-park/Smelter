#!/usr/bin/env tsx
import { runWithTask } from '../src/engine.js';
import { loadTasks, findTask, updateTask, createTask, getTasksByColumn } from '../src/store.js';
import { runPlaywright } from '../src/runners/playwright.js';
import { saveArtifacts } from '../src/artifacts.js';
import { loadProjectMemory, autoDetectAndSave, addNote, addDirective } from '../src/project-memory.js';
import { listSkills, loadSkill } from '../src/skill-loader.js';
import { listAgents, loadAgent } from '../src/agent-loader.js';
import { listWorkflows, loadWorkflow, runWorkflow } from '../src/workflow-engine.js';
import type { TaskColumn } from '../src/store.js';
import type { HarnessMode } from '../src/types.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const harnessRoot = join(__dirname, '..');

const [,, command, subcommand, ...args] = process.argv;
const cwd = process.cwd();

function columnIcon(col: TaskColumn): string {
  switch (col) {
    case 'backlog': return '[B]';
    case 'in-progress': return '[>]';
    case 'review': return '[?]';
    case 'done': return '[v]';
  }
}

async function main() {
  switch (command) {
    case 'run': {
      // Parse flags: --skill <name>, --agent <name>, --model <name>, --mode <mode>
      let skill: string | undefined;
      let agent: string | undefined;
      let model: string | undefined;
      let mode: HarnessMode = 'e2e-force';
      let noCaveman = false;
      const promptParts: string[] = [];

      const allArgs = [subcommand, ...args].filter(Boolean);
      for (let i = 0; i < allArgs.length; i++) {
        if (allArgs[i] === '--skill' && allArgs[i + 1]) {
          skill = allArgs[++i];
        } else if (allArgs[i] === '--agent' && allArgs[i + 1]) {
          agent = allArgs[++i];
        } else if (allArgs[i] === '--model' && allArgs[i + 1]) {
          model = allArgs[++i];
        } else if (allArgs[i] === '--mode' && allArgs[i + 1]) {
          mode = allArgs[++i] as HarnessMode;
        } else if (allArgs[i] === '--no-caveman') {
          noCaveman = true;
        } else {
          promptParts.push(allArgs[i]);
        }
      }

      const prompt = promptParts.join(' ');
      if (!prompt) {
        console.error('Usage: linear-harness run [--skill <name>] [--agent <name>] [--model <m>] [--mode <m>] [--no-caveman] <prompt>');
        process.exit(1);
      }
      console.log(`[linear-harness] Running: "${prompt}"`);
      if (skill) console.log(`[skill] ${skill}`);
      if (agent) console.log(`[agent] ${agent}`);
      console.log(`CWD: ${cwd}\n`);

      const { task, result } = await runWithTask(prompt, cwd, { mode, model, skill, agent, noCaveman: noCaveman || undefined });

      console.log(`\n[Task] ${task.id} — ${task.column}`);
      console.log(`[Result] ${result.status}`);
      if (result.e2eResult) {
        console.log(`[E2E] ${result.e2eResult.passedTests}/${result.e2eResult.totalTests} passed`);
      }
      if (task.videoPath) {
        console.log(`[Video] ${task.videoPath}`);
      }
      console.log(`\nRun 'linear-harness review approve ${task.id}' to approve`);
      process.exit(result.status === 'completed' ? 0 : 1);
      break;
    }

    case 'task': {
      switch (subcommand) {
        case 'create': {
          const title = args.join(' ');
          if (!title) {
            console.error('Usage: linear-harness task create <title>');
            process.exit(1);
          }
          const task = createTask(cwd, title);
          console.log(`[task] Created: ${task.id} — "${task.title}" (${task.column})`);
          break;
        }
        case 'list': {
          const tasks = loadTasks(cwd);
          if (tasks.length === 0) {
            console.log('[task] No tasks found. Run "linear-harness task create <title>"');
            break;
          }

          const columns: TaskColumn[] = ['backlog', 'in-progress', 'review', 'done'];
          for (const col of columns) {
            const colTasks = tasks.filter((t) => t.column === col);
            if (colTasks.length === 0) continue;
            console.log(`\n${columnIcon(col)} ${col.toUpperCase()} (${colTasks.length})`);
            for (const t of colTasks) {
              const badges: string[] = [];
              if (t.videoPath) badges.push('(video)');
              if (t.reviewStatus === 'pending') badges.push('(pending)');
              if (t.reviewStatus === 'approved') badges.push('(approved)');
              if (t.reviewStatus === 'rejected') badges.push('(rejected)');
              console.log(`  ${t.id}  ${t.title} ${badges.join(' ')}`);
            }
          }
          break;
        }
        case 'show': {
          const id = args[0];
          if (!id) {
            console.error('Usage: linear-harness task show <id>');
            process.exit(1);
          }
          const task = findTask(cwd, id);
          if (!task) {
            console.error(`[task] Not found: ${id}`);
            process.exit(1);
          }

          console.log(`ID:       ${task.id}`);
          console.log(`Title:    ${task.title}`);
          console.log(`Column:   ${task.column}`);
          console.log(`Review:   ${task.reviewStatus ?? 'N/A'}`);
          console.log(`Created:  ${new Date(task.createdAt).toLocaleString()}`);
          if (task.videoPath) console.log(`Video:    ${task.videoPath}`);
          if (task.logPath) console.log(`Log:      ${task.logPath}`);
          if (task.reportPath) console.log(`Report:   ${task.reportPath}`);
          if (task.reviewFeedback) console.log(`Feedback: ${task.reviewFeedback}`);
          if (task.prUrl) console.log(`PR:       ${task.prUrl}`);
          if (task.labels.length > 0) console.log(`Labels:   ${task.labels.join(', ')}`);
          break;
        }
        case 'move': {
          const [id, col] = args;
          if (!id || !col) {
            console.error('Usage: linear-harness task move <id> <column>');
            process.exit(1);
          }
          const validCols: TaskColumn[] = ['backlog', 'in-progress', 'review', 'done'];
          if (!validCols.includes(col as TaskColumn)) {
            console.error(`Invalid column. Use: ${validCols.join(', ')}`);
            process.exit(1);
          }
          const task = updateTask(cwd, id, { column: col as TaskColumn });
          if (!task) {
            console.error(`[task] Not found: ${id}`);
            process.exit(1);
          }
          console.log(`[task] ${task.id} -> ${task.column}`);
          break;
        }
        default:
          console.log('Usage: linear-harness task <create|list|show|move>');
      }
      break;
    }

    case 'e2e': {
      console.log(`[linear-harness] Running E2E...`);

      const result = await runPlaywright(cwd);
      console.log(`[E2E] ${result.status} — ${result.passedTests}/${result.totalTests} passed (${result.duration}ms)`);

      for (const test of result.tests) {
        const icon = test.status === 'passed' ? '[pass]' : test.status === 'failed' ? '[FAIL]' : '[skip]';
        console.log(`  ${icon} ${test.name} (${test.duration}ms)`);
        if (test.error) console.log(`     ${test.error}`);
      }

      // Save artifacts if there's an active task
      const tasks = loadTasks(cwd);
      const activeTask = tasks.find((t) => t.column === 'in-progress');
      if (activeTask) {
        const artifacts = saveArtifacts(cwd, activeTask.id, result);
        updateTask(cwd, activeTask.id, {
          videoPath: artifacts.videoPath,
          logPath: artifacts.logPath,
          reportPath: artifacts.reportPath,
          screenshotPaths: artifacts.screenshotPaths,
          column: 'review',
          reviewStatus: 'pending',
        });
        console.log(`\n[task] ${activeTask.id} -> Review (artifacts saved)`);
      }

      process.exit(result.status === 'passed' ? 0 : 1);
      break;
    }

    case 'review': {
      switch (subcommand) {
        case 'list': {
          const reviewTasks = getTasksByColumn(cwd, 'review');
          if (reviewTasks.length === 0) { console.log('[review] No tasks pending review'); break; }
          console.log(`\nREVIEW (${reviewTasks.length})\n`);
          for (const t of reviewTasks) {
            console.log(`  ${t.id}  ${t.title}`);
            if (t.videoPath) console.log(`         Video: ${t.videoPath}`);
          }
          break;
        }
        case 'show': {
          const id = args[0];
          if (!id) { console.error('Usage: linear-harness review show <id>'); process.exit(1); }
          const task = findTask(cwd, id);
          if (!task) { console.error(`[review] Not found: ${id}`); process.exit(1); }
          console.log(`\n${task.title} (${task.id})\nStatus: ${task.reviewStatus}`);
          if (task.videoPath) console.log(`Video:  ${task.videoPath}`);
          if (task.logPath) console.log(`Log:    ${task.logPath}`);
          if (task.reportPath) console.log(`Report: ${task.reportPath}`);
          if (task.screenshotPaths.length > 0) task.screenshotPaths.forEach((sp) => console.log(`  ${sp}`));
          console.log(`\n  linear-harness review approve|reject ${task.id}`);
          break;
        }
        case 'approve': {
          const id = args[0];
          if (!id) { console.error('Usage: linear-harness review approve <id>'); process.exit(1); }
          const task = updateTask(cwd, id, { column: 'done', reviewStatus: 'approved' });
          if (!task) { console.error(`[review] Not found: ${id}`); process.exit(1); }
          console.log(`[review] Approved: ${task.id} — "${task.title}" -> Done`);
          break;
        }
        case 'reject': {
          const id = args[0];
          const feedback = args.slice(1).join(' ') || 'Needs fixes';
          if (!id) { console.error('Usage: linear-harness review reject <id> [feedback]'); process.exit(1); }
          const task = updateTask(cwd, id, { column: 'in-progress', reviewStatus: 'rejected', reviewFeedback: feedback });
          if (!task) { console.error(`[review] Not found: ${id}`); process.exit(1); }
          console.log(`[review] Rejected: ${task.id} -> In Progress (${feedback})`);
          break;
        }
        default:
          console.log('Usage: linear-harness review <list|show|approve|reject>');
      }
      break;
    }

    case 'status': {
      const tasks = loadTasks(cwd);
      const columns: TaskColumn[] = ['backlog', 'in-progress', 'review', 'done'];

      console.log('\nLinear Harness Board Status\n');
      for (const col of columns) {
        const count = tasks.filter((t) => t.column === col).length;
        console.log(`  ${columnIcon(col)} ${col.padEnd(14)} ${count}`);
      }
      console.log(`  ${'─'.repeat(24)}`);
      console.log(`  Total${' '.repeat(12)} ${tasks.length}`);

      const reviewPending = tasks.filter((t) => t.column === 'review' && t.reviewStatus === 'pending');
      if (reviewPending.length > 0) {
        console.log(`\n  ${reviewPending.length} task(s) awaiting review`);
      }
      break;
    }

    case 'init': {
      const linearHarnessDir = join(cwd, '.linear-harness');
      if (existsSync(linearHarnessDir)) {
        console.log('[init] .linear-harness/ already exists');
      } else {
        mkdirSync(linearHarnessDir, { recursive: true });
        mkdirSync(join(linearHarnessDir, 'e2e-results'), { recursive: true });
        writeFileSync(join(linearHarnessDir, 'tasks.json'), JSON.stringify({ tasks: [] }, null, 2));
        writeFileSync(join(linearHarnessDir, 'config.json'), JSON.stringify({
          mode: 'tdd-e2e',
          maxRetries: 3,
          rules: {},
        }, null, 2));
        console.log('[init] Created .linear-harness/ with default config');
      }

      // Auto-detect tech stack and save to project memory
      const memory = autoDetectAndSave(cwd);
      const techKeys = Object.keys(memory.techStack);
      if (techKeys.length > 0) {
        console.log(`[init] Detected tech stack: ${techKeys.join(', ')}`);
      } else {
        console.log('[init] No tech stack detected');
      }
      break;
    }

    case 'list': {
      console.log('[linear-harness] Available presets:');
      console.log('  e2e-force   - Auto-run E2E after every code change');
      console.log('  tdd         - Test-Driven Development enforcement');
      console.log('  tdd-e2e     - TDD + E2E (default)');
      console.log('  autopilot   - Full autonomous: TDD -> code -> E2E -> review -> PR');
      break;
    }

    case 'memory': {
      switch (subcommand) {
        case 'show': {
          const memory = loadProjectMemory(cwd);
          console.log(JSON.stringify(memory, null, 2));
          break;
        }
        case 'detect': {
          const memory = autoDetectAndSave(cwd);
          console.log('[memory] Tech stack detected:');
          for (const [tech, file] of Object.entries(memory.techStack)) {
            console.log(`  ${tech} (${file})`);
          }
          break;
        }
        case 'add-note': {
          const category = args[0];
          const content = args.slice(1).join(' ');
          if (!category || !content) {
            console.error('Usage: linear-harness memory add-note <category> <content>');
            process.exit(1);
          }
          addNote(cwd, category, content);
          console.log(`[memory] Note added: [${category}] ${content}`);
          break;
        }
        case 'add-directive': {
          const directive = args.join(' ');
          if (!directive) {
            console.error('Usage: linear-harness memory add-directive <directive>');
            process.exit(1);
          }
          addDirective(cwd, directive);
          console.log(`[memory] Directive added: ${directive}`);
          break;
        }
        default:
          console.log('Usage: linear-harness memory <show|detect|add-note|add-directive>');
      }
      break;
    }

    case 'skill': {
      switch (subcommand) {
        case 'list': {
          const skills = listSkills();
          if (skills.length === 0) {
            console.log('[skill] No skills found');
            break;
          }
          console.log(`[skill] Installed skills (${skills.length}):\n`);
          for (const s of skills) {
            console.log(`  ${s}`);
          }
          break;
        }
        case 'show': {
          const name = args[0];
          if (!name) {
            console.error('Usage: linear-harness skill show <name>');
            process.exit(1);
          }
          const content = loadSkill(name);
          if (!content) {
            console.error(`[skill] Not found: ${name}`);
            process.exit(1);
          }
          console.log(content);
          break;
        }
        default:
          console.log('Usage: linear-harness skill <list|show>');
      }
      break;
    }

    case 'agent': {
      switch (subcommand) {
        case 'list': {
          const agents = listAgents();
          if (agents.length === 0) {
            console.log('[agent] No agents found');
            break;
          }
          console.log(`[agent] Installed agents (${agents.length}):\n`);
          for (const a of agents) {
            const tag = a.model !== 'sonnet' ? ` (${a.model})` : '';
            console.log(`  ${a.name}${tag}${a.description ? ' — ' + a.description : ''}`);
          }
          break;
        }
        case 'show': {
          const name = args[0];
          if (!name) {
            console.error('Usage: linear-harness agent show <name>');
            process.exit(1);
          }
          const agent = loadAgent(name);
          if (!agent) {
            console.error(`[agent] Not found: ${name}`);
            process.exit(1);
          }
          console.log(agent.content);
          break;
        }
        default:
          console.log('Usage: linear-harness agent <list|show>');
      }
      break;
    }

    case 'autopilot': {
      // Parse optional --model flag
      let autopilotModel: string | undefined;
      const promptParts: string[] = [];
      const allArgs2 = [subcommand, ...args].filter(Boolean);
      for (let i = 0; i < allArgs2.length; i++) {
        if (allArgs2[i] === '--model' && allArgs2[i + 1]) {
          autopilotModel = allArgs2[++i];
        } else {
          promptParts.push(allArgs2[i]);
        }
      }
      const prompt2 = promptParts.join(' ');
      if (!prompt2) {
        console.error('Usage: linear-harness autopilot [--model <m>] <prompt>');
        process.exit(1);
      }
      console.log(`[autopilot] Running workflow: "${prompt2}"`);
      const apResult = await runWorkflow('autopilot', cwd, prompt2, autopilotModel);
      console.log(`\n[autopilot] ${apResult.status} (${(apResult.duration / 1000).toFixed(1)}s)`);
      for (const node of apResult.nodes) {
        const icon = node.status === 'completed' ? '[ok]' : node.status === 'failed' ? '[FAIL]' : '[skip]';
        console.log(`  ${icon} ${node.id} (${(node.duration / 1000).toFixed(1)}s)`);
      }
      process.exit(apResult.status === 'completed' ? 0 : 1);
      break;
    }

    case 'swarm': {
      console.log('[swarm] Deprecated. Use: linear-harness workflow run <name> <prompt>');
      console.log('  Available workflows: linear-harness workflow list');
      process.exit(0);
      break;
    }

    case 'pipeline': {
      console.log('[pipeline] Deprecated. Use: linear-harness workflow run <name> <prompt>');
      console.log('  Available workflows: linear-harness workflow list');
      process.exit(0);
      break;
    }

    case 'workflow': {
      switch (subcommand) {
        case 'list': {
          const workflows = listWorkflows();
          if (workflows.length === 0) {
            console.log('[workflow] No workflows found');
            break;
          }
          console.log(`[workflow] Available workflows (${workflows.length}):\n`);
          for (const name of workflows) {
            try {
              const wf = loadWorkflow(name);
              const desc = wf.description?.split('\n')[0] ?? '';
              console.log(`  ${name}${desc ? ' — ' + desc.trim() : ''}`);
            } catch {
              console.log(`  ${name}`);
            }
          }
          break;
        }
        case 'run': {
          const workflowName = args[0];
          if (!workflowName) {
            console.error('Usage: linear-harness workflow run <name> [prompt]');
            process.exit(1);
          }
          const workflowPrompt = args.slice(1).join(' ') || '';

          // Parse optional flags
          let workflowModel: string | undefined;
          const promptParts: string[] = [];
          const allWorkflowArgs = args.slice(1);
          for (let i = 0; i < allWorkflowArgs.length; i++) {
            if (allWorkflowArgs[i] === '--model' && allWorkflowArgs[i + 1]) {
              workflowModel = allWorkflowArgs[++i];
            } else {
              promptParts.push(allWorkflowArgs[i]);
            }
          }

          console.log(`[workflow] Running: ${workflowName}`);
          if (promptParts.length > 0) console.log(`[workflow] Args: ${promptParts.join(' ')}`);
          console.log(`CWD: ${cwd}\n`);

          const wfResult = await runWorkflow(workflowName, cwd, promptParts.join(' '), workflowModel);

          console.log(`\n[workflow] ${wfResult.name}: ${wfResult.status} (${(wfResult.duration / 1000).toFixed(1)}s)`);
          for (const node of wfResult.nodes) {
            const icon = node.status === 'completed' ? '[ok]' : node.status === 'failed' ? '[FAIL]' : '[skip]';
            console.log(`  ${icon} ${node.id} (${(node.duration / 1000).toFixed(1)}s)`);
          }

          process.exit(wfResult.status === 'completed' ? 0 : 1);
          break;
        }
        case 'show': {
          const name = args[0];
          if (!name) {
            console.error('Usage: linear-harness workflow show <name>');
            process.exit(1);
          }
          try {
            const wf = loadWorkflow(name);
            console.log(`Name:        ${wf.name}`);
            if (wf.description) console.log(`Description: ${wf.description.trim()}`);
            console.log(`Nodes:       ${wf.nodes.length}`);
            console.log(`\nDAG:`);
            for (const node of wf.nodes) {
              const deps = node.depends_on?.length ? ` (after: ${node.depends_on.join(', ')})` : '';
              const type = node.bash ? 'bash' : node.command ? `cmd:${node.command}` : 'prompt';
              const model = node.model ? ` [${node.model}]` : '';
              console.log(`  ${node.id} — ${type}${model}${deps}`);
            }
          } catch (err) {
            console.error(`[workflow] Not found: ${name}`);
            process.exit(1);
          }
          break;
        }
        default:
          console.log('Usage: linear-harness workflow <list|run|show>');
      }
      break;
    }

    default:
      console.log(`linear-harness — AI development harness with TDD + E2E

Commands:
  run [flags] <prompt>      Run dev task (flags: --skill, --agent, --model, --mode, --no-caveman)
  autopilot <prompt>        5-phase autonomous pipeline
  workflow <list|run|show>  YAML workflow engine (DAG execution)
  task <create|list|show|move>  Manage task cards
  e2e                       Run E2E tests
  review <list|show|approve|reject>  Manage reviews
  status                    Board status summary
  init                      Initialize .linear-harness/ in project
  list                      List presets
  memory <show|detect|add-note|add-directive>  Project memory
  skill <list|show>         Manage skills
  agent <list|show>         Manage agents`);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('[linear-harness] Fatal error:', err);
  process.exit(1);
});
