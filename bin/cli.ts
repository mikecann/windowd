#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';
import { select } from '@inquirer/prompts';

const VITE_CONFIGS = [
  'vite.config.js',
  'vite.config.ts',
  'vite.config.mjs',
  'vite.config.cjs',
];

const WINDOW_THIS_CONFIGS = [
  'windowd-config.ts',
  'windowd-config.js',
  'windowd-config.mjs',
  'windowd-config.cjs',
];

const REQUIRED_TSCONFIG_OPTIONS: Record<string, unknown> = {
  target: 'ESNext',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  jsx: 'react-jsx',
  noEmit: true,
  skipLibCheck: true,
};

const REQUIRED_TSCONFIG_TYPES = ['node', 'vite/client', 'nw.js'];

interface Args {
  width:   number;
  height:  number;
  title?:  string;
  debug:   boolean;
  init:    boolean;
  version: boolean;
  help:    boolean;
}

interface WindowThisConfig {
  nw?: {
    window?: Record<string, unknown>;
    nodeRemote?: string[] | string;
    chromiumArgs?: string;
    manifest?: Record<string, unknown>;
  };
}

const args = parseArgs();
const binDir = fileURLToPath(new URL('.', import.meta.url));
const pkgJson = JSON.parse(readFileSync(join(binDir, '../package.json'), 'utf-8'));
type ViteProcess = ChildProcessByStdio<null, Readable, Readable>;

if (args.version) {
  console.log(`windowd v${pkgJson.version}`);
  process.exit(0);
}

