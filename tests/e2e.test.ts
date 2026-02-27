import { test, expect, describe } from 'bun:test';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { assertVisualMatch } from './vision.ts';

const testApps: Record<string, { title: string; appearance: string }> = {
  justhtml: {
    title: 'windowd justhtml',
    appearance:
      'A simple white webpage with dark text. ' +
      "Shows the text 'Because who needs Typescript?' " +
      "followed by text showing the OS platform and Node.js version, like 'Running on win32 with Node v...'.",
  },
  basics: {
    title: 'windowd basics',
    appearance:
      'A React application demonstrating NW.js integration. ' +
      'Should show platform info, file system demos, and Vite asset handling with images. ' +
      'Has a dark or styled UI with multiple sections or cards.',
  },
  config: {
    title: 'windowd config-demo',
    appearance:
      'A React application running in a frameless window (no native OS title bar). ' +
      'Should show content rendered by the config demo app with styled UI elements.',
  },
  deps: {
    title: 'windowd deps',
    appearance:
      "A dark-themed webpage with a purple 'deps' heading. " +
      "Shows text about third-party npm packages working alongside Node.js APIs. " +
      "Has a 'Celebrate' button and a pre-formatted block showing system info " +
      'like platform, arch, hostname, cpus, and memory in JSON format.',
  },
};

function killNwIfRunning() {
  if (process.platform === 'win32') {
    Bun.spawnSync({ cmd: ['taskkill', '/IM', 'nw.exe', '/F'], stdout: 'ignore', stderr: 'ignore' });
    return;
  }
  Bun.spawnSync({ cmd: ['pkill', '-f', 'nw'], stdout: 'ignore', stderr: 'ignore' });
}

describe('e2e', () => {
  for (const [app, expected] of Object.entries(testApps)) {
    test(`${app} launches and renders correctly`, async () => {
      killNwIfRunning();
      const captureDir = mkdtempSync(join(tmpdir(), `windowd-e2e-${app}-`));
      const appDir = resolve(import.meta.dir, '..', 'test-apps', app);

      const proc = Bun.spawnSync({
        cmd: ['bun', 'run', '../../bin/cli.ts', '--capture', captureDir, '--artifacts', captureDir],
        cwd: appDir,
        timeout: 90_000,
      });

      expect(proc.exitCode).toBe(0);

      const screenshotPath = join(captureDir, 'screenshot.png');
      expect(existsSync(screenshotPath)).toBe(true);

      const resultPath = join(captureDir, 'result.json');
      expect(existsSync(resultPath)).toBe(true);
      expect(existsSync(join(captureDir, 'cli.log'))).toBe(true);
      expect(existsSync(join(captureDir, 'app.log'))).toBe(true);

      const result = JSON.parse(readFileSync(resultPath, 'utf-8'));
      expect(result.consoleErrors).toHaveLength(0);
      expect(result.title).toBe(expected.title);

      const vision = await assertVisualMatch(screenshotPath, expected.appearance);
      const vision2 = (!vision.skipped && !vision.pass)
        ? await assertVisualMatch(screenshotPath, expected.appearance)
        : vision;
      if (vision2.skipped) {
        console.log(`  [${app}] vision check skipped (no API key)`);
      } else if (!vision2.pass) {
        console.error(`  [${app}] vision check failed: ${vision2.reason}`);
      }
      expect(vision2.pass).toBe(true);
      killNwIfRunning();
    }, 90_000);
  }
});
