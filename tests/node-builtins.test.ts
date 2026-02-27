import { test, expect, describe } from 'bun:test';
import { windowThisNodeBuiltins, VIRTUAL_PREFIX } from '../src/plugins/node-builtins.ts';

describe('windowThisNodeBuiltins', () => {
  const plugin = windowThisNodeBuiltins();

  describe('resolveId', () => {
    test('resolves node: specifiers to virtual module ID', () => {
      expect(plugin.resolveId('node:fs')).toBe(`${VIRTUAL_PREFIX}node:fs`);
      expect(plugin.resolveId('node:path')).toBe(`${VIRTUAL_PREFIX}node:path`);
      expect(plugin.resolveId('node:os')).toBe(`${VIRTUAL_PREFIX}node:os`);
    });

    test('ignores non-node specifiers', () => {
      expect(plugin.resolveId('react')).toBeNull();
      expect(plugin.resolveId('three')).toBeNull();
      expect(plugin.resolveId('./local.js')).toBeNull();
      expect(plugin.resolveId('fs')).toBeNull();
    });
  });

  describe('load', () => {
    test('generates code with named exports for node:fs', () => {
      const code = plugin.load(`${VIRTUAL_PREFIX}node:fs`);
      expect(code).toBeString();
      expect(code).toContain('globalThis.require');
      expect(code).toContain('export default mod');
      expect(code).toContain('export const readFileSync');
      expect(code).toContain('export const writeFileSync');
      expect(code).toContain('export const existsSync');
    });

    test('generates code with named exports for node:path', () => {
      const code = plugin.load(`${VIRTUAL_PREFIX}node:path`);
      expect(code).toContain('export const join');
      expect(code).toContain('export const resolve');
      expect(code).toContain('export const basename');
    });

    test('generates code with named exports for node:os', () => {
      const code = plugin.load(`${VIRTUAL_PREFIX}node:os`);
      expect(code).toContain('export const platform');
      expect(code).toContain('export const hostname');
    });

    test('returns null for non-virtual IDs', () => {
      expect(plugin.load('react')).toBeNull();
      expect(plugin.load('node:fs')).toBeNull();
      expect(plugin.load('./local.js')).toBeNull();
    });

    test('handles unknown node modules gracefully', () => {
      const code = plugin.load(`${VIRTUAL_PREFIX}node:nonexistent`);
      expect(code).toBeString();
      expect(code).toContain('export default mod');
    });

    test('filters out invalid JS identifiers from exports', () => {
      const code = plugin.load(`${VIRTUAL_PREFIX}node:fs`);
      expect(code).not.toContain('export const default');
    });
  });
});
