#!/usr/bin/env tsx
import { runWithTask } from '../src/engine.js';
import { loadTasks, findTask, updateTask, createTask, getTasksByColumn } from '../src/store.js';
import { runPlaywright } from '../src/runners/playwright.js';
// artifacts are saved by stop-e2e.mjs hook, not by the CLI directly
import { loadProjectMemory, autoDetectAndSave, addNote, addDirective } from '../src/project-memory.js';
import { listSkills, loadSkill } from '../src/skill-loader.js';
import { listAgents, loadAgent } from '../src/agent-loader.js';
import { listWorkflows, loadWorkflow, runWorkflow } from '../src/workflow-engine.js';
import type { TaskColumn } from '../src/store.js';
import type { HarnessPreset } from '../src/types.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
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
      // Parse flags: --preset <name>, --skill <name>, --agent <name>, --model <name>, --no-caveman
      let preset: HarnessPreset = 'feat';
      let skill: string | undefined;
      let agent: string | undefined;
      let model: string | undefined;
      let noCaveman = false;
      const promptParts: string[] = [];

      const allArgs = [subcommand, ...args].filter(Boolean);
      for (let i = 0; i < allArgs.length; i++) {
        if (allArgs[i] === '--preset' && allArgs[i + 1]) {
          preset = allArgs[++i] as HarnessPreset;
        } else if (allArgs[i] === '--skill' && allArgs[i + 1]) {
          skill = allArgs[++i];
        } else if (allArgs[i] === '--agent' && allArgs[i + 1]) {
          agent = allArgs[++i];
        } else if (allArgs[i] === '--model' && allArgs[i + 1]) {
          model = allArgs[++i];
        } else if (allArgs[i] === '--no-caveman') {
          noCaveman = true;
        } else {
          promptParts.push(allArgs[i]);
        }
      }

      const prompt = promptParts.join(' ');
      if (!prompt) {
        console.error('Usage: smelter run [--preset tasker|feat|qa] [--skill <name>] [--agent <name>] [--model <m>] [--no-caveman] <prompt>');
        process.exit(1);
      }
      console.log(`[smelter] Running: "${prompt}" [preset: ${preset}]`);
      if (skill) console.log(`[skill] ${skill}`);
      if (agent) console.log(`[agent] ${agent}`);
      console.log(`CWD: ${cwd}\n`);

      const { task, result } = await runWithTask(prompt, cwd, { mode: 'normal', preset, model, skill, agent, noCaveman: noCaveman || undefined });

      console.log(`\n[Task] ${task.id} — ${task.column}`);
      console.log(`[Result] ${result.status}`);
      // E2E interface results are reported by the Stop hook chain (stop-e2e.mjs),
      // not by the engine. See doc/workflow.md Step 8.
      console.log(`\nRun 'smelter review approve ${task.id}' to approve`);
      process.exit(result.status === 'completed' ? 0 : 1);
      break;
    }

    case 'task': {
      switch (subcommand) {
        case 'create': {
          const title = args.join(' ');
          if (!title) {
            console.error('Usage: smelter task create <title>');
            process.exit(1);
          }
          const task = createTask(cwd, title);
          console.log(`[task] Created: ${task.id} — "${task.title}" (${task.column})`);
          break;
        }
        case 'list': {
          const tasks = loadTasks(cwd);
          if (tasks.length === 0) {
            console.log('[task] No tasks found. Run "smelter task create <title>"');
            break;
          }

          const columns: TaskColumn[] = ['backlog', 'in-progress', 'review', 'done'];
          for (const col of columns) {
            const colTasks = tasks.filter((t) => t.column === col);
            if (colTasks.length === 0) continue;
            console.log(`\n${columnIcon(col)} ${col.toUpperCase()} (${colTasks.length})`);
            for (const t of colTasks) {
              const status = t.done ? '✓' : '○';
              const tagStr = t.tags.length > 0 ? ` ${t.tags.join(' ')}` : '';
              console.log(`  ${status} ${t.id}  ${t.title}${tagStr}`);
            }
          }
          break;
        }
        case 'show': {
          const id = args[0];
          if (!id) {
            console.error('Usage: smelter task show <id>');
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
          console.log(`Done:     ${task.done ? 'yes' : 'no'}`);
          if (task.tags.length > 0) console.log(`Tags:     ${task.tags.join(', ')}`);
          break;
        }
        case 'move': {
          const [id, col] = args;
          if (!id || !col) {
            console.error('Usage: smelter task move <id> <column>');
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
          console.log('Usage: smelter task <create|list|show|move>');
      }
      break;
    }

    case 'e2e': {
      console.log(`[smelter] Running E2E...`);

      const result = await runPlaywright(cwd);
      console.log(`[E2E] ${result.status} — ${result.passedTests}/${result.totalTests} passed (${result.duration}ms)`);

      for (const test of result.tests) {
        const icon = test.status === 'passed' ? '[pass]' : test.status === 'failed' ? '[FAIL]' : '[skip]';
        console.log(`  ${icon} ${test.name} (${test.duration}ms)`);
        if (test.error) console.log(`     ${test.error}`);
      }

      // Save artifacts if there's an active task (artifacts stored in feature-folder)
      const tasks = loadTasks(cwd);
      const activeTask = tasks.find((t) => t.column === 'in-progress');
      if (activeTask) {
        updateTask(cwd, activeTask.id, { column: 'review' });
        console.log(`\n[task] ${activeTask.id} -> Review`);
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
          }
          break;
        }
        case 'show': {
          const id = args[0];
          if (!id) { console.error('Usage: smelter review show <id>'); process.exit(1); }
          const task = findTask(cwd, id);
          if (!task) { console.error(`[review] Not found: ${id}`); process.exit(1); }
          console.log(`\n${task.title} (${task.id})\nColumn: ${task.column}\nDone: ${task.done}`);
          if (task.tags.length > 0) console.log(`Tags: ${task.tags.join(', ')}`);
          console.log(`\n  smelter review approve|reject ${task.id}`);
          break;
        }
        case 'approve': {
          const id = args[0];
          if (!id) { console.error('Usage: smelter review approve <id>'); process.exit(1); }
          const task = updateTask(cwd, id, { column: 'done', done: true });
          if (!task) { console.error(`[review] Not found: ${id}`); process.exit(1); }
          console.log(`[review] Approved: ${task.id} — "${task.title}" -> Done`);
          break;
        }
        case 'reject': {
          const id = args[0];
          const feedback = args.slice(1).join(' ') || 'Needs fixes';
          if (!id) { console.error('Usage: smelter review reject <id> [feedback]'); process.exit(1); }
          const task = updateTask(cwd, id, { column: 'in-progress', done: false });
          if (!task) { console.error(`[review] Not found: ${id}`); process.exit(1); }
          console.log(`[review] Rejected: ${task.id} -> In Progress (${feedback})`);
          break;
        }
        default:
          console.log('Usage: smelter review <list|show|approve|reject>');
      }
      break;
    }

    case 'status': {
      const tasks = loadTasks(cwd);
      const columns: TaskColumn[] = ['backlog', 'in-progress', 'review', 'done'];

      console.log('\nSmelter Board Status\n');
      for (const col of columns) {
        const count = tasks.filter((t) => t.column === col).length;
        console.log(`  ${columnIcon(col)} ${col.padEnd(14)} ${count}`);
      }
      console.log(`  ${'─'.repeat(24)}`);
      console.log(`  Total${' '.repeat(12)} ${tasks.length}`);

      const reviewPending = tasks.filter((t) => t.column === 'review');
      if (reviewPending.length > 0) {
        console.log(`\n  ${reviewPending.length} task(s) awaiting review`);
      }
      break;
    }

    case 'init': {
      const smelterDir = join(cwd, '.smt');
      if (existsSync(smelterDir)) {
        console.log('[init] .smt/ already exists');
      } else {
        mkdirSync(smelterDir, { recursive: true });
        mkdirSync(join(smelterDir, 'features'), { recursive: true });
        mkdirSync(join(smelterDir, 'wiki'), { recursive: true });
        mkdirSync(join(smelterDir, 'session'), { recursive: true });
        console.log('[init] Created .smt/ (features/, wiki/, session/)');
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
      console.log('[smelter] Available presets (core/presets/):\n');
      console.log('  full      - 전체 워크플로우 (Step 1-11, E2E + 비디오 포함)');
      console.log('  narrow    - 단순 이슈 해결 (Step 3-7, 10-11, E2E 없음)');
      console.log('  planning  - 계획 수립만 (Step 2-3 + plan-review)\n');
      console.log('Usage: smelter run --preset <name> "<prompt>"');
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
            console.error('Usage: smelter memory add-note <category> <content>');
            process.exit(1);
          }
          addNote(cwd, category, content);
          console.log(`[memory] Note added: [${category}] ${content}`);
          break;
        }
        case 'add-directive': {
          const directive = args.join(' ');
          if (!directive) {
            console.error('Usage: smelter memory add-directive <directive>');
            process.exit(1);
          }
          addDirective(cwd, directive);
          console.log(`[memory] Directive added: ${directive}`);
          break;
        }
        default:
          console.log('Usage: smelter memory <show|detect|add-note|add-directive>');
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
            console.error('Usage: smelter skill show <name>');
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
          console.log('Usage: smelter skill <list|show>');
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
            console.error('Usage: smelter agent show <name>');
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
          console.log('Usage: smelter agent <list|show>');
      }
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
            console.error('Usage: smelter workflow run <name> [prompt]');
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
            console.error('Usage: smelter workflow show <name>');
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
          console.log('Usage: smelter workflow <list|run|show>');
      }
      break;
    }

    default:
      console.log(`smelter — 실제 인간 개발자 워크플로우를 자동화하는 AI 개발 하네스

Usage:
  smelter run [flags] <prompt>
  smelter <command> [args]

Commands:
  run [--preset <p>] [--skill <s>] [--agent <a>] [--model <m>] [--no-caveman] <prompt>
                            Task 실행 (normal 모드) [preset: tasker|feat|qa]
  workflow <list|run|show>  YAML 워크플로우 엔진 (DAG 실행)
  task <create|list|show|move>  Task 카드 관리
  e2e                       E2E 테스트 실행
  review <list|show|approve|reject>  리뷰 관리
  status                    보드 현황 요약
  init                      프로젝트에 .smt/ 초기화
  list                      프리셋 목록 조회
  memory <show|detect|add-note|add-directive>  프로젝트 메모리
  skill <list|show>         스킬 목록/조회
  agent <list|show>         에이전트 목록/조회
`);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('[smelter] Fatal error:', err);
  process.exit(1);
});
