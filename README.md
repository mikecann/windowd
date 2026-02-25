# window-this

> Wrap any Vite project in an NW.js app shell with direct renderer Node.js access.

```bash
npx @mike.cann/window-this
```

## What this gives you

- Single command to run any `index.html`/Vite project as a desktop app
- Full Node.js APIs in renderer code (`require`, `process`, `node:*`)
- Vite dev server + HMR
- Auto setup for common zero-config workflows:
  - auto-generated Vite config wrapper
  - auto-generated `tsconfig.json` when missing
  - `node:*` import shim for NW runtime

## How it works

1. Run `window-this` in a project directory
2. Vite starts on localhost
3. A temporary NW host app is generated and launched
4. Your app loads in NW with Node enabled for remote page

When the app window closes, the CLI exits and Vite is shut down.

## Usage

```bash
# inside your project directory
npx @mike.cann/window-this

# options
npx @mike.cann/window-this --width 1440 --height 900
npx @mike.cann/window-this --title "My App"
npx @mike.cann/window-this --debug
npx @mike.cann/window-this --init
```

### `--init`

`--init` creates a minimal `tsconfig.json` if missing, or validates an existing one
and warns if required Node + Vite settings are missing.

## DevTools

- Right-click -> `Inspect / DevTools`
- Keyboard: `F12` or `Ctrl+Shift+I` (`Cmd+Shift+I` on macOS)

## Requirements

- Node.js >= 18 or Bun >= 1.0
- NW.js runtime is downloaded via the `nw` package (SDK flavor for DevTools)

## Notes

- This is intentionally an unrestricted desktop model, renderer code can use Node APIs.
- The included `test-app` demonstrates:
  - PNG import via Vite
  - runtime file loading with `fs.readFileSync`
  - React + HMR behavior in NW
