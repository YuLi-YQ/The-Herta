import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

/** The app itself, loaded by `main.tsx` once the opening's glyph sheet has
 *  started drawing (M-opening-4). */
const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("#root element not found in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
