import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

export const VIRTUAL_PREFIX = '\0windowd-node:';

export function windowThisNodeBuiltins() {
  return {
    name: 'windowd-nw-node-builtins',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id.startsWith('node:')) return VIRTUAL_PREFIX + id;
      return null;
    },
    load(id: string) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const nodeSpecifier = id.slice(VIRTUAL_PREFIX.length);
      let namedExports = '';
      try {
        const mod = _require(nodeSpecifier);
        const keys = Object.keys(mod).filter(k => k !== 'default' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k));
        namedExports = keys.map(k => `export const ${k} = mod.${k};`).join('\n');
      } catch {}
      return `
const requireFn = globalThis.require;
if (typeof requireFn !== "function") {
  throw new Error("windowd expected Node integration, but globalThis.require is missing.");
}
const mod = requireFn(${JSON.stringify(nodeSpecifier)});
export default mod;
${namedExports}
`;
    },
  };
}
