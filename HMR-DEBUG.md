# HMR Debug Handoff

## What instantly-native is

A CLI tool (`npx instantly-native` / `bun run test-app`) that:
1. Starts a Vite dev server programmatically in the current directory
2. Opens the app in a native OS WebView2 window (via `webview-nodejs`)
3. Should hot-reload the WebView when source files change

Run: `cd c:\dev\me\instantly-native && bun run test-app`

---

## The Core Problem

`wv.show()` (from `webview-nodejs`) **blocks the main Bun/Node.js JS event loop
completely** until the window is closed. This means:

- Vite's file watcher (chokidar) events stop firing in the main thread
- Any `setInterval`, `fs.watch`, WebSocket listeners, etc. in the main thread
  all stop processing

The only JS that can run while the window is open is in a `node:worker_threads`
Worker, because that gets its own OS thread and its own event loop.

---

## Architecture

```
Main thread (Bun)
  ├── createViteServer() - Vite dev server (stops processing events after wv.show())
  ├── new Webview() - creates WebView2 window
  ├── new NodeWorker('../src/reload-worker.ts') - starts HMR worker
  └── wv.show() ← BLOCKS HERE FOREVER until window closed

Worker thread (node:worker_threads)
  ├── loads koffi + webview DLL (koffi works here - same process address space)
  ├── BigInt handle addr received from main thread via workerData
  └── goal: detect file changes → fetch new HTML from Vite → call webview_set_html(handle, html)
```

The key insight: `webview_set_html()` in the webview C library uses `PostThreadMessage`
internally, so it is safe to call from any thread. The main thread's Win32 message loop
(running inside `wv.show()`) will pick it up.

Key files:
- `bin/cli.ts` - main entry point
- `src/reload-worker.ts` - worker that should trigger reloads

---

## What has been confirmed working

- WebView renders HTML correctly via `wv.html(initialHtml)`
- `koffi.load()` and `lib.func('webview_set_html', ...)` load correctly in the worker
- The `webview_set_html(handle, html)` call itself works (tested in the initial HMR test
  in the previous session, though that may have only worked because it was called before
  `wv.show()` blocked)
- `setInterval` / `setTimeout` timers fire correctly in the worker
- `koffi.address(wv.unsafeHandle)` gives a BigInt, converted to string, passed to
  the worker via `workerData`, then `BigInt(handleAddr)` reconstructs it

---

## What does NOT work in the worker (Bun node:worker_threads bug)

Confirmed broken - these all hang silently, no events ever fire:

1. **Native `WebSocket` global** - `new WebSocket('ws://127.0.0.1:5173/', 'vite-hmr')`
   - `onopen`, `onclose`, `onerror` never fire
   - Connected to Vite's HMR WebSocket

2. **`ws` npm package (v8.19.0)** - same behavior, no events
   - `ws.on('open', ...)`, `ws.on('error', ...)` never fire
   - URL tried: `ws://127.0.0.1:5173/?hmr` with subprotocol `vite-hmr`
   - Also tried without `?hmr` and without subprotocol

3. **`node:fs.watch`** - `watch(rootDir, { recursive: true }, callback)` - callback
   never fires even when files change

4. **`fetch()`** - `await fetch('http://127.0.0.1:5173/')` - Promise never resolves
   (this was discovered last - even basic HTTP fetch hangs)

**Summary**: In Bun's `node:worker_threads`, timers work but ALL async I/O is broken
(network and filesystem). This is almost certainly a Bun bug.

---

## Current state of reload-worker.ts

The latest version (polling via `fetch` + `setInterval`) doesn't work because
`fetch` itself never resolves in the worker. The worker logs stop at:
```
[timestamp] koffi loaded ok, handle BigInt=XXXX
```
No "init: seeded lastHtml" ever appears, confirming `fetch` hangs.

---

## Ideas not yet tried

### 1. Use `Bun.Worker` instead of `node:worker_threads`

Previously switched FROM `Bun.Worker` TO `node:worker_threads` because `Bun.Worker`
messages weren't being logged. But the real reason was the main thread is blocked by
`wv.show()`, so `worker.on('message')` never fires. The worker itself might work fine.

**Try**: Use `import { Worker } from 'bun'` (or just `new Worker(url, { type: 'module' })`)
instead of `node:worker_threads`. Test if `fetch`, WebSocket, and `fs.watch` work there.
The tradeoff is that Bun.Worker has a different API - uses `postMessage`/`self.onmessage`
not `parentPort`. Also need to verify koffi works in Bun.Worker.

### 2. SharedArrayBuffer + Atomics (most robust option)

This bypasses the event loop problem entirely for the signaling part:

```typescript
// In cli.ts BEFORE wv.show():
const sharedBuf = new SharedArrayBuffer(4);
const flag = new Int32Array(sharedBuf);

// Vite's file watcher - fires normally because we set this up before wv.show()
// BUT: once wv.show() blocks, chokidar events stop processing too...
// This doesn't solve the root issue.
```

