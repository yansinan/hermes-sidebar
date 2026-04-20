/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import type { Plugin } from "vite";
import manifest from "./manifest.config";

function writeManifestPlugin(): Plugin {
  return {
    name: "hermes-sidebar:write-manifest",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir ?? "dist";
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        resolve(outDir, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
        "utf8",
      );
    },
  };
}

// Vite emits multi-page HTML entries at their path relative to the project
// root, so `src/sidepanel/index.html` lands at `dist/src/sidepanel/index.html`.
// The MV3 manifest expects `sidepanel.html` at the extension root, so we
// move the emitted file into place after the bundle is written.
function flattenSidepanelHtmlPlugin(): Plugin {
  return {
    name: "hermes-sidebar:flatten-sidepanel-html",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir ?? "dist";
      const from = resolve(outDir, "src/sidepanel/index.html");
      const to = resolve(outDir, "sidepanel.html");
      renameSync(from, to);
      rmSync(resolve(outDir, "src"), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), flattenSidepanelHtmlPlugin(), writeManifestPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "src/sidepanel/index.html"),
        background: resolve(__dirname, "src/background/service-worker.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    css: false,
  },
});
