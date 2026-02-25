// node:worker_threads worker - runs on a real OS thread in the same process,
// so native addons (koffi) work and the address space is shared with the main thread.
//
// Bun's node:worker_threads has a bug where I/O callbacks (fs.watch, WebSocket, etc.)
// don't fire - only timers work. So we poll Vite's HTTP endpoint to detect changes.

import { workerData, parentPort } from 'node:worker_threads';
import { appendFileSync } from 'node:fs';
import koffi from 'koffi';

export type WorkerData = {
  handleAddr: string;
  port:       number;
  libPath:    string;
  rootDir:    string;
};

const { handleAddr, port, libPath } = workerData as WorkerData;

const LOG = 'c:\\dev\\me\\window-this\\worker.log';
const log = (msg: string) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG, line); } catch { /* ignore */ }
};

log(`started - port=${port} handle=${handleAddr}`);
parentPort?.postMessage({ type: 'started' });

let webview_set_html: (...args: unknown[]) => void;
let handle: bigint;

try {
  const lib = koffi.load(libPath);
  webview_set_html = lib.func('webview_set_html', 'void', ['void *', 'const char *']);
  handle = BigInt(handleAddr);
  log(`koffi loaded ok, handle BigInt=${handle}`);
} catch (err) {
  log(`koffi load FAILED: ${err}`);
  process.exit(1);
}

let lastHtml = '';
let reloading = false;

async function pollAndReload() {
  if (reloading) return;
  reloading = true;
  try {
    const res  = await fetch(`http://127.0.0.1:${port}/`);
    const raw  = await res.text();

    if (raw === lastHtml) {
      reloading = false;
      return;
    }

    lastHtml = raw;
    const html = raw.replace('<head>', `<head>\n  <base href="http://127.0.0.1:${port}/">`);
    log(`change detected - calling webview_set_html (length=${html.length})`);
    webview_set_html(handle, html);
    log('webview_set_html returned OK');
    parentPort?.postMessage({ type: 'reloaded' });
  } catch (err) {
    log(`poll error: ${err}`);
  } finally {
    reloading = false;
  }
}

// Seed lastHtml with the current content so we don't fire on startup
async function init() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    lastHtml  = await res.text();
    log(`init: seeded lastHtml (length=${lastHtml.length})`);
    parentPort?.postMessage({ type: 'connected' });
  } catch (err) {
    log(`init fetch failed: ${err} - will retry via poll`);
  }

  // Poll every 300ms - fast enough to feel instant, light enough to not stress CPU
  setInterval(pollAndReload, 300);
}

init();