Actually this doesn't help because Vite's watcher also runs in the main thread.

### 3. Run Vite in a separate child process

```typescript
// Instead of createViteServer() in the main thread,
// spawn a separate process: bun run vite --host 127.0.0.1
// The child process has its own event loop (unblocked)
// Child process watches files and can send IPC messages
```

The worker could read a pipe from the child process. But pipe reading is also I/O...

### 4. Run a dedicated watcher child process that writes to a temp file

```typescript
// Main thread: spawn a child process that watches files
// Child process: when file changes, writes a sentinel file (e.g. .reload-trigger)
// Worker: polls for the sentinel file using synchronous fs.existsSync inside setInterval
//         (synchronous fs calls may work even when async I/O is broken)
```

`fs.existsSync` is synchronous (blocking) - it does NOT go through the async I/O queue.
This might actually work! The worker's setInterval fires (confirmed), and inside the
callback, synchronous fs calls should work.

### 5. Use synchronous `execSync` / `spawnSync` inside setInterval

Since `setInterval` fires and synchronous operations work, the worker could call:
```typescript
setInterval(() => {
  // Synchronous file read - bypasses async I/O
  const content = readFileSync(join(rootDir, 'index.html'), 'utf-8');
  if (content !== lastContent) {
    lastContent = content;
    // Now need to get full compiled HTML from Vite...
  }
}, 300);
```

Problem: we still need to GET the compiled HTML from Vite. `fetch` is async.
But `node:child_process.execSync('curl http://127.0.0.1:5173/')` is synchronous!

### 6. Write compiled HTML to disk (Vite build watch mode)

Run Vite in watch mode (`vite build --watch`) instead of dev server mode.
The output goes to `dist/`. The worker can synchronously read `dist/index.html`.
Downside: slower rebuild, no HMR protocol, full reloads only.

### 7. Different threading model - run webview on a worker thread

Instead of the webview on the main thread and reload logic on the worker, flip it:
- Worker thread: creates and owns the WebView (`wv.show()` blocks the worker thread)
- Main thread: free to run Vite, file watchers, and signal the worker via SharedArrayBuffer + Atomics

This would require `webview-nodejs` (koffi) to work in `node:worker_threads`, which it does
(confirmed). The main thread would use `Atomics.notify()` to wake the webview worker which
then calls `webview_set_html`.

### 8. Use `--experimental-worker` Node.js flags or try Node.js directly

Instead of running with `bun`, try running `cli.ts` (compiled) with `node`. Node's
`node:worker_threads` may not have this I/O bug. Could also try `tsx` or `ts-node`.

---

## My best recommendation for next agent

Try **Idea 7** (flip threading model) first - it's the most architecturally clean:

```typescript
// In cli.ts:
const sharedBuf = new SharedArrayBuffer(4);
const flag = new Int32Array(sharedBuf);

// Webview runs on a worker thread (koffi works there)
const webviewWorker = new NodeWorker('./webview-worker.ts', {
  workerData: { title, width, height, debug, sharedBuf, libPath, port }
});

// Main thread: Vite dev server + file watcher, completely unblocked
server.watcher.on('change', () => {
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});

// webview-worker.ts:
// new Webview() + wv.html(initial) + wv.show() [blocks this worker thread]
// Meanwhile: Atomics.waitAsync(flag, 0, 0).then(async () => {
//   Atomics.store(flag, 0, 0);
//   const html = fetchSync... // still need to get HTML
// })
```

Problem: `Atomics.waitAsync` requires async callback, which needs an event loop...
and if the worker thread's event loop is also broken, this won't work.

Actually the real clean solution: use **two** workers - one for the webview (blocked on
`wv.show()`), one for koffi reload calls. The main thread handles Vite + signals via
SharedArrayBuffer. The koffi worker blocks on `Atomics.wait()` (synchronous, no event
loop needed!) then calls `webview_set_html`.

```
Main thread: Vite + chokidar (unblocked event loop)
  → on file change: Atomics.store(flag, 0, 1); Atomics.notify(flag, 0)

Webview worker: new Webview(); wv.show(); [blocked on Win32 message loop]

Koffi worker: 
  while(true) {
    Atomics.wait(flag, 0, 0);  // synchronous block - no event loop needed
    Atomics.store(flag, 0, 0);
    // fetch HTML... still need async fetch here :(
  }
```

We still need the HTML content. Options:
- Write HTML to a shared file, read synchronously in koffi worker
- Pass HTML via SharedArrayBuffer (TextEncoder to bytes)
- Use `execSync('curl ...')` to fetch synchronously

Try **Idea 4 + 5 combined**: sentinel file approach
1. Main thread: Vite watches files, on change writes new HTML to `.instantly-native/reload.html`
2. Koffi worker: `setInterval` polls for existence of that file synchronously,
   reads it synchronously, calls `webview_set_html`, deletes the file

This avoids ALL async I/O in the worker - everything is synchronous or timer-based.
