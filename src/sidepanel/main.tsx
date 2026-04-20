import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createPanelController } from "./controller-stub";
import "../styles/globals.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element missing from src/sidepanel/index.html");
}

// `createPanelController` boots the real runtime: it loads per-profile
// storage and fires the initial `/v1/health` + `/v1/models` fetch. The UI
// mounts only once that kick-off resolves so the first render already has
// a coherent activeProfile/sessions/models snapshot.
void (async () => {
  const controller = await createPanelController();
  createRoot(container).render(
    <React.StrictMode>
      <App controller={controller} />
    </React.StrictMode>,
  );
})();
