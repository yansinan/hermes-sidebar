import type { AppController, AppState } from "../../shared/app-state";
import { StatusDot } from "./StatusDot";

interface Props {
  state: AppState;
  controller: AppController;
}

export function TopBar({ state, controller }: Props) {
  const { activeProfile, connectionStatus, models, settings } = state;
  const selectedModel = settings.defaultModelId;

  return (
    <header className="top-bar" role="banner">
      <StatusDot
        status={connectionStatus}
        hostShort={activeProfile.hostShort}
        onRecheck={() => void controller.recheckHealth()}
      />

      <button
        type="button"
        className="profile-label"
        title={`Showing conversations for ${activeProfile.hostShort}`}
        aria-label={`Connection profile ${activeProfile.hostShort}. Open settings.`}
      >
        <span className="profile-label__host">{activeProfile.hostShort}</span>
      </button>

      <label className="model-dropdown" aria-label="Model">
        <span className="visually-hidden">Model</span>
        <select
          value={selectedModel}
          onChange={(e) => controller.selectModel(e.currentTarget.value)}
          disabled={models.length === 0}
        >
          {models.length === 0 ? (
            <option value="">No models available</option>
          ) : (
            models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName ?? m.id}
              </option>
            ))
          )}
        </select>
      </label>

      <button type="button" className="icon-button" aria-label="Sessions">
        <span aria-hidden>≡</span>
      </button>

      <button type="button" className="icon-button" aria-label="Settings">
        <span aria-hidden>⚙</span>
      </button>
    </header>
  );
}
