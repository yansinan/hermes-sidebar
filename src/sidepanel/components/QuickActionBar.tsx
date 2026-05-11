interface Props {
  onSummarize: () => void;
}

export function QuickActionBar({ onSummarize }: Props) {
  return (
    <div className="quick-action-bar" aria-label="Quick actions">
      <button type="button" onClick={onSummarize} className="quick-action-bar__button">
        总结
      </button>
    </div>
  );
}
