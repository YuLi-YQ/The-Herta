import "./site.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Site } from "./Site.js";

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("#root element not found in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <Site />
  </StrictMode>,
);
