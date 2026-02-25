import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  const nwState = (() => {
    try {
      const w = nw?.Window?.get?.();
      if (!w) return "unavailable";
      return "available";
    } catch {
      return "unavailable";
    }
  })();

  return (
    <main
      style={{
        fontFamily: "system-ui,sans-serif",
        background: "#0b1020",
        color: "#e7ecff",
        height: "100vh",
        display: "grid",
        placeItems: "center",
      }}
    >
      <section
        style={{
          border: "1px solid #2a3152",
          borderRadius: 12,
          background: "#12162b",
          padding: 24,
          width: "min(700px,90vw)",
        }}
      >
        <h1 style={{ margin: 0, color: "#a78bfa" }}>config-demo</h1>
        <p>
          This app is meant to be driven by <code>windowd-config.ts</code>.
        </p>
        <p>
          Current NW window API status: <strong>{nwState}</strong>
        </p>
        <p>
          Try editing <code>windowd-config.ts</code> and restarting the app.
        </p>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<App />);
