import type { AppController, AppState } from "../../shared/app-state";
import { StatusDot } from "./StatusDot";

interface Props {
  state: AppState;
  controller: AppController;
  onOpenSessions: () => void;
  onOpenSettings: () => void;
}

export function TopBar({
  state,
  controller,
  onOpenSessions,
  onOpenSettings,
}: Props) {
  const {
    activeProfile,
    connectionStatus,
    models,
    settings,
    sessions,
    sessionPhases,
  } = state;

  const activeSession = state.activeSessionId
    ? sessions.find((s) => s.id === state.activeSessionId) ?? null
    : null;
  const selectedModel =
    activeSession?.modelId || settings.defaultModelId || "";

  const anyStreaming = Object.values(sessionPhases).some(
    (p) => p === "streaming",
  );
  const sessionCount = sessions.length;

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
        aria-label={`Connection: ${activeProfile.hostShort}. Open settings.`}
        onClick={onOpenSettings}
      >
        <span className="profile-label__host">{activeProfile.hostShort}</span>
      </button>

      <label className="model-dropdown" aria-label="Model">
        <span className="visually-hidden">Model</span>
        <select
          value={selectedModel}
          onChange={(e) => controller.selectModel(e.currentTarget.value)}
          disabled={models.length === 0}
          aria-label="Model selection"
        >
          {models.length === 0 ? (
            <option value="">No models available</option>
          ) : (
            <>
              {selectedModel &&
                !models.some((m) => m.id === selectedModel) && (
                  <option value={selectedModel} disabled>
                    {selectedModel} (unavailable)
                  </option>
                )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName ?? m.id}
                </option>
              ))}
            </>
          )}
        </select>
      </label>

      <button
        type="button"
        className="icon-button icon-button--sessions"
        onClick={onOpenSessions}
        aria-label={`Sessions (${sessionCount})`}
        title="Sessions"
      >
        <span aria-hidden>☰</span>
        {sessionCount > 0 && (
          <span className="icon-button__badge" aria-hidden>
            {sessionCount}
          </span>
        )}
        {anyStreaming && (
          <span
            className="icon-button__streaming-dot"
            aria-label="A session is streaming"
          />
        )}
      </button>

      <button
        type="button"
        className="icon-button"
        onClick={onOpenSettings}
        aria-label="Settings"
        title="Settings"
      >
        <span aria-hidden>⚙</span>
      </button>
    </header>
  );
}
