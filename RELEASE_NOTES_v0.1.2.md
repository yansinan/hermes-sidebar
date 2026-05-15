# Release v0.1.2-20260515

## 🎉 Highlights

This release **fixes Markdown rendering hangs** that occurred when processing pages with ultra-long tracking image URLs (e.g., `bat.bing.com/action/...`). The extension now uses a battle-tested Markdown rendering library for better stability and performance.

## 🔧 Changes

### Features
- ✨ **New markdown rendering pipeline**: Migrated from custom regex parser to [react-markdown](https://github.com/remarkjs/react-markdown) 9.0.3 with [remark-gfm](https://github.com/remarkjs/remark-gfm) plugin
  - Supports CommonMark + GitHub Flavored Markdown (tables, strikethrough, etc.)
  - Robust handling of edge cases and malformed HTML
  - Battle-tested library used in production by thousands of projects

### Performance Improvements
- 🚀 **Fixed markdown preview hangs**: Eliminated exponential regex backtracking on concatenated long URLs
- 📦 **New markdown bundle**: Implemented IIFE-based bundle pattern (`markdown.bundle.js`) for better code-splitting and lazy loading
- 🔒 **Fallback rendering**: Added lightweight fallback parser in case bundle fails to load

### Code Quality
- 🧹 Cleaned up TypeScript TS6133 unused variable/parameter errors
- 🏗️ Standardized bundle architecture: readability.bundle.js → turndown.bundle.js → markdown.bundle.js

### Build System
- Added `build:markdown` npm script using esbuild
- Updated main `build` script to include markdown bundle generation in pipeline
- All bundles now minified and optimized for Chrome content scripts

## 📋 Technical Details

### Problem Solved
When a page contained ultra-long tracking image URLs (1000+ characters), the custom inline regex parser in `Markdown.tsx` would attempt catastrophic backtracking, causing the preview to hang indefinitely. Plain text rendering worked fine, confirming the regex parser was the bottleneck.

### Solution
1. Replaced fragile custom parser with `react-markdown` (npm package)
2. Created `scripts/markdown-bundle.entry.mjs` to bundle react-markdown and remark-gfm into a standalone IIFE
3. Injected bundle via script tag in `src/sidepanel/index.html`
4. Component now consumes `globalThis.__hermesMarkdown.ReactMarkdown` at runtime
5. Added lightweight fallback parser for robustness

### Bundle Sizes
- `readability.bundle.js`: 34.0 KB (minified)
- `turndown.bundle.js`: 12.5 KB (minified)
- `markdown.bundle.js`: 159.9 KB (minified) — includes react 18.3.1 + react-dom + react-markdown + remark-gfm

### Testing
- ✅ All existing tests pass (including `markdown.test.tsx` 2/2)
- ✅ No TypeScript errors or warnings
- ✅ Tested with ultra-long URL edge cases
- ✅ Verified fallback behavior when bundle unavailable

## 📦 Package Contents

- `dist/` — Production build artifacts (ready to load into Chrome)
  - `background.js` — Service worker
  - `manifest.json` — Extension manifest
  - `sidepanel.html` — Sidebar UI
  - `*.bundle.js` — Injected scripts (readability, turndown, markdown)
  - `assets/` — Compiled React components

## 🚀 Installation & Testing

1. **In Chrome/Edge**: 
   - Open `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked" and select the `dist/` folder

2. **Test markdown rendering**:
   - Visit a page with complex formatting (tables, code blocks, lists)
   - Open Hermes Sidebar (press sidebar button)
   - Click "Summary" to render markdown preview
   - Performance should be smooth even on pages with tracking images

## 🔗 Related Commits

- `7f2702c` feat: Add react-markdown bundle for stable markdown rendering
- `98baf01` feat: auto markdown preview with token-based insertion

## ⚙️ Dependencies Added

- `react-markdown@^9.0.3` — Markdown to React component renderer
- `remark-gfm@^4.0.1` — GitHub Flavored Markdown support for remark

---

**Tag**: `v0.1.2-20260515`  
**Release Date**: May 15, 2026  
**Repository**: [yansinan/hermes-sidebar](https://github.com/yansinan/hermes-sidebar)
