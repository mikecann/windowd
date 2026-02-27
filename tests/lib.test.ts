import { test, expect, describe } from 'bun:test';
import { join, resolve, basename } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  parseArgs,
  getTitle,
  getIconPath,
  hasTypeScriptSource,
  validateExistingTsConfig,
  isExpectedTsConfigValue,
  REQUIRED_TSCONFIG_OPTIONS,
  REQUIRED_TSCONFIG_TYPES,
} from '../src/lib.ts';

const testAppsDir = resolve(import.meta.dir, '..', 'test-apps');

// ─── parseArgs ────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  test('defaults when no args', () => {
    const args = parseArgs([]);
    expect(args.width).toBe(1280);
    expect(args.height).toBe(800);
    expect(args.debug).toBe(false);
    expect(args.init).toBe(false);
    expect(args.version).toBe(false);
    expect(args.help).toBe(false);
    expect(args.title).toBeUndefined();
    expect(args.capture).toBeUndefined();
  });

  test('parses long flags', () => {
    const args = parseArgs(['--width', '800', '--height', '600', '--debug', '--title', 'My App']);
    expect(args.width).toBe(800);
    expect(args.height).toBe(600);
    expect(args.debug).toBe(true);
    expect(args.title).toBe('My App');
  });

  test('parses short flags', () => {
    const args = parseArgs(['-W', '1024', '-H', '768', '-d', '-t', 'Test']);
    expect(args.width).toBe(1024);
    expect(args.height).toBe(768);
    expect(args.debug).toBe(true);
    expect(args.title).toBe('Test');
  });

  test('parses --version and --help', () => {
    expect(parseArgs(['--version']).version).toBe(true);
    expect(parseArgs(['-v']).version).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  test('parses --init', () => {
    expect(parseArgs(['--init']).init).toBe(true);
    expect(parseArgs(['-i']).init).toBe(true);
  });

  test('parses --capture', () => {
    const args = parseArgs(['--capture', '/tmp/out']);
    expect(args.capture).toBe('/tmp/out');
  });

  test('parses --artifacts', () => {
    const args = parseArgs(['--artifacts', '/tmp/artifacts']);
    expect(args.artifacts).toBe('/tmp/artifacts');
  });

  test('ignores --width without a following value', () => {
    const args = parseArgs(['--width']);
    expect(args.width).toBe(1280);
  });

  test('handles multiple flags together', () => {
    const args = parseArgs(['--debug', '--init', '--capture', '/out', '-W', '500']);
    expect(args.debug).toBe(true);
    expect(args.init).toBe(true);
    expect(args.capture).toBe('/out');
    expect(args.width).toBe(500);
  });
});

// ─── getTitle ─────────────────────────────────────────────────────────────────

describe('getTitle', () => {
  test('reads <title> from justhtml index.html', () => {
    expect(getTitle(join(testAppsDir, 'justhtml'))).toBe('windowd justhtml');
  });

  test('reads <title> from basics index.html (has package.json but no name)', () => {
    const title = getTitle(join(testAppsDir, 'basics'));
    expect(title).toBe('windowd basics');
  });

  test('reads package.json name when available', () => {
    const title = getTitle(join(testAppsDir, 'deps'));
    expect(title).toBeTruthy();
  });

  test('falls back to directory name when no package.json or index.html', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'windowd-test-title-'));
    expect(getTitle(tmpDir)).toBe(basename(tmpDir));
  });
});

// ─── getIconPath ──────────────────────────────────────────────────────────────

describe('getIconPath', () => {
  test('finds icon from <link rel="icon"> in basics', () => {
    const icon = getIconPath(join(testAppsDir, 'basics'));
    if (icon) {
      expect(icon).toContain('bug.png');
    }
  });

  test('returns null when no icon found', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'windowd-test-icon-'));
    expect(getIconPath(tmpDir)).toBeNull();
  });
});

// ─── hasTypeScriptSource ──────────────────────────────────────────────────────

describe('hasTypeScriptSource', () => {
  test('finds .tsx files in basics', () => {
    expect(hasTypeScriptSource(join(testAppsDir, 'basics'), 0)).toBe(true);
  });

  test('returns false for justhtml (no .ts/.tsx files)', () => {
    expect(hasTypeScriptSource(join(testAppsDir, 'justhtml'), 0)).toBe(false);
  });

  test('returns false for empty directory', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'windowd-test-ts-'));
    expect(hasTypeScriptSource(tmpDir, 0)).toBe(false);
  });

  test('respects depth limit', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'windowd-test-depth-'));
    const deep = join(tmpDir, 'a', 'b', 'c', 'd', 'e', 'f');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'app.tsx'), 'export default 1;');
    expect(hasTypeScriptSource(tmpDir, 0)).toBe(false);
  });

  test('ignores .d.ts files', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'windowd-test-dts-'));
    writeFileSync(join(tmpDir, 'types.d.ts'), 'declare module "x" {}');
    expect(hasTypeScriptSource(tmpDir, 0)).toBe(false);
  });
});

// ─── validateExistingTsConfig ─────────────────────────────────────────────────

describe('validateExistingTsConfig', () => {
  test('reports no missing for a valid tsconfig', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'windowd-test-tsconfig-'));
    const path = join(tmpDir, 'tsconfig.json');
    writeFileSync(path, JSON.stringify({
      compilerOptions: {
        ...REQUIRED_TSCONFIG_OPTIONS,
        types: REQUIRED_TSCONFIG_TYPES,
      },
    }));
    const result = validateExistingTsConfig(path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.missing).toHaveLength(0);
  });

  test('reports missing options', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'windowd-test-tsconfig-'));
    const path = join(tmpDir, 'tsconfig.json');
    writeFileSync(path, JSON.stringify({ compilerOptions: {} }));
    const result = validateExistingTsConfig(path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.missing.length).toBeGreaterThan(0);
  });

  test('returns error for invalid JSON', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'windowd-test-tsconfig-'));
    const path = join(tmpDir, 'tsconfig.json');
    writeFileSync(path, 'not json');
    const result = validateExistingTsConfig(path);
    expect(result.ok).toBe(false);
  });
});

// ─── isExpectedTsConfigValue ──────────────────────────────────────────────────

describe('isExpectedTsConfigValue', () => {
  test('case-insensitive for target/module/moduleResolution', () => {
    expect(isExpectedTsConfigValue('target', 'esnext', 'ESNext')).toBe(true);
    expect(isExpectedTsConfigValue('module', 'ESNEXT', 'ESNext')).toBe(true);
    expect(isExpectedTsConfigValue('moduleResolution', 'bundler', 'Bundler')).toBe(true);
  });

  test('case-sensitive for other keys', () => {
    expect(isExpectedTsConfigValue('jsx', 'react-jsx', 'react-jsx')).toBe(true);
    expect(isExpectedTsConfigValue('jsx', 'React-JSX', 'react-jsx')).toBe(false);
  });

  test('strict equality for booleans', () => {
    expect(isExpectedTsConfigValue('noEmit', true, true)).toBe(true);
    expect(isExpectedTsConfigValue('noEmit', false, true)).toBe(false);
  });
});
