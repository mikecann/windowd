#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { select } from '@inquirer/prompts';
import { Webview } from 'webview-nodejs';

const VITE_CONFIGS = [
  'vite.config.js',
  'vite.config.ts',
  'vite.config.mjs',
  'vite.config.cjs',
];

interface Args {
  width:   number;
  height:  number;
  title?:  string;
  debug:   boolean;
  version: boolean;
  help:    boolean;
}

const args = parseArgs();
const binDir = fileURLToPath(new URL('.', import.meta.url));
const pkgJson = JSON.parse(readFileSync(join(binDir, '../package.json'), 'utf-8'));
type ViteProcess = ChildProcessByStdio<null, Readable, Readable>;

if (args.version) {
  console.log(`window-this v${pkgJson.version}`);
  process.exit(0);
}

if (args.help) {
  console.log(`
  window-this v${pkgJson.version}
  Wrap a Vite app in a native OS WebView - no Electron, no bundled Chromium.

  Usage:
    bun run window-this [options]

  Options:
    --width  <n>   Window width  (default: 1280)
    --height <n>   Window height (default: 800)
    --title  <s>   Window title  (default: auto-detected)
    --debug        Open with DevTools
    --version      Show version
    --help         Show this help
`);
  process.exit(0);
}

await main();

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const cwd = process.cwd();

  const hasViteConfig = VITE_CONFIGS.some(f => existsSync(join(cwd, f)));
  const hasIndexHtml  = existsSync(join(cwd, 'index.html'));

  if (!hasViteConfig && !hasIndexHtml) {
    await handleNoProject(cwd);
    return;
  }

  const port = await resolveDevPort(5173);
  const vite = await startVite(cwd, port);
  const url    = `http://127.0.0.1:${port}`;

  console.log(`  window-this  ${url}`);

  await openWindow({
    url,
    title:   args.title ?? getTitle(cwd),
    width:   args.width,
    height:  args.height,
    debug:   args.debug,
  });

  stopVite(vite);
  process.exit(0);
}

// ─── vite ────────────────────────────────────────────────────────────────────

async function startVite(cwd: string, port: number): Promise<ViteProcess> {
  process.stdout.write('  starting vite...');
  const vite = spawn(
    'bun',
    ['x', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  vite.stdout.on('data', () => { /* keep pipe drained */ });
  vite.stderr.on('data', () => { /* keep pipe drained */ });

  process.stdout.write('  waiting for vite...');
  await waitForServer(`http://127.0.0.1:${port}`);
  process.stdout.write('\r  \r');

  return vite;
}

function stopVite(vite: ViteProcess) {
  if (vite.killed) return;
  try {
    vite.kill('SIGTERM');
  } catch {
    // Process may have already exited.
  }
}

// ─── webview ─────────────────────────────────────────────────────────────────

interface WindowOptions {
  url:    string;
  title:  string;
  width:  number;
  height: number;
  debug:  boolean;
}

async function openWindow({ url, title, width, height, debug }: WindowOptions) {
  const wv = new Webview(debug);
  wv.title(title);
  wv.size(width, height);
  wv.bind('__native', () => ({ platform: process.platform, node: process.version }));
  wv.navigate(url);

  wv.show(); // blocks until window is closed
}

// ─── no-project prompt ───────────────────────────────────────────────────────

async function handleNoProject(cwd: string) {
  console.log(`  no index.html or vite.config found in ${cwd}\n`);

  const choice = await select({
    message: 'What would you like to do?',
    choices: [
      { name: 'Scaffold a React + TypeScript project here', value: 'react-ts'  },
      { name: 'Scaffold a vanilla HTML + TypeScript project', value: 'vanilla' },
      { name: 'Exit',                                         value: 'exit'    },
    ],
  });

  if (choice === 'exit') process.exit(0);
  await scaffold(cwd, choice as 'react-ts' | 'vanilla');
}

async function scaffold(cwd: string, template: 'react-ts' | 'vanilla') {
  const { spawnSync } = await import('node:child_process');

  console.log(`\n  scaffolding ${template} project in ${cwd}...`);

  const result = spawnSync(
    'bun',
    ['create', 'vite@latest', '.', '--template', template],
    { cwd, stdio: 'inherit' }
  );

  if (result.status !== 0) {
    console.error('  scaffold failed');
    process.exit(1);
  }

  console.log('\n  installing dependencies...');
  spawnSync('bun', ['install'], { cwd, stdio: 'inherit' });

  // Now run with the freshly scaffolded project
  const port = await resolveDevPort(5173);
  const vite = await startVite(cwd, port);
  const url    = `http://127.0.0.1:${port}`;

  console.log(`  window-this  ${url}`);
  await openWindow({ url, title: args.title ?? basename(cwd), width: args.width, height: args.height, debug: args.debug });

  stopVite(vite);
  process.exit(0);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function waitForServer(url: string, maxAttempts = 40): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function attempt() {
      attempts++;
      const req = httpGet(url, (res: IncomingMessage) => {
        res.resume();
        if (res.statusCode! < 500) {
          resolve();
        } else if (attempts < maxAttempts) {
          setTimeout(attempt, 150);
        } else {
          reject(new Error(`Vite not ready after ${maxAttempts} attempts`));
        }
      });
      req.on('error', () => {
        if (attempts < maxAttempts) setTimeout(attempt, 150);
        else reject(new Error(`Vite at ${url} never responded`));
      });
      req.setTimeout(1000, () => req.destroy());
    }

    attempt();
  });
}

async function resolveDevPort(preferredPort: number): Promise<number> {
  if (await isPortAvailable(preferredPort)) return preferredPort;

  const fallbackPort = await getEphemeralPort();
  console.log(`  port ${preferredPort} is in use, using ${fallbackPort}`);
  return fallbackPort;
}

function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();

    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, host);
  });
}

function getEphemeralPort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();

    server.once('error', reject);
    server.once('listening', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Could not determine a free port')));
        return;
      }

      const port = addr.port;
      server.close(() => resolve(port));
    });

    server.listen(0, host);
  });
}

function getTitle(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
    if (pkg['window-this']?.title) return pkg['window-this'].title;
    if (pkg.displayName)                return pkg.displayName;
    if (pkg.name)                       return pkg.name;
  } catch { /* ignore */ }

  try {
    const html = readFileSync(join(cwd, 'index.html'), 'utf-8');
    const m = html.match(/<title>(.*?)<\/title>/i);
    if (m?.[1]) return m[1];
  } catch { /* ignore */ }

  return basename(cwd);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const result: Partial<Args> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if      (arg === '--version' || arg === '-v')                      result.version = true;
    else if (arg === '--help'    || arg === '-h')                      result.help    = true;
    else if (arg === '--debug'   || arg === '-d')                      result.debug   = true;
    else if ((arg === '--width'  || arg === '-W') && argv[i + 1])     result.width   = parseInt(argv[++i], 10);
    else if ((arg === '--height' || arg === '-H') && argv[i + 1])     result.height  = parseInt(argv[++i], 10);
    else if ((arg === '--title'  || arg === '-t') && argv[i + 1])     result.title   = argv[++i];
  }

  return {
    width:   result.width   ?? 1280,
    height:  result.height  ?? 800,
    debug:   result.debug   ?? false,
    version: result.version ?? false,
    help:    result.help    ?? false,
    title:   result.title,
  };
}
