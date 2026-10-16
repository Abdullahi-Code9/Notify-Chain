/**
 * Modal — accessible dialog with focus trapping (#394)
 *
 * Accessibility features:
 *  - role="dialog" with aria-modal, aria-labelledby, aria-describedby
 *  - Focus trap: Tab / Shift+Tab cycle stays within the modal
 *  - Auto-focuses first focusable element on open
 *  - Restores focus to the trigger element on close
 *  - Escape key dismisses
 *  - Body scroll locked while open
 */

import { useEffect, useRef, type ReactNode, type KeyboardEvent } from 'react';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: 'small' | 'medium' | 'large';
  footer?: ReactNode;
  /** Optional id for the description region, used in aria-describedby */
  descriptionId?: string;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'medium',
  footer,
  descriptionId,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  // ── On open/close: focus management + scroll lock ─────────────────────────
  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement as HTMLElement;
      document.body.style.overflow = 'hidden';

      // Focus first focusable element in modal, fall back to the dialog itself
      const focusable = modalRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable && focusable.length > 0) {
        focusable[0].focus();
      } else {
        modalRef.current?.focus();
      }
    } else {
      document.body.style.overflow = '';
      previousActiveElement.current?.focus();
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // ── Escape key listener ────────────────────────────────────────────────────
  useEffect(() => {
    const handleEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // ── Focus trap ────────────────────────────────────────────────────────────
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;

    const focusable = Array.from(
      modalRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    ).filter((el) => !el.closest('[aria-hidden="true"]'));

    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey) {
      // Shift+Tab: wrap from first → last
      if (active === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      // Tab: wrap from last → first
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    // Backdrop — click outside to dismiss
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      {/* Dialog */}
      <div
        ref={modalRef}
        className={`modal modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        // Stop propagation so backdrop click doesn't fire on dialog
        onClick={(e) => e.stopPropagation()}
        aria-hidden={undefined}
      >
        <div className="modal__header">
          <h2 id="modal-title" className="modal__title">
            {title}
          </h2>
          <button className="modal__close" onClick={onClose} aria-label="Close modal" type="button">
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="modal__body" id={descriptionId}>
          {children}
        </div>

        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
