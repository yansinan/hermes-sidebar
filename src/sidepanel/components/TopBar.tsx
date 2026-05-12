import type { AppController, AppState } from "../../shared/app-state";
import { BUILD_INFO } from "../../shared/build-info";
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

  // Debug logging
  if (typeof window !== "undefined") {
    (window as any).__DEBUG_MODELS = {
      models: models.map(m => m.id),
      defaultModelId: settings.defaultModelId,
      activeSessionId: state.activeSessionId,
      activeSessionModelId: activeSession?.modelId,
      selectedModel,
    };
  }

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

      <span
        className="top-bar__build"
        title={`Built at ${BUILD_INFO.builtAt}`}
        aria-label={`Loaded build ${BUILD_INFO.label}`}
      >
        {new Date(BUILD_INFO.builtAt).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
      </span>

      <label className="model-dropdown" aria-label="Model">
        <span className="visually-hidden">Model</span>
        <select
          value={selectedModel || ""}
          onChange={(e) => {
            const value = e.currentTarget.value;
            console.log("[TopBar] Model selection changed:", value);
            if (value) {
              controller.selectModel(value);
            }
          }}
          disabled={models.length === 0}
          aria-label="Model selection"
          style={{ cursor: models.length === 0 ? "not-allowed" : "pointer" }}
          title={`Current: ${selectedModel || "None"}, Available: ${models.length}`}
        >
          {models.length === 0 ? (
            <option value="">
              {connectionStatus.kind === "healthy" 
                ? "No models available" 
                : "Loading models..."}
            </option>
          ) : (
            <>
              <option value="" disabled hidden>
                Select a model ({models.length} available)
              </option>
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
