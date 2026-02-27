import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join, basename, extname } from 'node:path';

// ─── constants ────────────────────────────────────────────────────────────────

export const VITE_CONFIGS = [
  'vite.config.js',
  'vite.config.ts',
  'vite.config.mjs',
  'vite.config.cjs',
];

export const WINDOW_THIS_CONFIGS = [
  'windowd-config.ts',
  'windowd-config.js',
  'windowd-config.mjs',
  'windowd-config.cjs',
];

export const REQUIRED_TSCONFIG_OPTIONS: Record<string, unknown> = {
  target: 'ESNext',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  jsx: 'react-jsx',
  noEmit: true,
  skipLibCheck: true,
};

export const REQUIRED_TSCONFIG_TYPES = ['node', 'vite/client', 'nw.js'];

export const SUPPORTED_ICON_EXTS = new Set(['.png', '.ico', '.jpg', '.jpeg']);

// ─── interfaces ───────────────────────────────────────────────────────────────

export interface Args {
  width:   number;
  height:  number;
  title?:  string;
  debug:   boolean;
  init:    boolean;
  version: boolean;
  help:    boolean;
  capture?: string;
  artifacts?: string;
}

export interface WindowThisConfig {
  nw?: {
    window?: Record<string, unknown>;
    nodeRemote?: string[] | string;
    chromiumArgs?: string;
    manifest?: Record<string, unknown>;
  };
}

// ─── functions ────────────────────────────────────────────────────────────────

export function parseArgs(argv = process.argv.slice(2)): Args {
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
    else if (arg === '--capture' && argv[i + 1])                      result.capture = argv[++i];
    else if (arg === '--artifacts' && argv[i + 1])                    result.artifacts = argv[++i];
  }

  return {
    width:   result.width   ?? 1280,
    height:  result.height  ?? 800,
    debug:   result.debug   ?? false,
    init:    result.init    ?? false,
    version: result.version ?? false,
    help:    result.help    ?? false,
    title:   result.title,
    capture: result.capture,
    artifacts: result.artifacts,
  };
}

export function getTitle(cwd: string): string {
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

export function getIconPath(cwd: string): string | null {
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

export function hasTypeScriptSource(dir: string, depth: number): boolean {
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

export function validateExistingTsConfig(tsconfigPath: string):
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

export function isExpectedTsConfigValue(key: string, actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') {
    if (key === 'target' || key === 'module' || key === 'moduleResolution') {
      return actual.toLowerCase() === expected.toLowerCase();
    }
  }
  return actual === expected;
}
