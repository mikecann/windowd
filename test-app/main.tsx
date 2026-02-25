import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";
import fileIcon from "./assets/icons/page_white.png";

const projectDirFromQuery = new URLSearchParams(window.location.search).get(
  "windowThisProjectDir",
);

function App() {
  const [count, setCount] = useState(0);
  const cwd = useMemo(() => {
    if (projectDirFromQuery) return projectDirFromQuery;
    if (typeof process !== "undefined" && typeof process.cwd === "function") {
      return process.cwd();
    }
    return "unavailable";
  }, []);

  const entries = useMemo(() => {
    if (cwd === "unavailable") return [];

    return fs
      .readdirSync(cwd)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const fullPath = path.join(cwd, name);
        try {
          return {
            name,
            kind: fs.statSync(fullPath).isDirectory() ? "dir" : "file",
          };
        } catch {
          return { name, kind: "unknown" as const };
        }
      });
  }, [cwd]);

  const runtimeFileIconPath = useMemo(() => {
    if (cwd === "unavailable") return null;
    return path.join(cwd, "assets", "icons", "page_white.png");
  }, [cwd]);

  const runtimeFileIcon = useMemo(() => {
    if (!runtimeFileIconPath) return null;
    try {
      const pngBytes = fs.readFileSync(runtimeFileIconPath);
      return `data:image/png;base64,${pngBytes.toString("base64")}`;
    } catch {
      return null;
    }
  }, [runtimeFileIconPath]);

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

  const primaryButton: React.CSSProperties = {
    marginLeft: 8,
    padding: "0.42rem 0.8rem",
    borderRadius: 8,
    border: "1px solid #5a45c9",
    background: "#7c3aed",
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
  };

  const secondaryButton: React.CSSProperties = {
    ...primaryButton,
    border: "1px solid #3e4b76",
    background: "#2b3354",
  };

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        background: "#090b16",
        color: "#e2e8f0",
        height: "100vh",
        boxSizing: "border-box",
        padding: "24px",
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
      }}
    >
      <section
        style={{
          width: "min(900px, 100%)",
          maxHeight: "100%",
          padding: "28px",
          background: "#12162b",
          border: "1px solid #2a3152",
          borderRadius: 14,
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <h1 style={{ color: "#a78bfa", margin: 0, fontSize: "2rem" }}>
          window-this + React + Node
        </h1>
        <p style={{ color: "#9aa7c2", margin: 0, fontSize: "0.96rem" }}>
          This demo shows both compile-time PNG import and runtime disk loading.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              border: "1px solid #2a3152",
              borderRadius: 8,
              padding: "0.5rem 0.6rem",
              background: "#0d1224",
            }}
          >
            <img src={runtimeFolderIcon ?? fileIcon} width={16} height={16} alt="folder icon" />
            <span style={{ color: "#c8d3f6", fontSize: "0.86rem" }}>
              <code>fs.readFileSync(.../folder.png)</code>
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              border: "1px solid #2a3152",
              borderRadius: 8,
              padding: "0.5rem 0.6rem",
              background: "#0d1224",
            }}
          >
            <img
              src={runtimeFileIcon ?? fileIcon}
              width={16}
              height={16}
              alt="runtime loaded icon"
            />
            <span style={{ color: "#c8d3f6", fontSize: "0.86rem" }}>
              <code>fs.readFileSync(.../page_white.png)</code>
            </span>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: "0.8rem", color: "#8f99b8" }}>
          Runtime icon paths:{" "}
          <code>{runtimeFolderIconPath ?? "unavailable"}</code>{" "}
          and{" "}
          <code>{runtimeFileIconPath ?? "unavailable"}</code>
        </p>

        <div style={{ display: "grid", gap: 6 }}>
          <strong style={{ fontSize: "0.92rem", letterSpacing: "0.01em" }}>Current directory</strong>
          <code
            style={{
              wordBreak: "break-all",
              color: "#d3dbf2",
              background: "#0d1224",
              border: "1px solid #2a3152",
              borderRadius: 8,
              padding: "0.45rem 0.6rem",
              fontSize: "0.86rem",
            }}
          >
            {cwd}
          </code>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: "0.92rem", letterSpacing: "0.01em" }}>Counter</strong>
          <span
            style={{
              minWidth: 28,
              textAlign: "center",
              fontWeight: 700,
              background: "#0d1224",
              border: "1px solid #2a3152",
              borderRadius: 6,
              padding: "0.2rem 0.45rem",
            }}
          >
            {count}
          </span>
          <button onClick={() => setCount((v) => v + 1)} style={primaryButton}>
            +1
          </button>
          <button onClick={() => setCount(0)} style={secondaryButton}>
            reset
          </button>
        </div>

        <h2 style={{ fontSize: "1.05rem", margin: 0 }}>
          Files in current directory ({entries.length})
        </h2>
        <div
          style={{
            minHeight: 0,
            overflow: "auto",
            border: "1px solid #2a3152",
            borderRadius: 10,
            background: "#0d1224",
            padding: "12px 14px",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "88px 1fr",
              gap: 8,
              padding: "0 0.4rem 0.35rem",
              marginBottom: "0.35rem",
              borderBottom: "1px solid #222a47",
              fontSize: "0.76rem",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "#8f99b8",
            }}
          >
            <span>Type</span>
            <span>Name</span>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {entries.map((entry, idx) => (
              <li
                key={entry.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "88px 1fr",
                  gap: 8,
                  padding: "0.35rem 0.4rem",
                  color: "#dce3f8",
                  borderRadius: 6,
                  background: idx % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent",
                  fontSize: "0.95rem",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <img
                    src={entry.kind === "dir" ? (runtimeFolderIcon ?? fileIcon) : fileIcon}
                    width={16}
                    height={16}
                    alt=""
                    aria-hidden="true"
                  />
                  <code
                    style={{
                      color:
                        entry.kind === "dir" ? "#8ab4ff" : entry.kind === "file" ? "#aab3cf" : "#f6c177",
                      fontWeight: 700,
                    }}
                  >
                    {entry.kind === "dir" ? "DIR" : entry.kind === "file" ? "FILE" : "OTHER"}
                  </code>
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.name}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(<App />);
