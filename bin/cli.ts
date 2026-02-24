#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { select } from '@inquirer/prompts';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { Webview, getLibraryPath } from 'webview-nodejs';
import koffi from 'koffi';
import { Worker as NodeWorker } from 'node:worker_threads';

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
const pkgJson = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf-8'));

if (args.version) {
  console.log(`instantly-native v${pkgJson.version}`);
  process.exit(0);
}

if (args.help) {
  console.log(`
  instantly-native v${pkgJson.version}
  Wrap a Vite app in a native OS WebView - no Electron, no bundled Chromium.

  Usage:
    bun run instantly-native [options]

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

  const server = await startVite(cwd);
  const port   = server.config.server.port ?? 5173;
  const url    = `http://127.0.0.1:${port}`;

  console.log(`  instantly-native  ${url}`);

  await openWindow({
    url,
    title:   args.title ?? getTitle(cwd),
    width:   args.width,
    height:  args.height,
    debug:   args.debug,
    rootDir: cwd,
  });

  await server.close();
  process.exit(0);
}

// ─── vite ────────────────────────────────────────────────────────────────────

async function startVite(cwd: string): Promise<ViteDevServer> {
  process.stdout.write('  starting vite...');

  const server = await createViteServer({
    root:     cwd,
    logLevel: 'warn',
    server:   { host: '127.0.0.1' },
  });

  await server.listen();

  process.stdout.write('  waiting for vite...');
  const port = server.config.server.port ?? 5173;
  await waitForServer(`http://127.0.0.1:${port}`);
  process.stdout.write('\r  \r');

  return server;
}

// ─── webview ─────────────────────────────────────────────────────────────────

interface WindowOptions {
  url:    string;
  title:  string;
  width:  number;
  height: number;
  debug:  boolean;
  rootDir: string;
}

async function openWindow({ url, title, width, height, debug, rootDir }: WindowOptions) {
  const html = await fetchViteHtml(url);
  const port = parseInt(new URL(url).port, 10);

  const wv = new Webview(debug);
  wv.title(title);
  wv.size(width, height);
  wv.bind('__native', () => ({ platform: process.platform, node: process.version }));
  wv.html(html);

  // wv.show() blocks the JS event loop entirely, so we use a node:worker_threads
  // Worker which runs on a real OS thread in the same address space.
  // The worker watches Vite's HMR WebSocket and calls webview_set_html() via koffi.
  const handleAddr = (koffi.address(wv.unsafeHandle) as bigint).toString();
  const worker = new NodeWorker(
    new URL('../src/reload-worker.ts', import.meta.url),
    { workerData: { handleAddr, port, libPath: getLibraryPath(), rootDir } },
  );
  worker.on('message', (msg) => {
    if (msg.type === 'connected') console.log('  [hmr] connected to Vite');
    if (msg.type === 'reloaded')  console.log('  [hmr] reloaded');
    if (msg.type === 'error')     console.error('  [hmr] error:', msg.message);
  });
  worker.on('error', (err) => console.error('  [hmr] worker error:', err.message));

  wv.show(); // blocks until window is closed

  worker.terminate();
}

async function fetchViteHtml(url: string): Promise<string> {
  const res = await fetch(url);
  const raw = await res.text();

  // Inject base href so relative asset paths resolve against the Vite server
  return raw.replace('<head>', `<head>\n  <base href="${url}">`);
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
  const server = await startVite(cwd);
  const port   = server.config.server.port ?? 5173;
  const url    = `http://127.0.0.1:${port}`;

  console.log(`  instantly-native  ${url}`);
  openWindow({ url, title: args.title ?? basename(cwd), width: args.width, height: args.height, debug: args.debug, rootDir: cwd });

  await server.close();
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

function getTitle(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
    if (pkg['instantly-native']?.title) return pkg['instantly-native'].title;
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
