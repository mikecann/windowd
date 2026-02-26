#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const appArg = process.argv[2];
const forwardedArgs = process.argv.slice(3);

const appMap: Record<string, string> = {
  basics: 'test-apps/basics',
  config: 'test-apps/config',
  deps: 'test-apps/deps',
  justhtml: 'test-apps/justhtml',
};

const names = Object.keys(appMap).join('|');

if (!appArg || !(appArg in appMap)) {
  console.error(`Usage: bun run test-app <${names}> [windowd args]`);
  process.exit(1);
}

const appDir = resolve(import.meta.dir, '..', appMap[appArg]);

if (!existsSync(appDir)) {
  console.error(`Test app directory not found: ${appDir}`);
  process.exit(1);
}

if (existsSync(resolve(appDir, 'package.json')) && !existsSync(resolve(appDir, 'node_modules'))) {
  console.log('  installing dependencies...');
  Bun.spawnSync({
    cmd: ['bun', 'install'],
    cwd: appDir,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
}

const proc = Bun.spawn({
  cmd: ['bun', 'run', '../../bin/cli.ts', ...forwardedArgs],
  cwd: appDir,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

const code = await proc.exited;
process.exit(code);
