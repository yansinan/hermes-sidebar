import type { AppController } from "../shared/app-state";
import { TopBar } from "./components/TopBar";
import { ConversationArea } from "./components/ConversationArea";
import { Composer } from "./components/Composer";
import { useAppState } from "./useAppState";

interface Props {
  controller: AppController;
}

export function App({ controller }: Props) {
  const state = useAppState(controller);

  return (
    <div className="app-shell">
      <TopBar state={state} controller={controller} />
      <ConversationArea state={state} />
      <Composer state={state} controller={controller} />
    </div>
  );
}
