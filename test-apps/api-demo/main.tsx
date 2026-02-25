import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";
import { nw, type WindowApi } from "windowd";

const projectDirFromQuery = new URLSearchParams(window.location.search).get("windowThisProjectDir");
const FILE_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect x='3' y='2' width='10' height='12' fill='%23dfe6ff' stroke='%23707aa0'/%3E%3C/svg%3E";
const FOLDER_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Cpath d='M2 5h5l1 1h6v7H2z' fill='%23f3d37a' stroke='%239b7f36'/%3E%3C/svg%3E";

function App() {
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
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
    if (!nw?.Window?.get) return null;
    try {
      return nw.Window.get();
    } catch {
      return null;
    }
  }, []);

  const nwVersion = useMemo(() => process?.versions?.nw ?? "unavailable", []);

  const btn: React.CSSProperties = {
    padding: "0.42rem 0.75rem",
    borderRadius: 8,
    border: "1px solid #3e4b76",
    background: "#2b3354",
    color: "#fff",
    cursor: "pointer",
  };

  return (
    <main style={{ fontFamily: "system-ui,sans-serif", background: "#090b16", color: "#e2e8f0", height: "100vh", padding: 24, boxSizing: "border-box" }}>
      <section style={{ width: "min(900px,100%)", margin: "0 auto", background: "#12162b", border: "1px solid #2a3152", borderRadius: 14, padding: 24, display: "grid", gap: 12 }}>
        <h1 style={{ margin: 0, color: "#a78bfa" }}>api-demo</h1>
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
        <div style={{ border: "1px solid #2a3152", borderRadius: 10, padding: 12, maxHeight: 280, overflow: "auto" }}>
          {entries.map((entry) => (
            <div key={entry.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
              <img src={entry.kind === "dir" ? FOLDER_ICON : FILE_ICON} width={16} height={16} alt="" />
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
