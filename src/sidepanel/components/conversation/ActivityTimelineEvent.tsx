import { useState } from "react";

interface Props {
  content: string;
}

export function ActivityTimelineEvent({ content }: Props) {
  const [open, setOpen] = useState(false);
  const { time, title, detail } = parseTimelineContent(content);
  const hasDetail = detail.length > 0;
  const expanded = hasDetail && open;

  const header = (
    <>
      <span className="message__activity-chevron" aria-hidden>
        {hasDetail ? (expanded ? "⌄" : "›") : "›"}
      </span>
      {time ? <span className="message__activity-time">{time}</span> : null}
      <span className="message__activity-tag">{title}</span>
    </>
  );

  return (
    <div className={`message__activity ${expanded ? "message__activity--open" : "message__activity--closed"}`}>
      {hasDetail ? (
        <button
          type="button"
          className="message__activity-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={expanded}
          aria-label={`${title}, ${expanded ? "collapse" : "expand"}`}
        >
          {header}
        </button>
      ) : (
        <div className="message__activity-static">{header}</div>
      )}
      {expanded && (
        <div className="message__activity-body" aria-hidden={!open}>
          <span className="message__activity-body-text">{detail}</span>
        </div>
      )}
    </div>
  );
}

function parseTimelineContent(content: string): {
  time: string;
  title: string;
  detail: string;
} {
  const match = content.match(/^(\d{2}:\d{2}:\d{2})\s+(.*)$/s);
  const raw = (match?.[2] ?? content).trim();
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const title = lines[0] ?? raw;
  const detail = lines.slice(1).join("\n");
  return {
    time: match?.[1] ?? "",
    title,
    detail,
  };
}