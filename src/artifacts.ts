import { mkdirSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import type { PlaywrightRunResult } from './types.js';

export interface SavedArtifacts {
  dir: string;
  videoPath: string | null;
  screenshotPaths: string[];
  logPath: string;
  reportPath: string;
}

export function saveArtifacts(
  cwd: string,
  taskId: string,
  e2eResult: PlaywrightRunResult,
): SavedArtifacts {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Feature-scoped artifacts: extract slug from taskId (format: "slug/localId")
  const parts = taskId.split('/');
  const slug = parts.length > 1 ? parts[0] : 'default';
  const localId = parts.length > 1 ? parts.slice(1).join('/') : taskId;
  const dir = join(cwd, '.smt', 'features', slug, 'artifacts', localId, timestamp);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'screenshots'), { recursive: true });

  // Save report
  const reportPath = join(dir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(e2eResult, null, 2));

  // Save log
  const logPath = join(dir, 'output.log');
  writeFileSync(logPath, e2eResult.rawOutput);

  // Copy video if exists
  let videoPath: string | null = null;
  if (e2eResult.videoPath && existsSync(e2eResult.videoPath)) {
    const vp = e2eResult.videoPath;
    try {
      const files = readdirSync(vp).filter((f) => f.endsWith('.webm') || f.endsWith('.mp4'));
      if (files.length > 0) {
        const dest = join(dir, files[0]);
        copyFileSync(join(vp, files[0]), dest);
        videoPath = dest;
      }
    } catch {
      // vp might be a file not directory
      const dest = join(dir, basename(vp));
      copyFileSync(vp, dest);
      videoPath = dest;
    }
  }

  // Copy screenshots
  const screenshotPaths: string[] = [];
  for (const sp of e2eResult.screenshotPaths) {
    if (existsSync(sp)) {
      const dest = join(dir, 'screenshots', basename(sp));
      copyFileSync(sp, dest);
      screenshotPaths.push(dest);
    }
  }

  return { dir, videoPath, screenshotPaths, logPath, reportPath };
}
