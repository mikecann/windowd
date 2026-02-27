#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname, extname } from 'node:path';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { select } from '@inquirer/prompts';
import { findpath as nwFindpath } from 'nw';

const _require = createRequire(import.meta.url);


function resolveOwnPackageDir(packageName: string): string | null {
  try {
    return dirname(_require.resolve(`${packageName}/package.json`));
  } catch {
    return null;
  }
}

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
const SUPPORTED_ICON_EXTS = new Set(['.png', '.ico', '.jpg', '.jpeg']);
const DEFAULT_ICON_PATH   = join(binDir, '../assets/default-icon.png');

// ─── terminal status line ─────────────────────────────────────────────────────

const IS_TTY   = !!process.stdout.isTTY;
const BLUE     = IS_TTY ? '\x1b[34m' : '';
const GREEN    = IS_TTY ? '\x1b[32m' : '';
const RESET    = IS_TTY ? '\x1b[0m'  : '';
const CLR_LINE = IS_TTY ? '\r\x1b[2K' : '';

let _statusLen = 0;

function setStatus(msg: string, done = false) {
  const symbol = done ? `${GREEN}✓${RESET}` : `${BLUE}●${RESET}`;
  const line   = `  ${symbol} ${msg}`;
  if (IS_TTY) {
    const pad = ' '.repeat(Math.max(0, _statusLen - line.length));
    process.stdout.write(`${CLR_LINE}${line}${pad}`);
    _statusLen = done ? 0 : line.length;
    if (done) process.stdout.write('\n');
  } else if (done) {
    process.stdout.write(`  ✓ ${msg}\n`);
  }
}
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

  setStatus('starting...');

  if (shouldAutoCreateTsConfig(cwd)) ensureTsConfig(cwd);
  ensureNwTypes(cwd);

  const nwBin = await ensureNwBinary();

  setStatus('starting...');

  const port = await getEphemeralPort();
  const viteConfig = createAugmentedViteConfig(cwd);
  const windowThisConfig = await loadWindowThisConfig(cwd);
  const title = args.title ?? getTitle(cwd);

  setStatus('starting vite...');

  try {
    const vite = await startVite(cwd, port, viteConfig.configPath);
    const url = `http://127.0.0.1:${port}`;

    setStatus('opening window...');

    await openWindow({
      url,
      title,
      width:  args.width,
      height: args.height,
      debug:  args.debug,
      nwBin,
      projectDir: cwd,
      windowThisConfig,
      onReady: () => setStatus(`${title}    ${url}`, true),
    });

    stopVite(vite);
  } finally {
    removeAugmentedViteConfig(viteConfig);
  }

  process.exit(0);
}

// ─── vite ────────────────────────────────────────────────────────────────────

