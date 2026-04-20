import { useState } from "react";
import type { ToolProgressEntry } from "../../shared/tool-progress";

interface Props {
  entries: ToolProgressEntry[];
}

// Inline collapsible tool-progress block (docs/ui-spec.md §3.4).
// v1 deliberately keeps this minimal: tool name + phase text, no payload render.
export function ToolProgressBlock({ entries }: Props) {
  if (entries.length === 0) return null;
  return (
    <ul className="tool-progress" aria-label="Tool activity">
      {entries.map((e) => (
        <ToolProgressRow key={e.id} entry={e} />
      ))}
    </ul>
  );
}

function ToolProgressRow({ entry }: { entry: ToolProgressEntry }) {
  const [open, setOpen] = useState(false);
  const done = entry.phase === "end";
  return (
    <li className={`tool-progress__row tool-progress__row--${entry.phase}`}>
      <button
        type="button"
        className="tool-progress__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${entry.statusText}, ${open ? "collapse" : "expand"}`}
      >
        <span
          className={`tool-progress__icon tool-progress__icon--${done ? "done" : "active"}`}
          aria-hidden
        >
          {done ? "✓" : "…"}
        </span>
        <span className="tool-progress__name">{entry.toolName}</span>
        <span className="tool-progress__status">{entry.statusText}</span>
      </button>
      {open && (
        <div className="tool-progress__details">
          <div>
            <strong>Status:</strong> {entry.statusText}
          </div>
          {entry.endedAt && (
            <div className="tool-progress__meta">
              Duration:{" "}
              {Math.max(0, Math.round((entry.endedAt - entry.startedAt) / 100) / 10)}
              s
            </div>
          )}
        </div>
      )}
    </li>
  );
}
