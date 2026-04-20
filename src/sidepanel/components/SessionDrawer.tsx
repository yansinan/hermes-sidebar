import { useState } from "react";
import type { AppController, AppState } from "../../shared/app-state";
import type { Session } from "../../shared/session";
import { Overlay } from "./Overlay";

interface Props {
  state: AppState;
  controller: AppController;
  onClose: () => void;
}

export function SessionDrawer({ state, controller, onClose }: Props) {
  const { sessions, activeSessionId, activeProfile, sessionPhases } = state;

  const onNew = () => {
    controller.newDraft();
    onClose();
  };

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <Overlay title="Sessions" onClose={onClose} panelClassName="overlay__panel--drawer">
      <div className="session-drawer">
        <button
          type="button"
          className="session-drawer__new primary-button"
          onClick={onNew}
        >
          + New session
        </button>

        {sorted.length === 0 ? (
          <div className="session-drawer__empty">
            <p>No conversations yet for {activeProfile.hostShort}.</p>
            <p className="session-drawer__empty-hint">Start one below.</p>
          </div>
        ) : (
          <ul className="session-list" role="list">
            {sorted.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                isActive={s.id === activeSessionId}
                isStreaming={sessionPhases[s.id] === "streaming"}
                onSelect={() => {
                  controller.switchSession(s.id);
                  onClose();
                }}
                onRename={(t) => controller.renameSession(s.id, t)}
                onDelete={() => controller.deleteSession(s.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </Overlay>
  );
}

function SessionRow({
  session,
  isActive,
  isStreaming,
  onSelect,
  onRename,
  onDelete,
}: {
  session: Session;
  isActive: boolean;
  isStreaming: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);

  if (editing) {
    return (
      <li
        className={`session-row session-row--editing${isActive ? " session-row--active" : ""}`}
      >
        <input
          className="session-row__edit-input"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const t = draftTitle.trim();
              if (t) {
                onRename(t);
                setEditing(false);
              }
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraftTitle(session.title);
              setEditing(false);
            }
          }}
          aria-label="Rename session"
          autoFocus
        />
        <div className="session-row__actions">
          <button
            type="button"
            className="session-row__action"
            onClick={() => {
              const t = draftTitle.trim();
              if (t) {
                onRename(t);
                setEditing(false);
              }
            }}
          >
            Save
          </button>
          <button
            type="button"
            className="session-row__action"
            onClick={() => {
              setDraftTitle(session.title);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={`session-row${isActive ? " session-row--active" : ""}`}
      aria-current={isActive ? "true" : undefined}
    >
      <button
        type="button"
        className="session-row__select"
        onClick={onSelect}
        aria-label={`Open session ${session.title}`}
      >
        <span className="session-row__title">{session.title}</span>
        <span className="session-row__meta">
          {isStreaming && (
            <span className="session-row__streaming" aria-label="Streaming">
              •••
            </span>
          )}
          <span className="session-row__time">{formatRelative(session.updatedAt)}</span>
          <span className="session-row__model">{session.modelId}</span>
        </span>
      </button>

      <div className="session-row__actions">
        <button
          type="button"
          className="session-row__action"
          onClick={() => setEditing(true)}
          aria-label={`Rename ${session.title}`}
        >
          Rename
        </button>
        {confirmDelete ? (
          <>
            <button
              type="button"
              className="session-row__action session-row__action--danger"
              onClick={() => {
                onDelete();
                setConfirmDelete(false);
              }}
              aria-label={`Confirm delete ${session.title}`}
            >
              Confirm delete?
            </button>
            <button
              type="button"
              className="session-row__action"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="session-row__action"
            onClick={() => setConfirmDelete(true)}
            aria-label={`Delete ${session.title}`}
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  return `${day} days ago`;
}