async function startVite(cwd: string, port: number, configPath: string): Promise<ViteProcess> {
  const vite = spawn(
    'bun',
    ['x', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--config', configPath],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  vite.stdout.on('data', () => { /* keep pipe drained */ });
  vite.stderr.on('data', (chunk: Buffer | string) => {
    process.stderr.write(chunk);
  });

  await waitForServer(`http://127.0.0.1:${port}`);
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
  nwBin:  string;
  projectDir: string;
  windowThisConfig: WindowThisConfig;
  onReady?: () => void;
}

async function openWindow({ url, title, width, height, debug, nwBin, projectDir, windowThisConfig, onReady }: WindowOptions) {
  const closeSignal = await createCloseSignalServer();
  const hostDir = createNwHostApp({
    url,
    title,
    width,
    height,
    debug,
    nwBin,
    projectDir,
    closeSignalUrl: closeSignal.url,
    windowThisConfig,
  });
  const nw = spawn(nwBin, [hostDir], {
    stdio: 'inherit',
    env: process.env,
  });
  onReady?.();

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
  const nwBin = await ensureNwBinary();
  const port = await getEphemeralPort();
  const viteConfig = createAugmentedViteConfig(cwd);
  const windowThisConfig = await loadWindowThisConfig(cwd);
  const title = basename(cwd);
  setStatus('starting vite...');
  try {
    const vite = await startVite(cwd, port, viteConfig.configPath);
    const url = `http://127.0.0.1:${port}`;

    setStatus('opening window...');
    await openWindow({
      url,
      title,
      width: args.width,
      height: args.height,
      debug: args.debug,
      nwBin,
      projectDir: cwd,
      windowThisConfig,
      onReady: () => setStatus(`${title}    ${url}`, true),
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

function getIconPath(cwd: string): string | null {
  // 1. Check index.html for <link rel="icon"> or <link rel="shortcut icon">
  try {
    const html = readFileSync(join(cwd, 'index.html'), 'utf-8');
    const m =
      html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i) ??
      html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i);
    if (m?.[1]) {
      const href = m[1];
      if (!href.startsWith('data:') && !href.startsWith('http')) {
        const rel = href.startsWith('/') ? href.slice(1) : href;
        const abs = join(cwd, rel);
        if (SUPPORTED_ICON_EXTS.has(extname(abs).toLowerCase()) && existsSync(abs)) {
          return abs;
        }
      }
    }
  } catch { /* ignore */ }

  // 2. Fallback - check common favicon files in project root
  for (const name of ['favicon.ico', 'favicon.png', 'favicon.jpg']) {
    const abs = join(cwd, name);
    if (existsSync(abs)) return abs;
  }
  for (const name of ['public/favicon.ico', 'public/favicon.png', 'public/favicon.jpg']) {
    const abs = join(cwd, name);
    if (existsSync(abs)) return abs;
  }

  return null;
}

interface AugmentedViteConfig {
  tempDir: string;
  configPath: string;
}

function createAugmentedViteConfig(cwd: string): AugmentedViteConfig {
  const tempDir = mkdtempSync(join(tmpdir(), 'windowd-vite-'));
  const configPath = join(tempDir, 'vite.config.mjs');
  // Stable per-project cache dir in OS temp - keeps .vite out of the user's project entirely
  const projectHash = createHash('sha256').update(cwd).digest('hex').slice(0, 8);
  const viteCacheDir = join(tmpdir(), 'windowd-vite-cache', projectHash);
  const userConfigPath = getUserViteConfigPath(cwd);
  const userConfigUrl = userConfigPath ? pathToFileURL(userConfigPath).href : null;

  // Auto-inject @vitejs/plugin-react for JSX/TSX projects that have no vite config of their own
  const reactPluginDir = resolveOwnPackageDir('@vitejs/plugin-react');
  const reactPluginPath = reactPluginDir ? join(reactPluginDir, 'dist', 'index.mjs') : null;
  const hasTsxOrJsx = ['main.tsx', 'main.jsx', 'src/main.tsx', 'src/main.jsx', 'index.tsx', 'index.jsx']
    .some(f => existsSync(join(cwd, f)));
  const shouldInjectReactPlugin = !userConfigPath && hasTsxOrJsx && !!reactPluginPath && existsSync(reactPluginPath);

  // Build fallback resolve.alias entries for packages windowd ships but the user's project lacks.
  // User's own node_modules always take priority - we only alias what's missing.
  // Use module resolution (not a guessed path) so this works whether deps are nested or hoisted.
  const fallbackAliases: Record<string, string> = {};
  for (const dep of ['react', 'react-dom']) {
    if (!existsSync(join(cwd, 'node_modules', dep))) {
      const resolved = resolveOwnPackageDir(dep);
      if (resolved) fallbackAliases[dep] = resolved;
    }
  }

  const reactPluginImportLine = shouldInjectReactPlugin && reactPluginPath
    ? `import react from ${JSON.stringify(pathToFileURL(reactPluginPath).href)};`
    : '';

  const configContents = `
import path from "node:path";
import { createRequire as _createRequire } from "node:module";
const _require = _createRequire(import.meta.url);
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
      let namedExports = '';
      try {
        const mod = _require(nodeSpecifier);
        const keys = Object.keys(mod).filter(k => k !== 'default' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k));
        namedExports = keys.map(k => \`export const \${k} = mod.\${k};\`).join('\\n');
      } catch {}
      return \`
const requireFn = globalThis.require;
if (typeof requireFn !== "function") {
  throw new Error("windowd expected Node integration, but globalThis.require is missing.");
}
const mod = requireFn(\${JSON.stringify(nodeSpecifier)});
export default mod;
\${namedExports}
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
  cacheDir: ${JSON.stringify(viteCacheDir)},
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

function shouldAutoCreateTsConfig(cwd: string): boolean {
  if (existsSync(join(cwd, 'tsconfig.json'))) return true;

  // Only auto-create tsconfig when the project appears to actually use TypeScript.
  return hasTypeScriptSource(cwd, 0);
}

function hasTypeScriptSource(dir: string, depth: number): boolean {
  if (depth > 5) return false;

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (hasTypeScriptSource(join(dir, entry.name), depth + 1)) return true;
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    return true;
  }

  return false;
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
  // nwBin not needed here - used by caller
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

  // Auto-detect icon unless the user already set one via windowd-config.
  // We resolve the absolute dest path so we can pass it to node-main for win.setIcon(),
  // which is more reliable than the manifest window.icon field on Windows.
  let resolvedIconDest: string | null = null;
  if (!windowConfig.icon) {
    const iconSrc = getIconPath(projectDir) ?? DEFAULT_ICON_PATH;
    const iconExt = extname(iconSrc);
    const iconDest = join(hostDir, `windowd-icon${iconExt}`);
    try {
      copyFileSync(iconSrc, iconDest);
      windowConfig.icon = `windowd-icon${iconExt}`;
      resolvedIconDest = iconDest;
    } catch { /* icon is cosmetic - ignore copy failures */ }
  }

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
  writeFileSync(nodeMainPath, buildNodeMainJs(closeSignalUrl, resolvedIconDest), 'utf-8');
  return hostDir;
}

function buildNodeMainJs(closeSignalUrl: string, iconPath: string | null): string {
  return `
(() => {
  const closeSignalUrl = ${JSON.stringify(closeSignalUrl)};
  const iconPath = ${JSON.stringify(iconPath)};
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
    if (iconPath && typeof win.setIcon === 'function') {
      try { win.setIcon(iconPath); } catch {}
    }

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

async function ensureNwBinary(): Promise<string> {
  // No explicit flavor - parse.js auto-detects from the installed nw package.json version.
  // This avoids the mismatch when npm resolves "^0.108.0-sdk" to the non-sdk stable release.
  const binPath = await nwFindpath('nwjs');
  if (existsSync(binPath)) return binPath;

  // Binary missing - re-run nw's own postinstall to download it.
  // NWJS_CACHE=false forces deletion of any existing (potentially corrupt) zip so we get a
  // clean download rather than trying to decompress a truncated file from the first install.
  process.stdout.write('  NW.js runtime not found, downloading (~200 MB, first run only)...\n');
  const spinner = startSpinner('downloading NW.js runtime');

  try {
    const nwPkgDir = dirname(_require.resolve('nw/package.json'));
    const postinstallPath = join(nwPkgDir, 'src', 'postinstall.js');

    let stderr = '';
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('node', [postinstallPath], {
        cwd: nwPkgDir,
        stdio: 'pipe',
        env: { ...process.env, NWJS_CACHE: 'false' },
      });

      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `postinstall exited with code ${code}`));
      });
    });

    stopSpinner(spinner, 'NW.js runtime ready');

    // postinstall.js catches all errors and always exits 0, so check binary exists
    if (!existsSync(binPath)) {
      const detail = stderr.trim();
      throw new Error(detail || 'binary still missing after download (check disk space and permissions)');
    }

    return binPath;
  } catch (err) {
    stopSpinner(spinner, '');
    throw new Error(`Failed to download NW.js runtime: ${err}`);
  }
}

function startSpinner(label: string): ReturnType<typeof setInterval> {
  const frames = ['-', '\\', '|', '/'];
  let i = 0;
  process.stdout.write(`  ${frames[0]} ${label}`);
  return setInterval(() => {
    process.stdout.write(`\r  ${frames[++i % frames.length]} ${label}`);
  }, 100);
}

function stopSpinner(timer: ReturnType<typeof setInterval>, finalLine: string) {
  clearInterval(timer);
  const clear = '\r' + ' '.repeat(60) + '\r';
  if (finalLine) {
    process.stdout.write(`${clear}  ${finalLine}\n`);
  } else {
    process.stdout.write(clear);
  }
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
