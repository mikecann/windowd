#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';
import { select } from '@inquirer/prompts';

const VITE_CONFIGS = [
  'vite.config.js',
  'vite.config.ts',
  'vite.config.mjs',
  'vite.config.cjs',
];

const REQUIRED_TSCONFIG_OPTIONS: Record<string, unknown> = {
  target: 'ESNext',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  jsx: 'react-jsx',
  noEmit: true,
  skipLibCheck: true,
};

const REQUIRED_TSCONFIG_TYPES = ['node', 'vite/client'];

interface Args {
  width:   number;
  height:  number;
  title?:  string;
  debug:   boolean;
  init:    boolean;
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
  Wrap a Vite app in an NW.js host with full renderer Node.js access.

  Usage:
    bun run window-this [options]

  Options:
    --width  <n>   Window width  (default: 1280)
    --height <n>   Window height (default: 800)
    --title  <s>   Window title  (default: auto-detected)
    --debug        Enable extra NW.js logging
    --init         Create/check tsconfig.json for Node + Vite types
    --version      Show version
    --help         Show this help
`);
  process.exit(0);
}

await main();

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const cwd = process.cwd();

  if (args.init) {
    runInit(cwd);
    process.exit(0);
  }

  const hasViteConfig = VITE_CONFIGS.some(f => existsSync(join(cwd, f)));
  const hasIndexHtml  = existsSync(join(cwd, 'index.html'));

  if (!hasViteConfig && !hasIndexHtml) {
    await handleNoProject(cwd);
    return;
  }

  ensureTsConfig(cwd);

  const port = await resolveDevPort(5173);
  const viteConfig = createAugmentedViteConfig(cwd);
  try {
    const vite = await startVite(cwd, port, viteConfig.configPath);
    const url    = `http://127.0.0.1:${port}`;
    console.log(`  window-this  ${url}`);

    await openWindow({
      url,
      title:   args.title ?? getTitle(cwd),
      width:   args.width,
      height:  args.height,
      debug:   args.debug,
      projectDir: cwd,
    });

    stopVite(vite);
  } finally {
    removeAugmentedViteConfig(viteConfig);
  }

  process.exit(0);
}

// ─── vite ────────────────────────────────────────────────────────────────────

