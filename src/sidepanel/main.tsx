import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createStubController } from "./controller-stub";
import "../styles/globals.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element missing from src/sidepanel/index.html");
}

const controller = createStubController();
createRoot(container).render(
  <React.StrictMode>
    <App controller={controller} />
  </React.StrictMode>,
);
