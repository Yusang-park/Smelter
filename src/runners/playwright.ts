import { spawn } from 'child_process';
import type { E2ETestCase, PlaywrightRunResult } from '../types.js';

// --- Internal types for Playwright JSON reporter output ---

interface PlaywrightSuite {
  title: string;
  specs?: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

interface PlaywrightSpec {
  title: string;
  tests?: PlaywrightTest[];
}

interface PlaywrightTest {
  results?: PlaywrightTestResult[];
}

interface PlaywrightTestResult {
  status: string;
  duration?: number;
  error?: { message?: string };
}

/**
 * Run Playwright tests via CLI (child_process.spawn).
 * This is the Node.js version for standalone/CLI usage.
 * The desktop app uses its own Tauri Shell version.
 */
export async function runPlaywright(
  cwd: string,
  signal?: AbortSignal,
): Promise<PlaywrightRunResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', [
      'playwright', 'test',
      '--reporter=json',
      '--output=test-results',
    ], { cwd, shell: true });

    let stdout = '';
    let stderr = '';

    if (signal) {
      signal.addEventListener('abort', () => { child.kill(); }, { once: true });
    }

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('close', () => {
      resolve(parsePlaywrightOutput(stdout, stderr, cwd));
    });

    child.on('error', () => {
      resolve({
        status: 'error',
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        duration: 0,
        tests: [],
        videoPath: null,
        screenshotPaths: [],
        rawOutput: stderr || 'Failed to spawn playwright process',
      });
    });
  });
}

function parsePlaywrightOutput(
  stdout: string,
  stderr: string,
  cwd: string,
): PlaywrightRunResult {
  const rawOutput = stdout + '\n' + stderr;

  try {
    const report = JSON.parse(stdout) as { suites?: PlaywrightSuite[] };
    const suites = report.suites ?? [];
    const tests: E2ETestCase[] = [];

    function extractTests(suite: PlaywrightSuite) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          const result = test.results?.[0];
          tests.push({
            name: `${suite.title} > ${spec.title}`,
            status: result?.status === 'passed' ? 'passed'
                  : result?.status === 'skipped' ? 'skipped'
                  : 'failed',
            duration: result?.duration ?? 0,
            error: result?.status === 'failed'
              ? (result?.error?.message ?? 'Unknown error')
              : undefined,
          });
        }
      }
      for (const child of suite.suites ?? []) {
        extractTests(child);
      }
    }

    suites.forEach(extractTests);

    const passed = tests.filter((t) => t.status === 'passed').length;
    const failed = tests.filter((t) => t.status === 'failed').length;
    const skipped = tests.filter((t) => t.status === 'skipped').length;
    const duration = tests.reduce((sum, t) => sum + t.duration, 0);

    const videoPath = `${cwd}/test-results/videos`;

    return {
      status: failed > 0 ? 'failed' : 'passed',
      totalTests: tests.length,
      passedTests: passed,
      failedTests: failed,
      skippedTests: skipped,
      duration,
      tests,
      videoPath: failed > 0 || passed > 0 ? videoPath : null,
      screenshotPaths: [],
      rawOutput,
    };
  } catch {
    return {
      status: 'error',
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      duration: 0,
      tests: [],
      videoPath: null,
      screenshotPaths: [],
      rawOutput,
    };
  }
}
