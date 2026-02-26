![windowd screenshot](docs/ss1.png)

# windowd

Stupidly simple desktop apps. All you need is an `index.html` then `npx windowd` to get a desktop app with Hot Module Reloading.

## Quick start

```bash
mkdir my-app && cd my-app
```

Create an `index.html`:

```html
<!DOCTYPE html>
<html>
  <body>
    <h1>Hello from the desktop</h1>
    <pre id="info"></pre>
    <script type="module">
      import os from 'node:os';
      document.getElementById('info').textContent =
        `Running on ${os.platform()} with Node ${process.version}`;
    </script>
  </body>
</html>
```

Run it:

```bash
npx windowd
```

That's it. You get a desktop window with Vite HMR and full Node.js APIs available in your code.

## What you get

- **Single command** to run any `index.html` or Vite project as a desktop app
- **Full Node.js APIs in the renderer** - `node:fs`, `node:child_process`, `process`, `require`, all of it
- **Vite dev server + HMR** - instant hot reload as you edit
- **Zero config** - no `package.json`, no build setup, no Vite config needed to start
- **Auto-scaffolding** - run `npx windowd` in an empty folder and pick a template
- **TypeScript ready** - auto-generates `tsconfig.json` and installs NW.js types when TypeScript files are detected

## Using Node.js in the renderer

Yeah, this isn't the safest thing in the world but so long as you're running your own trusted code then YOLO 🤷‍♂️ What it does get you is all the power of a desktop app and all the power of a web app, all in one. Read files, spawn processes, grab system info, then render it all with React:

```tsx
import { readFileSync } from 'node:fs';
import os from 'node:os';
import React from 'react';
import { createRoot } from 'react-dom/client';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const cpus = os.cpus().length;
const mem = Math.round(os.totalmem() / 1024 / 1024 / 1024);

function App() {
  return (
    <div>
      <h1>{pkg.name} v{pkg.version}</h1>
      <p>{cpus} cores, {mem} GB RAM, {os.platform()}</p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
```

> **⚠️ Warning ⚠️** any script running in your app can read/write files, run shell commands, and access the network with full OS-level permissions. Only run code you trust.

## Scaffolding a new project

Run `npx windowd` in an empty directory (no `index.html` or Vite config) and you'll get an interactive prompt:

```
? What would you like to do?
> Scaffold a React + TypeScript project here
  Scaffold a vanilla HTML + TypeScript project
  Exit
```

Pick a template and windowd will scaffold it, install dependencies, and launch the app immediately.

## CLI options

```bash
npx windowd                            # run in current directory
npx windowd --width 1440 --height 900  # custom window size
npx windowd --title "My App"           # custom window title
npx windowd --debug                    # extra NW.js logging
npx windowd --init                     # create/validate tsconfig.json
npx windowd --version
npx windowd --help
```

## TypeScript

windowd auto-detects TypeScript and handles setup for you:

- **tsconfig.json** generated automatically when `.ts`/`.tsx` files are present and no tsconfig exists
- **@types/nw.js** installed automatically for NW.js API autocomplete (`nw.Window`, `nw.Menu`, etc.)
- **Vite + React plugin** auto-injected for `.tsx`/`.jsx` projects without their own Vite config

Run `npx windowd --init` to validate an existing `tsconfig.json` and see which recommended settings are missing.

## Configuration

Create a `windowd-config.ts` (or `.js`, `.mjs`, `.cjs`) in your project root to customize NW.js behavior:

```ts
export default {
  nw: {
    window: {
      frame: false,
      always_on_top: true,
    },
    chromiumArgs: "--disable-background-timer-throttling",
    nodeRemote: ["<all_urls>"],
  },
};
```

You can also set `nw.manifest` to add extra NW.js manifest fields. Core runtime keys (`name`, `main`, `node-main`) are protected and cannot be overridden.

## Window title and icon

windowd picks these up automatically so the window feels native without extra configuration.

**Title** resolution order:

1. `--title` CLI flag
2. `windowd.title` in `package.json`
3. `displayName` in `package.json`
4. `name` in `package.json`
5. `<title>` tag in `index.html`
6. Directory name as fallback

**Icon** resolution order:

1. `window.icon` in `windowd-config.ts`
2. `<link rel="icon">` in `index.html` (PNG, ICO, JPG supported, SVG is skipped)
3. `favicon.ico` / `favicon.png` / `favicon.jpg` in project root or `public/`
4. Built-in default icon ([application_xp](https://github.com/legacy-icons/famfamfam-silk) from famfamfam-silk)

## DevTools

- Right-click anywhere to open from the context menu
- `F12` or `Ctrl+Shift+I` (`Cmd+Shift+I` on macOS)

DevTools require the NW.js SDK build, which windowd installs by default.

## Requirements

- **Node.js >= 18** (or Bun >= 1.0)
- **~200 MB disk space** for the NW.js runtime, downloaded automatically on first run

## How it works

1. `windowd` starts a Vite dev server on an ephemeral port
2. A temporary NW.js host app is generated with Node integration enabled
3. NW.js opens your app URL with full `node-remote` access
4. When the window closes, Vite and the host app are cleaned up automatically

## Example apps

The repo includes test apps you can run to see different features in action:

```bash
git clone https://github.com/mikecann/windowd.git
cd windowd
bun install
bun run test-app <name>
```

| Name | Command | What it demonstrates |
|---|---|---|
| `basics` | `bun run test-app basics` | React + TypeScript, `node:fs` directory listing, Vite asset imports, NW.js window APIs (minimize, maximize, always-on-top, child windows) |
| `config` | `bun run test-app config` | Frameless window via `windowd-config.ts`, shows how to customize NW.js settings |
| `deps` | `bun run test-app deps` | Third-party npm package (`canvas-confetti`) alongside Node.js APIs, has its own `package.json` |
| `justhtml` | `bun run test-app justhtml` | Plain HTML with zero config, no TypeScript, no `package.json`, HMR still works |
