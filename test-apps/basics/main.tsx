import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";
import { nw, type WindowApi } from "windowd";
import fileIcon from "./assets/icons/page_white.png";

const projectDirFromQuery = new URLSearchParams(window.location.search).get("windowThisProjectDir");

interface ChildWindowApi extends WindowApi {
  close(force?: boolean): void;
  on(event: "closed", callback: () => void): void;
  window?: Window;
}

interface NwWithOpenApi {
  Window: {
    get(): WindowApi;
    open(
      url: string,
      options: Record<string, unknown>,
      callback: (win: ChildWindowApi) => void,
    ): void;
  };
}

function App() {
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const [hasChild, setHasChild] = useState(false);
  const childWindowRef = useRef<ChildWindowApi | null>(null);
  const nwWithOpen = nw as unknown as NwWithOpenApi;
  const cwd = useMemo(
    () => projectDirFromQuery ?? (typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : "unavailable"),
    [],
  );

  const entries = useMemo(() => {
    if (cwd === "unavailable") return [];
    return fs
      .readdirSync(cwd)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        try {
          const kind = fs.statSync(path.join(cwd, name)).isDirectory() ? "dir" : "file";
          return { name, kind };
        } catch {
          return { name, kind: "unknown" as const };
        }
      });
  }, [cwd]);

  const nwWindow = useMemo<WindowApi | null>(() => {
    if (!nwWithOpen?.Window?.get) return null;
    try {
      return nwWithOpen.Window.get();
    } catch {
      return null;
    }
  }, [nwWithOpen]);

  const nwVersion = useMemo(() => process?.versions?.nw ?? "unavailable", []);
  const runtimeFolderIconPath = useMemo(() => {
    if (cwd === "unavailable") return null;
    return path.join(cwd, "assets", "icons", "folder.png");
  }, [cwd]);
  const runtimeFolderIcon = useMemo(() => {
    if (!runtimeFolderIconPath) return null;
    try {
      const pngBytes = fs.readFileSync(runtimeFolderIconPath);
      return `data:image/png;base64,${pngBytes.toString("base64")}`;
    } catch {
      return null;
    }
  }, [runtimeFolderIconPath]);

  const btn: React.CSSProperties = {
    padding: "0.42rem 0.75rem",
    borderRadius: 8,
    border: "1px solid #3e4b76",
    background: "#2b3354",
    color: "#fff",
    cursor: "pointer",
  };

  const openChildWindow = () => {
    if (childWindowRef.current) return;
    try {
      nwWithOpen.Window.open(
        "about:blank",
        {
          frame: false,
          width: 520,
          height: 340,
          focus: true,
          title: "windowd child",
        },
        (child) => {
          childWindowRef.current = child;
          setHasChild(true);

          child.on("closed", () => {
            childWindowRef.current = null;
            setHasChild(false);
          });

          if (child.window?.document) {
            child.window.document.title = "windowd child";
            child.window.document.body.innerHTML = `
              <main style="font-family:system-ui,sans-serif;background:#111827;color:#e5e7eb;height:100vh;margin:0;display:grid;place-items:center;">
                <section style="border:1px solid #374151;border-radius:12px;padding:20px;background:#1f2937;">
                  <h2 style="margin:0 0 10px;">Frameless child window</h2>
                  <p style="margin:0;">Opened via <code>nw.Window.open(...)</code>.</p>
                </section>
              </main>
            `;
          }
        },
      );
    } catch (error) {
      console.error("Failed to open child window", error);
      setHasChild(false);
    }
  };

  const closeChildWindow = () => {
    const child = childWindowRef.current;
    if (!child) return;
    try {
      child.close(true);
    } catch (error) {
      console.error("Failed to close child window", error);
    } finally {
      childWindowRef.current = null;
      setHasChild(false);
    }
  };

  useEffect(() => {
    return () => {
      const child = childWindowRef.current;
      if (!child) return;
      try {
        child.close(true);
      } catch {
        // ignore cleanup errors
      }
      childWindowRef.current = null;
    };
  }, []);

  return (
    <main style={{ fontFamily: "system-ui,sans-serif", background: "#090b16", color: "#e2e8f0", height: "100vh", padding: 24, boxSizing: "border-box" }}>
      <section style={{ width: "min(900px,100%)", margin: "0 auto", background: "#12162b", border: "1px solid #2a3152", borderRadius: 14, padding: 24, display: "grid", gap: 12 }}>
        <h1 style={{ margin: 0, color: "#a78bfa" }}>basics</h1>
        <p style={{ margin: 0, color: "#9aa7c2" }}>
          Typed runtime wrapper import: <code>import &#123; nw &#125; from "windowd"</code>
        </p>
        <p style={{ margin: 0, color: "#9aa7c2" }}>
          NW available: <strong>{nwWindow ? "yes" : "no"}</strong>, version: <code>{nwVersion}</code>
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button style={btn} onClick={() => nwWindow?.minimize()}>minimize</button>
          <button style={btn} onClick={() => nwWindow?.maximize()}>maximize</button>
          <button style={btn} onClick={() => nwWindow?.restore()}>restore</button>
          <button style={btn} onClick={() => nwWindow?.showDevTools()}>devtools</button>
          <button style={btn} onClick={hasChild ? closeChildWindow : openChildWindow}>
            {hasChild ? "close child" : "open child"}
          </button>
          <button
            style={btn}
            onClick={() => {
              const next = !isAlwaysOnTop;
              nwWindow?.setAlwaysOnTop(next);
              setIsAlwaysOnTop(next);
            }}
          >
            always on top: {isAlwaysOnTop ? "on" : "off"}
          </button>
        </div>
        <p style={{ margin: 0 }}>
          <strong>CWD:</strong> <code>{cwd}</code>
        </p>
        <p style={{ margin: 0, color: "#9aa7c2" }}>
          Asset demo, file icon is imported, folder icon is loaded at runtime with <code>fs.readFileSync</code>.
        </p>
        <div style={{ border: "1px solid #2a3152", borderRadius: 10, padding: 12, maxHeight: 280, overflow: "auto" }}>
          {entries.map((entry) => (
            <div key={entry.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
              <img src={entry.kind === "dir" ? (runtimeFolderIcon ?? fileIcon) : fileIcon} width={16} height={16} alt="" />
              <code>[{entry.kind}]</code>
              <span>{entry.name}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<App />);
