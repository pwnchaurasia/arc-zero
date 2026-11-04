import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { loadEngine } from "./engine/wasm";
import "./index.css";
import { SessionProvider } from "./state/session";
import { startUpdates } from "./state/updates";

// Start fetching the WASM engine immediately; screens await the same promise.
void loadEngine();
startUpdates();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
