interface Props {
  onSummarizeSelection: () => void;
  onSummarizePageBody: () => void;
}

/**
 * Keep the high-frequency actions in a standalone bar so we can add more
 * browser-centric entry points later without reworking the composer.
 */
export function QuickActionBar({
  onSummarizeSelection,
  onSummarizePageBody,
}: Props) {
  return (
    <div className="quick-action-bar" aria-label="Quick actions">
      <button
        type="button"
        onClick={onSummarizeSelection}
        className="quick-action-bar__button quick-action-bar__button--primary"
      >
        总结选区
      </button>
      <button
        type="button"
        onClick={onSummarizePageBody}
        className="quick-action-bar__button"
      >
        总结正文
      </button>
    </div>
  );
}
