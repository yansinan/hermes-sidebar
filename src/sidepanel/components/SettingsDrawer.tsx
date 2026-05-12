import { useState } from "react";
import type { AppController, AppState } from "../../shared/app-state";
import type {
  CustomContextMenuItem,
  CustomMenuSource,
  EnterBehavior,
  Settings,
} from "../../shared/settings";
import { approxTokensToChars } from "../../shared/settings";
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

function parseTokenInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const matched = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kK]?)$/);
  if (!matched) return null;

  const base = Number(matched[1]);
  if (!Number.isFinite(base) || base <= 0) return null;

  const multiplier = matched[2] ? 1_000 : 1;
  const tokens = Math.floor(base * multiplier);
  return tokens >= 1 ? tokens : null;
}

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
  const [showContextMenu, setShowContextMenu] = useState(
    settings.showReadabilityContextMenu ?? true,
  );
  const [summaryPromptTemplate, setSummaryPromptTemplate] = useState(
    settings.contextMenuPrompts.summary,
  );
  const [llmWikiSelectionPromptTemplate, setLlmWikiSelectionPromptTemplate] = useState(
    settings.contextMenuPrompts.llmWikiSelection,
  );
  const [llmWikiPagePromptTemplate, setLlmWikiPagePromptTemplate] = useState(
    settings.contextMenuPrompts.llmWikiPage,
  );
  const [customMenuItems, setCustomMenuItems] = useState<CustomContextMenuItem[]>(
    settings.customContextMenuItems ?? [],
  );
  const [maxDomInputTokensInput, setMaxDomInputTokensInput] = useState(
    String(settings.maxDomInputTokens ?? 60_000),
  );
  const [maxDomInputTokensError, setMaxDomInputTokensError] = useState<string | null>(
    null,
  );
  const [testResult, setTestResult] = useState<TestResult>({ kind: "idle" });
  const [urlError, setUrlError] = useState<string | null>(null);

  const updateCustomMenuItem = (
    id: string,
    patch: Partial<CustomContextMenuItem>,
  ) => {
    setCustomMenuItems((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const removeCustomMenuItem = (id: string) => {
    setCustomMenuItems((items) => items.filter((item) => item.id !== id));
  };

  const addCustomMenuItem = () => {
    const id =
      globalThis.crypto?.randomUUID?.() ??
      `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCustomMenuItems((items) => [
      ...items,
      {
        id,
        title: "自定义菜单",
        source: "page-dom",
        promptTemplate:
          "请处理下面 DOM 内容：\n\n标题：{{title}}\n链接：{{url}}\n\n{{dom_html}}",
        enabled: true,
      },
    ]);
  };

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
    const parsedMaxDomTokens = parseTokenInput(maxDomInputTokensInput);
    if (parsedMaxDomTokens === null) {
      setMaxDomInputTokensError("请输入正整数 tokens，支持 k/K 后缀，如 60000、60k、20K。");
      return;
    }
    setMaxDomInputTokensError(null);
    setUrlError(null);
    const patch: Partial<Settings> = {
      apiBaseUrl: apiBaseUrl.trim(),
      apiKey,
      enterBehavior,
      streamingEnabled,
      reuseServerSession,
      sendIdempotencyKey,
      showReadabilityContextMenu: showContextMenu,
      contextMenuPrompts: {
        summary: summaryPromptTemplate,
        llmWikiSelection: llmWikiSelectionPromptTemplate,
        llmWikiPage: llmWikiPagePromptTemplate,
      },
      customContextMenuItems: customMenuItems,
      maxDomInputTokens: parsedMaxDomTokens,
    };
    await controller.saveSettings(patch);
    onClose();
  };

  const parsedMaxDomTokens = parseTokenInput(maxDomInputTokensInput);

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
              checked={showContextMenu}
              onChange={(e) => setShowContextMenu(e.currentTarget.checked)}
            />
            <span>在右键菜单显示“提取页面内容（Readability）”</span>
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
          <label className="field">
            <span className="field__label">DOM 输入最大限制（tokens）</span>
            <input
              className="field__input"
              type="text"
              inputMode="numeric"
              value={maxDomInputTokensInput}
              onChange={(e) => {
                setMaxDomInputTokensInput(e.currentTarget.value);
                if (maxDomInputTokensError) {
                  setMaxDomInputTokensError(null);
                }
              }}
              placeholder="60000 或 60k"
              aria-invalid={maxDomInputTokensError ? true : undefined}
            />
            <span className="field__hint">
              近似换算：1 token ≈ 4 chars。当前上限约 {approxTokensToChars(parsedMaxDomTokens ?? 0)} chars。
            </span>
            {maxDomInputTokensError && (
              <span className="field__error" role="alert">
                {maxDomInputTokensError}
              </span>
            )}
          </label>
        </section>

        <section className="settings__section" aria-labelledby="s-about">
          <h3 id="s-menu-prompts" className="settings__heading">
            Context Menu Prompts
          </h3>
          <label className="field">
            <span className="field__label">总结 Prompt 模板</span>
            <textarea
              className="field__input"
              rows={8}
              value={summaryPromptTemplate}
              onChange={(e) => setSummaryPromptTemplate(e.currentTarget.value)}
            />
            <span className="field__hint">
              {"可用变量: {{title}}, {{url}}, {{dom_html}}, {{text}}, {{now_iso}}"}
            </span>
          </label>

          <label className="field">
            <span className="field__label">选中内容到LLM-Wiki Prompt 模板</span>
            <textarea
              className="field__input"
              rows={8}
              value={llmWikiSelectionPromptTemplate}
              onChange={(e) => setLlmWikiSelectionPromptTemplate(e.currentTarget.value)}
            />
            <span className="field__hint">
              仅发送 DOM 时会执行。可用变量同上。
            </span>
          </label>

          <label className="field">
            <span className="field__label">收到llm-wiki Prompt 模板（全页）</span>
            <textarea
              className="field__input"
              rows={8}
              value={llmWikiPagePromptTemplate}
              onChange={(e) => setLlmWikiPagePromptTemplate(e.currentTarget.value)}
            />
          </label>

          <div className="settings__row">
            <span className="field__label">自定义菜单项</span>
            <button
              type="button"
              className="secondary-button"
              onClick={addCustomMenuItem}
            >
              + 添加菜单项
            </button>
          </div>

          {customMenuItems.map((item, index) => (
            <div key={item.id} className="settings__section" aria-label={`custom-menu-${index + 1}`}>
              <label className="field">
                <span className="field__label">菜单标题</span>
                <input
                  className="field__input"
                  type="text"
                  value={item.title}
                  onChange={(e) =>
                    updateCustomMenuItem(item.id, { title: e.currentTarget.value })
                  }
                />
              </label>
              <label className="field">
                <span className="field__label">数据来源</span>
                <select
                  className="field__input"
                  value={item.source}
                  onChange={(e) =>
                    updateCustomMenuItem(item.id, {
                      source: e.currentTarget.value as CustomMenuSource,
                    })
                  }
                >
                  <option value="page-dom">全页 DOM（Readability）</option>
                  <option value="selection-dom">选区 DOM</option>
                </select>
              </label>
              <label className="field">
                <span className="field__label">Prompt 模板</span>
                <textarea
                  className="field__input"
                  rows={6}
                  value={item.promptTemplate}
                  onChange={(e) =>
                    updateCustomMenuItem(item.id, {
                      promptTemplate: e.currentTarget.value,
                    })
                  }
                />
              </label>
              <label className="field field--checkbox">
                <input
                  type="checkbox"
                  checked={item.enabled}
                  onChange={(e) =>
                    updateCustomMenuItem(item.id, { enabled: e.currentTarget.checked })
                  }
                />
                <span>启用此菜单项</span>
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={() => removeCustomMenuItem(item.id)}
              >
                删除该菜单项
              </button>
            </div>
          ))}
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
