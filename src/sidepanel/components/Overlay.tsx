import { useEffect, useRef } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Optional class applied to the overlay panel for per-drawer tweaks. */
  panelClassName?: string;
}

// Lightweight overlay with Escape-to-close and backdrop-click-to-close.
// Focus moves to the first focusable element inside the panel on mount.
export function Overlay({ title, onClose, children, panelClassName }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    // Focus the first focusable inside the panel.
    const first = panelRef.current?.querySelector<HTMLElement>(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      returnFocusRef.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`overlay__panel${panelClassName ? ` ${panelClassName}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="overlay__header">
          <h2 className="overlay__title">{title}</h2>
          <button
            type="button"
            className="overlay__close"
            onClick={onClose}
            aria-label="Close"
          >
            <span aria-hidden>×</span>
          </button>
        </header>
        <div className="overlay__body">{children}</div>
      </div>
    </div>
  );
}
