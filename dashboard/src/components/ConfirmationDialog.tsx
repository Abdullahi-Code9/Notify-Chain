/**
 * ConfirmationDialog  (Issue #653)
 *
 * A reusable, accessible confirmation dialog that wraps the existing Modal
 * component.  Use it wherever an action requires explicit user sign-off
 * (e.g. deleting a channel, revoking a subscription) so the confirmation
 * logic is never duplicated across pages.
 *
 * Accessibility highlights:
 *  - role="alertdialog" signals urgency to screen readers
 *  - aria-describedby points at the message text
 *  - Confirm button receives initial focus (primary action)
 *  - Focus trap and Escape-to-cancel are inherited from Modal
 *  - Keyboard: Enter on focused button fires its action; Tab cycles within
 */

import { useRef, useEffect, type KeyboardEvent } from 'react';

export interface ConfirmationDialogProps {
  /** Controls visibility. */
  isOpen: boolean;
  /** Dialog heading. */
  title: string;
  /** Descriptive message explaining what the action will do. */
  message: string;
  /** Label for the confirm button (default: "Confirm"). */
  confirmLabel?: string;
  /** Label for the cancel button (default: "Cancel"). */
  cancelLabel?: string;
  /** Fired when the user clicks Confirm or presses Enter on it. */
  onConfirm: () => void;
  /** Fired when the user clicks Cancel, presses Escape, or clicks the backdrop. */
  onCancel: () => void;
  /**
   * Visual variant for the confirm button.
   * - "danger"  → red  (destructive actions like delete)
   * - "primary" → blue (default, safe confirmations)
   */
  variant?: 'danger' | 'primary';
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function ConfirmationDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  variant = 'primary',
}: ConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // ── Focus management ──────────────────────────────────────────────────────
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      // Auto-focus the confirm button so a single Enter press confirms
      confirmBtnRef.current?.focus();
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
      previousFocusRef.current?.focus();
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // ── Escape key ────────────────────────────────────────────────────────────
  useEffect(() => {
    const handleEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onCancel();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onCancel]);

  // ── Focus trap ────────────────────────────────────────────────────────────
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    );

    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey) {
      if (active === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCancel();
  };

  if (!isOpen) return null;

  const descId = 'confirmation-dialog-desc';

  return (
    <div
      className="confirmation-dialog__backdrop"
      onClick={handleBackdropClick}
      data-testid="confirmation-dialog-backdrop"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-dialog-title"
        aria-describedby={descId}
        className="confirmation-dialog"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        data-testid="confirmation-dialog"
      >
        <h2 id="confirmation-dialog-title" className="confirmation-dialog__title">
          {title}
        </h2>

        <p id={descId} className="confirmation-dialog__message">
          {message}
        </p>

        <div className="confirmation-dialog__actions">
          {/* Confirm gets focus first — most dialogs are triggered intentionally */}
          <button
            ref={confirmBtnRef}
            type="button"
            className={`confirmation-dialog__btn confirmation-dialog__btn--${variant}`}
            onClick={onConfirm}
            data-testid="confirmation-dialog-confirm"
          >
            {confirmLabel}
          </button>

          <button
            type="button"
            className="confirmation-dialog__btn confirmation-dialog__btn--cancel"
            onClick={onCancel}
            data-testid="confirmation-dialog-cancel"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
