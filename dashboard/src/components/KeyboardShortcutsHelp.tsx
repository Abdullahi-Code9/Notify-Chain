/**
 * KeyboardShortcutsHelp — Modal overlay showing available shortcuts (#505)
 *
 * Displays a keyboard shortcut cheat sheet. Rendered as a dialog with
 * proper ARIA attributes and focus management.
 */
import { useEffect, useRef } from 'react';
import { NAV_ITEMS } from './MobileNavDrawer';

interface KeyboardShortcutsHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  ...NAV_ITEMS.slice(0, 9).map((item, i) => ({
    key: String(i + 1),
    label: item.label,
  })),
  { key: 'T', label: 'Toggle theme (dark/light)' },
  { key: 'R', label: 'Refresh events' },
  { key: '?', label: 'Show/hide this help' },
  { key: 'Esc', label: 'Close dialogs and overlays' },
];

export function KeyboardShortcutsHelp({ isOpen, onClose }: KeyboardShortcutsHelpProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousFocus.current = document.activeElement as HTMLElement;
      document.body.style.overflow = 'hidden';

      // Focus the dialog after render
      const timer = setTimeout(() => {
        dialogRef.current?.focus();
      }, 50);

      return () => clearTimeout(timer);
    } else {
      document.body.style.overflow = '';
      previousFocus.current?.focus();
    }
  }, [isOpen]);

  // Escape key handled by useKeyboardShortcuts, but we also handle click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="shortcuts-overlay" aria-hidden="true">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="shortcuts-dialog"
        tabIndex={-1}
      >
        <div className="shortcuts-dialog__header">
          <h2 className="shortcuts-dialog__title">Keyboard Shortcuts</h2>
          <button
            type="button"
            className="shortcuts-dialog__close"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="shortcuts-dialog__body">
          <dl className="shortcuts-list">
            {SHORTCUTS.map(({ key, label }) => (
              <div key={key} className="shortcuts-list__item">
                <dt className="shortcuts-list__key">
                  <kbd>{key}</kbd>
                </dt>
                <dd className="shortcuts-list__label">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="shortcuts-dialog__footer">
          <span className="shortcuts-dialog__hint">
            Press <kbd>?</kbd> to toggle this panel
          </span>
        </div>
      </div>
    </div>
  );
}