if (args.help) {
  console.log(`
  windowd v${pkgJson.version}
  Wrap a Vite app in an NW.js host with full renderer Node.js access.

  Usage:
    bun run windowd [options]

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
  ensureNwTypes(cwd);

  const port = await resolveDevPort(5173);
  const viteConfig = createAugmentedViteConfig(cwd);
  const windowThisConfig = await loadWindowThisConfig(cwd);
  try {
    const vite = await startVite(cwd, port, viteConfig.configPath);
    const url    = `http://127.0.0.1:${port}`;
    console.log(`  windowd  ${url}`);

    await openWindow({
      url,
      title:   args.title ?? getTitle(cwd),
      width:   args.width,
      height:  args.height,
      debug:   args.debug,
      projectDir: cwd,
      windowThisConfig,
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
  windowThisConfig: WindowThisConfig;
}

async function openWindow({ url, title, width, height, debug, projectDir, windowThisConfig }: WindowOptions) {
  const closeSignal = await createCloseSignalServer();
  const hostDir = createNwHostApp({
    url,
    title,
    width,
    height,
    debug,
    projectDir,
    closeSignalUrl: closeSignal.url,
    windowThisConfig,
  });
  const nwBin = await getNwBinaryPath();
  const nw = spawn(nwBin, [hostDir], {
    stdio: 'inherit',
    env: process.env,
  });

  try {
    await Promise.race([waitForExit(nw, 'nw'), closeSignal.closed]);
  } finally {
    closeSignal.stop();
    if (!nw.killed) {
      try {
        nw.kill('SIGTERM');
      } catch {
        // ignore cleanup errors
      }
    }
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
  ensureNwTypes(cwd);

  // Now run with the freshly scaffolded project
  const port = await resolveDevPort(5173);
  const viteConfig = createAugmentedViteConfig(cwd);
  const windowThisConfig = await loadWindowThisConfig(cwd);
  try {
    const vite = await startVite(cwd, port, viteConfig.configPath);
    const url    = `http://127.0.0.1:${port}`;
    console.log(`  windowd  ${url}`);

    await openWindow({
      url,
      title: args.title ?? basename(cwd),
      width: args.width,
      height: args.height,
      debug: args.debug,
      projectDir: cwd,
      windowThisConfig,
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
    if (pkg.windowd?.title) return pkg.windowd.title;
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
  const tempDir = mkdtempSync(join(tmpdir(), 'windowd-vite-'));
  const configPath = join(tempDir, 'vite.config.mjs');
  const userConfigPath = getUserViteConfigPath(cwd);
  const userConfigUrl = userConfigPath ? pathToFileURL(userConfigPath).href : null;

  // Auto-inject @vitejs/plugin-react for JSX/TSX projects that have no vite config of their own
  const windowdNodeModulesDir = join(binDir, '..', 'node_modules');
  const reactPluginPath = join(windowdNodeModulesDir, '@vitejs', 'plugin-react', 'dist', 'index.mjs');
  const hasTsxOrJsx = ['main.tsx', 'main.jsx', 'src/main.tsx', 'src/main.jsx', 'index.tsx', 'index.jsx']
    .some(f => existsSync(join(cwd, f)));
  const shouldInjectReactPlugin = !userConfigPath && hasTsxOrJsx && existsSync(reactPluginPath);

  // Build fallback resolve.alias entries for packages windowd ships but the user's project lacks.
  // User's own node_modules always take priority - we only alias what's missing.
  const fallbackAliases: Record<string, string> = {};
  for (const dep of ['react', 'react-dom']) {
    if (!existsSync(join(cwd, 'node_modules', dep)) && existsSync(join(windowdNodeModulesDir, dep))) {
      fallbackAliases[dep] = join(windowdNodeModulesDir, dep);
    }
  }

  const reactPluginImportLine = shouldInjectReactPlugin
    ? `import react from ${JSON.stringify(pathToFileURL(reactPluginPath).href)};`
    : '';

  const configContents = `
import path from "node:path";
${reactPluginImportLine}
function windowThisNodeBuiltins() {
  const virtualPrefix = '\\0windowd-node:';
  return {
    name: 'windowd-nw-node-builtins',
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
  throw new Error("windowd expected Node integration, but globalThis.require is missing.");
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

const basePlugins = [windowThisNodeBuiltins()${shouldInjectReactPlugin ? ', react()' : ''}];
const plugins = Array.isArray(userConfig.plugins)
  ? [...basePlugins, ...userConfig.plugins]
  : basePlugins;

const userServer = userConfig.server ?? {};
const userFs = userServer.fs ?? {};
const userAllow = Array.isArray(userFs.allow) ? userFs.allow : [];
const allow = [...new Set([...defaultFsAllow, ...userAllow])];

const fallbackAliases = ${JSON.stringify(fallbackAliases)};
const userResolve = userConfig.resolve ?? {};
const userAlias = userResolve.alias;
const mergedAlias = Array.isArray(userAlias)
  ? [...Object.entries(fallbackAliases).map(([find, replacement]) => ({ find, replacement })), ...userAlias]
  : { ...fallbackAliases, ...(userAlias ?? {}) };

export default {
  ...userConfig,
  plugins,
  resolve: {
    ...userResolve,
    alias: mergedAlias,
  },
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

async function loadWindowThisConfig(cwd: string): Promise<WindowThisConfig> {
  const configPath = getWindowThisConfigPath(cwd);
  if (!configPath) return {};

  try {
    const loaded = await import(pathToFileURL(configPath).href);
    const config = (loaded?.default ?? loaded) as WindowThisConfig | undefined;
    if (!config || typeof config !== 'object') {
      console.warn('  windowd config loaded but was not an object, ignoring');
      return {};
    }
    console.log(`  loaded ${basename(configPath)}`);
    return config;
  } catch (error) {
    console.warn(`  failed to load ${basename(configPath)}: ${String(error)}`);
    return {};
  }
}

function getWindowThisConfigPath(cwd: string): string | undefined {
  for (const file of WINDOW_THIS_CONFIGS) {
    const abs = join(cwd, file);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

function applyUserManifestOverrides(
  manifest: Record<string, unknown>,
  userManifest: Record<string, unknown> | undefined,
) {
  if (!userManifest) return;

  const protectedKeys = new Set(['main', 'node-main', 'name']);
  for (const [key, value] of Object.entries(userManifest)) {
    if (protectedKeys.has(key)) {
      console.warn(`  ignoring windowd config override for protected manifest key: ${key}`);
      continue;
    }
    manifest[key] = value;
  }
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
  ensureNwTypes(cwd);

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

function ensureNwTypes(cwd: string) {
  const packageJsonPath = join(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) return;

  const nwTypesPath = join(cwd, 'node_modules', '@types', 'nw.js', 'index.d.ts');
  if (existsSync(nwTypesPath)) return;

  console.log('  installing @types/nw.js for TypeScript auto-complete...');
  const result = spawnSync('bun', ['add', '-d', '@types/nw.js'], {
    cwd,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.warn('  could not install @types/nw.js automatically, continuing anyway');
  }
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

interface NwHostOptions extends WindowOptions {
  closeSignalUrl: string;
}

function createNwHostApp({
  url,
  title,
  width,
  height,
  debug,
  projectDir,
  closeSignalUrl,
  windowThisConfig,
}: NwHostOptions): string {
  const hostDir = mkdtempSync(join(tmpdir(), 'windowd-nw-'));
  const startUrl = new URL(url);
  startUrl.searchParams.set('windowThisProjectDir', projectDir);
  const nodeMainPath = join(hostDir, 'windowd-node-main.js');

  const windowConfig: Record<string, unknown> = {
    title,
    width,
    height,
    ...windowThisConfig.nw?.window,
  };

  const manifest: Record<string, unknown> = {
    name: 'windowd-host',
    main: startUrl.toString(),
    'single-instance': false,
    'node-main': 'windowd-node-main.js',
    'node-remote': windowThisConfig.nw?.nodeRemote ?? ['<all_urls>'],
    window: windowConfig,
  };

  const chromiumArgs: string[] = [];
  if (windowThisConfig.nw?.chromiumArgs) chromiumArgs.push(windowThisConfig.nw.chromiumArgs);
  if (debug) chromiumArgs.push('--enable-logging=stderr');
  if (chromiumArgs.length > 0) manifest['chromium-args'] = chromiumArgs.join(' ');

  applyUserManifestOverrides(manifest, windowThisConfig.nw?.manifest);

  writeFileSync(join(hostDir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  writeFileSync(nodeMainPath, buildNodeMainJs(closeSignalUrl), 'utf-8');
  return hostDir;
}

function buildNodeMainJs(closeSignalUrl: string): string {
  return `
(() => {
  const closeSignalUrl = ${JSON.stringify(closeSignalUrl)};
  const signalClose = () => {
    try {
      const http = require('http');
      const req = http.request(closeSignalUrl, { method: 'POST' });
      req.on('error', () => {});
      req.end('closed');
    } catch {}
  };

  const nwApi = typeof globalThis.nw !== 'undefined' ? globalThis.nw : null;
  if (!nwApi || !nwApi.Window || !nwApi.Window.get) {
    console.warn('[windowd] NW API unavailable in node-main.');
    return;
  }

  const withWindow = (fn) => {
    try {
      const win = nwApi.Window.get();
      if (!win) return;
      fn(win);
    } catch {
      // ignore
    }
  };

  const installHandlers = () => withWindow((win) => {
    const openDevTools = () => {
      try {
        if (typeof win.showDevTools !== 'function') {
          console.warn('[windowd] DevTools unavailable, ensure NW.js SDK build is installed.');
          try { alert('[windowd] DevTools unavailable in this NW runtime.'); } catch {}
          return;
        }
        const devtoolsWin = win.showDevTools();
        if (devtoolsWin && typeof devtoolsWin.focus === 'function') {
          devtoolsWin.focus();
        }
      } catch (error) {
        console.error('[windowd] Failed to open DevTools', error);
        try { alert('[windowd] Failed to open DevTools.'); } catch {}
      }
    };

    const menu = new nwApi.Menu();
    menu.append(new nwApi.MenuItem({
      label: 'Inspect / DevTools',
      click: openDevTools,
    }));

    const attachToDocument = () => {
      const doc = win.window && win.window.document;
      if (!doc) return;

      const onContextMenu = (event) => {
        event.preventDefault();
        const x = typeof event.x === 'number' ? event.x : event.clientX;
        const y = typeof event.y === 'number' ? event.y : event.clientY;
        try {
          menu.popup(x, y);
        } catch (error) {
          console.warn('[windowd] Context menu failed, opening DevTools directly.', error);
          openDevTools();
        }
        return false;
      };

      doc.addEventListener('contextmenu', onContextMenu, true);
      win.window.addEventListener('keydown', (event) => {
        const openByF12 = event.key === 'F12';
        const openByShortcut = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'i';
        if (openByF12 || openByShortcut) {
          event.preventDefault();
          openDevTools();
        }
      });

      win.window.addEventListener('beforeunload', signalClose);
      win.window.addEventListener('unload', signalClose);
    };

    if (win.window && win.window.document) {
      attachToDocument();
    } else {
      win.on('loaded', attachToDocument);
    }

    win.on('close', function() {
      signalClose();
      try {
        this.close(true);
      } catch {}
      try {
        nwApi.App.quit();
      } catch {}
      try {
        process.exit(0);
      } catch {}
    });
  });

  installHandlers();

  if (nwApi.App && typeof nwApi.App.on === 'function') {
    nwApi.App.on('window-all-closed', () => {
      signalClose();
      try {
        nwApi.App.quit();
      } catch {}
      try {
        process.exit(0);
      } catch {}
    });
  }
})();
`;
}

async function getNwBinaryPath(): Promise<string> {
  const { findpath } = await import('nw');
  const binPath = await findpath('nwjs', { flavor: 'sdk' });
  if (!existsSync(binPath)) {
    throw new Error(
      `NW.js binary not found at: ${binPath}\n` +
      `  The nw package postinstall did not finish - likely a partial download or extraction failure.\n` +
      `  Clear the npx cache and retry: npx --yes windowd@latest\n` +
      `  Or if running locally: bun install && bun run bin/cli.ts`
    );
  }
  return binPath;
}

interface CloseSignalServer {
  url: string;
  closed: Promise<void>;
  stop: () => void;
}

async function createCloseSignalServer(): Promise<CloseSignalServer> {
  const port = await getEphemeralPort();
  let resolved = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
  });

  const server = createNetServer((socket) => {
    socket.once('data', () => {
      resolveClosed();
      try {
        socket.write('HTTP/1.1 204 No Content\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n');
      } catch {
        // ignore socket write errors
      }
      socket.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    url: `http://127.0.0.1:${port}/closed`,
    closed,
    stop: () => {
      try {
        server.close();
      } catch {
        // ignore
      }
    },
  };
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
