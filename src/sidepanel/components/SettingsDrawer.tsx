import { useState } from "react";
import type { AppController, AppState } from "../../shared/app-state";
import type { EnterBehavior, Settings } from "../../shared/settings";
import { Overlay } from "./Overlay";

interface Props {
  state: AppState;
  controller: AppController;
  onClose: () => void;
}

type TestResult =
  | { kind: "idle" }
  | { kind: "ok"; modelCount: number }
  | { kind: "fail"; reason: string };

export function SettingsDrawer({ state, controller, onClose }: Props) {
  const { settings, activeProfile } = state;

  const [apiBaseUrl, setApiBaseUrl] = useState(settings.apiBaseUrl);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [enterBehavior, setEnterBehavior] = useState<EnterBehavior>(
    settings.enterBehavior,
  );
  const [streamingEnabled, setStreamingEnabled] = useState(
    settings.streamingEnabled,
  );
  const [reuseServerSession, setReuseServerSession] = useState(
    settings.reuseServerSession,
  );
  const [sendIdempotencyKey, setSendIdempotencyKey] = useState(
    settings.sendIdempotencyKey,
  );
  const [testResult, setTestResult] = useState<TestResult>({ kind: "idle" });
  const [urlError, setUrlError] = useState<string | null>(null);

  const validateUrl = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) return "API base URL is required.";
    if (!/^https?:\/\//i.test(trimmed)) {
      return "Must start with http:// or https://.";
    }
    try {
      new URL(trimmed);
      return null;
    } catch {
      return "Not a valid URL.";
    }
  };

  const onSave = async () => {
    const err = validateUrl(apiBaseUrl);
    if (err) {
      setUrlError(err);
      return;
    }
    setUrlError(null);
    const patch: Partial<Settings> = {
      apiBaseUrl: apiBaseUrl.trim(),
      apiKey,
      enterBehavior,
      streamingEnabled,
      reuseServerSession,
      sendIdempotencyKey,
    };
    await controller.saveSettings(patch);
    onClose();
  };

  const onTestConnection = async () => {
    const err = validateUrl(apiBaseUrl);
    if (err) {
      setTestResult({ kind: "fail", reason: err });
      return;
    }
    setTestResult({ kind: "idle" });
    await controller.saveSettings({ apiBaseUrl: apiBaseUrl.trim() });
    await controller.recheckHealth();
    const s = controller.getState();
    if (s.connectionStatus.kind === "healthy") {
      setTestResult({ kind: "ok", modelCount: s.models.length });
    } else if (s.connectionStatus.kind === "failed") {
      setTestResult({
        kind: "fail",
        reason: s.connectionStatus.message ?? s.connectionStatus.reason,
      });
    } else {
      setTestResult({ kind: "ok", modelCount: s.models.length });
    }
  };

  return (
    <Overlay title="Settings" onClose={onClose} panelClassName="overlay__panel--drawer">
      <div className="settings">
        <section className="settings__section" aria-labelledby="s-connection">
          <h3 id="s-connection" className="settings__heading">
            Connection
          </h3>
          <label className="field">
            <span className="field__label">API base URL</span>
            <input
              className="field__input"
              type="text"
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.currentTarget.value)}
              placeholder="http://127.0.0.1:8642"
              aria-invalid={urlError ? true : undefined}
              aria-describedby="url-help url-err"
            />
            <span id="url-help" className="field__hint">
              Local example: http://127.0.0.1:8642 · Remote example:
              https://hermes.example.com
            </span>
            {urlError && (
              <span id="url-err" className="field__error" role="alert">
                {urlError}
              </span>
            )}
          </label>

          <label className="field">
            <span className="field__label">API key (optional)</span>
            <div className="field__row">
              <input
                className="field__input"
                type={keyRevealed ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.currentTarget.value)}
                placeholder="Bearer token"
                aria-label="API key"
              />
              <button
                type="button"
                className="field__reveal"
                onClick={() => setKeyRevealed((v) => !v)}
                aria-label={keyRevealed ? "Hide API key" : "Show API key"}
              >
                {keyRevealed ? "Hide" : "Show"}
              </button>
            </div>
            <span className="field__hint">
              Sent as Authorization: Bearer &lt;API_SERVER_KEY&gt; · Stored
              locally in your browser
            </span>
          </label>

          <div className="settings__row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void onTestConnection()}
            >
              Test connection
            </button>
            {testResult.kind === "ok" && (
              <span className="settings__test-ok" role="status">
                Connected. {testResult.modelCount} models available.
              </span>
            )}
            {testResult.kind === "fail" && (
              <span className="settings__test-fail" role="alert">
                Could not reach {activeProfile.hostShort}: {testResult.reason}
              </span>
            )}
          </div>
        </section>

        <section className="settings__section" aria-labelledby="s-conv">
          <h3 id="s-conv" className="settings__heading">
            Conversation
          </h3>
          <label className="field">
            <span className="field__label">Enter key behavior</span>
            <select
              className="field__input"
              value={enterBehavior}
              onChange={(e) =>
                setEnterBehavior(e.currentTarget.value as EnterBehavior)
              }
            >
              <option value="send">
                Enter sends · Shift+Enter newline
              </option>
              <option value="newline">
                Enter newline · Shift+Enter sends
              </option>
            </select>
          </label>

          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={streamingEnabled}
              onChange={(e) => setStreamingEnabled(e.currentTarget.checked)}
            />
            <span>Stream responses as they arrive</span>
          </label>
        </section>

        <section className="settings__section" aria-labelledby="s-adv">
          <h3 id="s-adv" className="settings__heading">
            Advanced
          </h3>
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={sendIdempotencyKey}
              onChange={(e) => setSendIdempotencyKey(e.currentTarget.checked)}
            />
            <span>Attach Idempotency-Key automatically</span>
          </label>
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={reuseServerSession}
              onChange={(e) => setReuseServerSession(e.currentTarget.checked)}
            />
            <span>Reuse Hermes server-side session (X-Hermes-Session-Id)</span>
          </label>
          <p className="field__hint">
            Requires the Hermes server to have API_SERVER_KEY configured.
          </p>
        </section>

        <section className="settings__section" aria-labelledby="s-about">
          <h3 id="s-about" className="settings__heading">
            About
          </h3>
          <p className="field__hint">
            hermes-sidebar · open source · connects only to your configured
            Hermes endpoint.
          </p>
        </section>

        <div className="settings__footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void onSave()}
          >
            Save
          </button>
        </div>
      </div>
    </Overlay>
  );
}
