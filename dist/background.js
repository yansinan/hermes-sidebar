chrome.runtime.onInstalled.addListener(()=>{chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:!0}).catch(e=>{console.error("[hermes-sidebar] setPanelBehavior failed",e)})});chrome.runtime.onStartup.addListener(()=>{chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:!0}).catch(e=>{console.error("[hermes-sidebar] setPanelBehavior failed",e)})});
//# sourceMappingURL=background.js.map
