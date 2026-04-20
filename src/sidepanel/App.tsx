import { useState } from "react";
import type { AppController } from "../shared/app-state";
import { TopBar } from "./components/TopBar";
import { ConversationArea } from "./components/ConversationArea";
import { Composer } from "./components/Composer";
import { SessionDrawer } from "./components/SessionDrawer";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { useAppState } from "./useAppState";

interface Props {
  controller: AppController;
}

type OpenOverlay = "none" | "sessions" | "settings";

export function App({ controller }: Props) {
  const state = useAppState(controller);
  const [overlay, setOverlay] = useState<OpenOverlay>("none");

  const openSessions = () => setOverlay("sessions");
  const openSettings = () => setOverlay("settings");
  const closeOverlay = () => setOverlay("none");

  return (
    <div className="app-shell">
      <TopBar
        state={state}
        controller={controller}
        onOpenSessions={openSessions}
        onOpenSettings={openSettings}
      />
      <ConversationArea
        state={state}
        controller={controller}
        onOpenSettings={openSettings}
      />
      <Composer state={state} controller={controller} />

      {overlay === "sessions" && (
        <SessionDrawer
          state={state}
          controller={controller}
          onClose={closeOverlay}
        />
      )}
      {overlay === "settings" && (
        <SettingsDrawer
          state={state}
          controller={controller}
          onClose={closeOverlay}
        />
      )}
    </div>
  );
}
