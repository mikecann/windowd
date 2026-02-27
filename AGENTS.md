# Releasing windowd

## Version bump + commit + tag

1. Bump `version` in `package.json`
2. Commit: `git add bin/cli.ts package.json ... && git commit -m "Release vX.Y.Z."`
3. Tag: `git tag vX.Y.Z`
4. Push: `git push origin main --tags`

## npm publish

Publishing is handled automatically by the **npm Trusted Publisher** (OIDC) flow - pushing the tag triggers it via CI. Do NOT run `npm publish` manually.

The workflow uses `--provenance` with `permissions: id-token: write`. No secrets are needed in the repo.

Requirements for the workflow:
- `npm install -g npm@latest` step BEFORE publishing - the runner's bundled npm is too old to handle OIDC auth
- `registry-url: 'https://registry.npmjs.org'` in `setup-node` so npm knows the registry
- `repository.url` in `package.json` pointing to the GitHub repo - provenance verification requires it
- No `NODE_AUTH_TOKEN` secret needed in the repo

## Versioning guide

- Patch (0.x.Y): bug fixes only
- Minor (0.X.0): new features or meaningful UX improvements
- The project is pre-1.0 so minor bumps are fine for anything non-trivial

---

# Key implementation notes

## nw dependency - must be pinned to exact SDK version

`"nw": "0.104.1-sdk"` - no caret, no range. Using `^0.104.1-sdk` lets npm resolve to the
higher stable release `0.104.1` (non-SDK) because stable beats prerelease in semver range
resolution. That means the SDK DevTools binary never gets installed and `findpath` fails.

**Do not bump past 0.104.1-sdk.** Native window menu bars (`win.menu = menubar`) are
completely broken from NW.js 0.105.0 onwards - the menu silently fails to render.
This is a confirmed open bug (https://github.com/nwjs/nw.js/issues/8317) with no fix as of
Feb 2026. When that issue is resolved, test menus before bumping.

When bumping to a new NW.js version, update the exact pin in `package.json` and test.

## findpath - do not hardcode flavor

Call `findpath('nwjs')` without `{ flavor: 'sdk' }`. The `parse.js` inside the nw package
auto-detects the flavor from the installed nw `package.json` version (looks for `-sdk` in the
prerelease tag). Hardcoding `{ flavor: 'sdk' }` causes a mismatch if npm ever resolves to
the non-SDK package.

## nw postinstall always exits 0

`nw/src/postinstall.js` catches ALL errors (not just EPERM) and exits with code 0 even on
failure. When spawning it to repair a missing binary, always check `existsSync(binPath)` after
it completes to detect silent failures. Pass `NWJS_CACHE: 'false'` in the env to force
deletion of any potentially corrupt/truncated zip from a previous failed install before
re-downloading.

## React/react-dom fallback aliases - use createRequire, not a guessed path

When computing the fallback `resolve.alias` entries for projects that don't have React in their
own `node_modules`, use `createRequire(import.meta.url).resolve('pkg/package.json')` to find
the actual installed location. The old approach of `join(binDir, '..', 'node_modules', dep)`
breaks when running via npx/npm because npm hoists dependencies - React ends up as a sibling
of `windowd` in the npx cache, not inside `windowd/node_modules/`.

Same applies to `@vitejs/plugin-react` path resolution.

## Vite cacheDir - redirect to OS temp

Always set `cacheDir` in the generated Vite config to a path outside the user's project.
Default Vite behavior creates `node_modules/.vite` (or `.vite`) in the project root which
pollutes projects that don't have their own `node_modules`. Use a stable per-project path:
`join(tmpdir(), 'windowd-vite-cache', sha256(projectDir).slice(0, 8))`.

## Vite version policy

Stay on the latest stable Vite 7.x. Vite 8 (Rolldown-powered) is promising but was still in
beta as of early 2026 - the bundler swap could affect the node:* shim plugin and other
internals. Upgrade to 8 once it goes stable and test thoroughly.
