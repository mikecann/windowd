# window-this

> Wrap any Vite project in a native OS WebView - no Electron, no bundled Chromium.

```bash
npx window-this
```

---

## Why this exists

I wanted a desktop app framework that sits between two tools I like but find limiting:

**[Neutralino.js](https://neutralino.js.org/)** is great because it uses the OS's native
WebView (WebView2 on Windows, WKWebView on macOS) instead of shipping a 150MB copy of
Chromium. Apps start instantly and are tiny to distribute. The problem is the renderer is
sandboxed - you talk to native APIs through a limited IPC bridge, not full Node.js.

**[NW.js](https://nwjs.io/)** solves that by giving you full Node.js access directly in
the renderer, so you can `require('fs')`, `require('child_process')`, etc. from the same
JS context as your UI. The tradeoff: it bundles Chromium, so you're back to 150MB+.

What I actually want is the **best of both**: the OS's native WebView (fast, small,
no bundled browser) with **full, unrestricted Node.js access** in the renderer. Yes, that
means the renderer can read your filesystem, run shell commands, and do anything Node.js
can. That's the point. It's a desktop app - you own the machine.

On top of that, I want **Vite** handling the dev experience: TypeScript bundling,
React/JSX, and hot module replacement so edits appear instantly without restarting
the app.

So: **window-this** = Neutralino's tiny footprint + NW.js's Node.js access + Vite's
dev experience, wrapped in a single `npx` command with zero config.

---

## How it works

1. You run `npx window-this` (or `bun run window-this`) in any directory with
   an `index.html` or `vite.config.*`
2. A Vite dev server starts on `127.0.0.1:5173`
3. A native OS WebView window opens and loads your app
4. File changes trigger hot reloads

No config file needed. No project boilerplate. If there's no project yet, it offers to
scaffold one (React + TypeScript or plain vanilla).

---

## Stack

| Piece | Role |
|---|---|
| [webview-nodejs](https://github.com/Wintermute0110/webview-nodejs) | Native WebView2 / WKWebView window |
| [Vite](https://vitejs.dev/) | Dev server, HMR, TypeScript/JSX bundling |
| [Bun](https://bun.sh/) | CLI runtime (fast, native TS support) |
| [koffi](https://koffi.dev/) | FFI calls to the webview C library from worker threads |

---

## Usage

```bash
# Run in a directory with a vite.config.* or index.html
cd my-app
npx window-this

# Options
npx window-this --width 1440 --height 900
npx window-this --title "My App"
npx window-this --debug        # opens DevTools
```

### As a dev dependency

```bash
bun add -d window-this
```

```json
{
  "scripts": {
    "dev": "window-this"
  }
}
```

---

## Requirements

- **Windows**: WebView2 runtime (ships with Windows 11, available for Windows 10)
- **macOS / Linux**: WKWebView / GTK WebKit (untested - WebView2 focus for now)
- **Bun** >= 1.0 or **Node.js** >= 18

---

## Status

Early / experimental. HMR is a work in progress - see `HMR-DEBUG.md` for the current
investigation into a Bun `node:worker_threads` async I/O bug that prevents the reload
worker from receiving events.
