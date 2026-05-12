import type { ManifestV3 } from "./src/shared/manifest-types";
import pkg from "./package.json" with { type: "json" };

export const manifest: ManifestV3 = {
  manifest_version: 3,
  name: "hermes-sidebar",
  version: pkg.version,
  description: pkg.description,
  // Phase 1A/1B quick actions need an explicit active-tab/script path to read
  // the current page context. Keep the permissions narrow and user-triggered.
  permissions: ["sidePanel", "storage", "tabs", "activeTab", "scripting", "contextMenus"],
  host_permissions: ["http://127.0.0.1:8642/*"],
  optional_host_permissions: ["http://*/*", "https://*/*"],
  side_panel: {
    default_path: "sidepanel.html",
  },
  action: {
    default_title: "hermes-sidebar",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
  },
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  background: {
    service_worker: "background.js",
    type: "module",
  },
  minimum_chrome_version: "114",
};

export default manifest;
