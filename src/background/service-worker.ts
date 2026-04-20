/// <reference types="chrome" />

// MV3 service worker for hermes-sidebar.
//
// v1 scope (see docs/architecture.md §3.11 and §2):
//   - Wire the toolbar action to open the side panel on click.
//   - Stay out of the chat data path. This worker does not call the Hermes API,
//     does not hold conversation state, and does not buffer streams.
//
// Anything beyond that belongs in the side panel page.

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => {
      console.error("[hermes-sidebar] setPanelBehavior failed", err);
    });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => {
      console.error("[hermes-sidebar] setPanelBehavior failed", err);
    });
});

export {};
