import type { ConnectionStatus } from "../../shared/profile";

interface Props {
  status: ConnectionStatus;
  hostShort: string;
  onRecheck: () => void;
}

export function StatusDot({ status, hostShort, onRecheck }: Props) {
  const tone =
    status.kind === "healthy"
      ? "healthy"
      : status.kind === "connecting"
        ? "connecting"
        : status.kind === "failed"
          ? "failed"
          : "unknown";

  const label =
    status.kind === "healthy"
      ? `Connected to ${hostShort}`
      : status.kind === "connecting"
        ? `Connecting to ${hostShort}…`
        : status.kind === "failed"
          ? `Cannot reach ${hostShort}. Click to retry.`
          : `Not checked yet`;

  return (
    <button
      type="button"
      className={`status-dot status-dot--${tone}`}
      aria-label={label}
      title={label}
      onClick={onRecheck}
    />
  );
}