async function startVite(cwd: string, port: number, configPath: string): Promise<ViteProcess> {
  process.stdout.write('  starting vite...');
  const vite = spawn(
    'bun',
    ['x', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--config', configPath],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  vite.stdout.on('data', () => { /* keep pipe drained */ });
  vite.stderr.on('data', (chunk: Buffer | string) => {
    process.stderr.write(chunk);
  });

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

// ─── nw.js ───────────────────────────────────────────────────────────────────

interface WindowOptions {
  url:    string;
  title:  string;
  width:  number;
  height: number;
  debug:  boolean;
  projectDir: string;
}

async function openWindow({ url, title, width, height, debug, projectDir }: WindowOptions) {
  const hostDir = createNwHostApp({ url, title, width, height, debug, projectDir });
  const nw = spawn('bun', ['x', 'nw', hostDir], {
    stdio: 'inherit',
    env: process.env,
  });

  try {
    await waitForExit(nw, 'nw');
  } finally {
    rmSync(hostDir, { recursive: true, force: true });
  }
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

  ensureTsConfig(cwd);

  // Now run with the freshly scaffolded project
  const port = await resolveDevPort(5173);
  const viteConfig = createAugmentedViteConfig(cwd);
  try {
    const vite = await startVite(cwd, port, viteConfig.configPath);
    const url    = `http://127.0.0.1:${port}`;
    console.log(`  window-this  ${url}`);

    await openWindow({
      url,
      title: args.title ?? basename(cwd),
      width: args.width,
      height: args.height,
      debug: args.debug,
      projectDir: cwd,
    });

    stopVite(vite);
  } finally {
    removeAugmentedViteConfig(viteConfig);
  }

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

interface AugmentedViteConfig {
  tempDir: string;
  configPath: string;
}

function createAugmentedViteConfig(cwd: string): AugmentedViteConfig {
  const tempDir = mkdtempSync(join(tmpdir(), 'window-this-vite-'));
  const configPath = join(tempDir, 'vite.config.mjs');
  const userConfigPath = getUserViteConfigPath(cwd);
  const userConfigUrl = userConfigPath ? pathToFileURL(userConfigPath).href : null;

  const configContents = `
import path from "node:path";

function windowThisNodeBuiltins() {
  const virtualPrefix = '\\0window-this-node:';
  return {
    name: 'window-this-nw-node-builtins',
    enforce: 'pre',
    resolveId(id) {
      if (id.startsWith('node:')) return virtualPrefix + id;
      return null;
    },
    load(id) {
      if (!id.startsWith(virtualPrefix)) return null;
      const nodeSpecifier = id.slice(virtualPrefix.length);
      return \`
const requireFn = globalThis.require;
if (typeof requireFn !== "function") {
  throw new Error("window-this expected Node integration, but globalThis.require is missing.");
}
const mod = requireFn(\${JSON.stringify(nodeSpecifier)});
export default mod;
\`;
    },
  };
}

const projectDir = ${JSON.stringify(cwd)};
const defaultFsAllow = [projectDir, path.resolve(projectDir, "..")];
const userConfigUrl = ${JSON.stringify(userConfigUrl)};
let userConfig = {};

if (userConfigUrl) {
  const loaded = (await import(userConfigUrl)).default;
  if (typeof loaded === 'function') {
    userConfig = await loaded({ command: 'serve', mode: 'development' });
  } else if (loaded) {
    userConfig = loaded;
  }
}

const plugins = Array.isArray(userConfig.plugins)
  ? [windowThisNodeBuiltins(), ...userConfig.plugins]
  : [windowThisNodeBuiltins()];

const userServer = userConfig.server ?? {};
const userFs = userServer.fs ?? {};
const userAllow = Array.isArray(userFs.allow) ? userFs.allow : [];
const allow = [...new Set([...defaultFsAllow, ...userAllow])];

export default {
  ...userConfig,
  plugins,
  server: {
    ...userServer,
    fs: {
      ...userFs,
      allow,
    },
  },
};
`;

  writeFileSync(configPath, configContents, 'utf-8');
  return { tempDir, configPath };
}

function removeAugmentedViteConfig(config: AugmentedViteConfig) {
  rmSync(config.tempDir, { recursive: true, force: true });
}

function getUserViteConfigPath(cwd: string): string | undefined {
  for (const file of VITE_CONFIGS) {
    const abs = join(cwd, file);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

function ensureTsConfig(cwd: string) {
  const tsconfigPath = join(cwd, 'tsconfig.json');
  if (existsSync(tsconfigPath)) return;

  const tsconfig = {
    compilerOptions: {
      ...REQUIRED_TSCONFIG_OPTIONS,
      types: REQUIRED_TSCONFIG_TYPES,
    },
  };

  writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`, 'utf-8');
  console.log('  created tsconfig.json for Node.js + Vite types');
}

function runInit(cwd: string) {
  const tsconfigPath = join(cwd, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    ensureTsConfig(cwd);
    return;
  }

  const validation = validateExistingTsConfig(tsconfigPath);
  if (!validation.ok) {
    console.warn(`  found tsconfig.json, but could not parse it: ${validation.error}`);
    console.warn('  please ensure compilerOptions include Node + Vite settings');
    return;
  }

  if (validation.missing.length === 0) {
    console.log('  tsconfig.json already includes required Node.js + Vite settings');
    return;
  }

  console.warn('  tsconfig.json exists but is missing recommended settings:');
  for (const item of validation.missing) {
    console.warn(`   - ${item}`);
  }
  console.warn('  run with your editor open and merge the missing settings manually');
}

function validateExistingTsConfig(tsconfigPath: string):
  | { ok: true; missing: string[] }
  | { ok: false; error: string } {
  try {
    const raw = readFileSync(tsconfigPath, 'utf-8');
    const parsed = JSON.parse(raw) as { compilerOptions?: Record<string, unknown> };
    const compilerOptions = parsed.compilerOptions ?? {};
    const missing: string[] = [];

    for (const [key, expected] of Object.entries(REQUIRED_TSCONFIG_OPTIONS)) {
      if (!isExpectedTsConfigValue(key, compilerOptions[key], expected)) {
        missing.push(`compilerOptions.${key} should be ${JSON.stringify(expected)}`);
      }
    }

    const types = Array.isArray(compilerOptions.types)
      ? compilerOptions.types.filter((v): v is string => typeof v === 'string')
      : [];
    for (const typeName of REQUIRED_TSCONFIG_TYPES) {
      if (!types.includes(typeName)) {
        missing.push(`compilerOptions.types should include "${typeName}"`);
      }
    }

    return { ok: true, missing };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function isExpectedTsConfigValue(key: string, actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') {
    if (key === 'target' || key === 'module' || key === 'moduleResolution') {
      return actual.toLowerCase() === expected.toLowerCase();
    }
  }
  return actual === expected;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const result: Partial<Args> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if      (arg === '--version' || arg === '-v')                      result.version = true;
    else if (arg === '--help'    || arg === '-h')                      result.help    = true;
    else if (arg === '--debug'   || arg === '-d')                      result.debug   = true;
    else if (arg === '--init'    || arg === '-i')                      result.init    = true;
    else if ((arg === '--width'  || arg === '-W') && argv[i + 1])     result.width   = parseInt(argv[++i], 10);
    else if ((arg === '--height' || arg === '-H') && argv[i + 1])     result.height  = parseInt(argv[++i], 10);
    else if ((arg === '--title'  || arg === '-t') && argv[i + 1])     result.title   = argv[++i];
  }

  return {
    width:   result.width   ?? 1280,
    height:  result.height  ?? 800,
    debug:   result.debug   ?? false,
    init:    result.init    ?? false,
    version: result.version ?? false,
    help:    result.help    ?? false,
    title:   result.title,
  };
}

interface NwHostOptions extends WindowOptions {}

function createNwHostApp({ url, title, width, height, debug, projectDir }: NwHostOptions): string {
  const hostDir = mkdtempSync(join(tmpdir(), 'window-this-nw-'));
  const startUrl = new URL(url);
  startUrl.searchParams.set('windowThisProjectDir', projectDir);
  const injectedJsPath = join(hostDir, 'window-this-inject.js');

  const manifest: Record<string, unknown> = {
    name: 'window-this-host',
    main: startUrl.toString(),
    'node-remote': ['<all_urls>'],
    inject_js_start: 'window-this-inject.js',
    window: {
      title,
      width,
      height,
    },
  };

  if (debug) {
    manifest['chromium-args'] = '--enable-logging=stderr';
  }

  writeFileSync(join(hostDir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  writeFileSync(injectedJsPath, buildInjectedNwJs(), 'utf-8');
  return hostDir;
}

function buildInjectedNwJs(): string {
  return `
(() => {
  if (typeof nw === 'undefined') return;

  const openDevTools = () => {
    try {
      const win = nw.Window.get();
      if (!win || typeof win.showDevTools !== 'function') {
        console.warn('[window-this] DevTools unavailable - ensure NW.js SDK build is installed.');
        return;
      }
      win.showDevTools();
    } catch (error) {
      console.error('[window-this] Failed to open DevTools', error);
    }
  };

  const menu = new nw.Menu();
  menu.append(new nw.MenuItem({
    label: 'Inspect / DevTools',
    click: openDevTools,
  }));

  const onContextMenu = (event) => {
    event.preventDefault();
    const x = typeof event.x === 'number' ? event.x : event.clientX;
    const y = typeof event.y === 'number' ? event.y : event.clientY;
    menu.popup(x, y);
    return false;
  };

  window.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('contextmenu', onContextMenu);

  window.addEventListener('keydown', (event) => {
    const openByF12 = event.key === 'F12';
    const openByShortcut = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'i';
    if (openByF12 || openByShortcut) {
      event.preventDefault();
      openDevTools();
    }
  });
})();
`;
}

function waitForExit(proc: ChildProcess, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${name} exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`));
    });
  });
}
