/**
 * ToastContext — global toast notification system (#397)
 *
 * Provides a context-based toast queue with:
 *  - success / error / info / warning variants
 *  - auto-dismiss (default 4 000 ms, configurable per toast)
 *  - manual close button
 *  - aria-live="polite" for success/info/warning
 *  - aria-live="assertive" for errors (screen-reader immediacy)
 */

import { createContext, useCallback, useContext, useReducer, useRef, type ReactNode } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  /** Duration in ms before auto-dismiss. Pass 0 to disable auto-dismiss. */
  duration: number;
}

interface ToastState {
  toasts: Toast[];
}

type ToastAction = { type: 'ADD'; toast: Toast } | { type: 'REMOVE'; id: string };

// ─── Reducer ──────────────────────────────────────────────────────────────────

function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case 'ADD':
      return { toasts: [...state.toasts, action.toast] };
    case 'REMOVE':
      return { toasts: state.toasts.filter((t) => t.id !== action.id) };
    default:
      return state;
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface ToastContextValue {
  toasts: Toast[];
  addToast: (message: string, variant?: ToastVariant, duration?: number) => void;
  removeToast: (id: string) => void;
  /** Convenience helpers */
  showSuccess: (message: string, duration?: number) => void;
  showError: (message: string, duration?: number) => void;
  showInfo: (message: string, duration?: number) => void;
  showWarning: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

let idCounter = 0;
function nextId(): string {
  return `toast-${++idCounter}-${Date.now()}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(toastReducer, { toasts: [] });
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    dispatch({ type: 'REMOVE', id });
  }, []);

  const addToast = useCallback(
    (message: string, variant: ToastVariant = 'info', duration = 4000) => {
      const id = nextId();
      const toast: Toast = { id, message, variant, duration };
      dispatch({ type: 'ADD', toast });

      if (duration > 0) {
        const timer = setTimeout(() => removeToast(id), duration);
        timers.current.set(id, timer);
      }
    },
    [removeToast],
  );

  const showSuccess = useCallback(
    (message: string, duration?: number) => addToast(message, 'success', duration),
    [addToast],
  );
  const showError = useCallback(
    (message: string, duration?: number) => addToast(message, 'error', duration),
    [addToast],
  );
  const showInfo = useCallback(
    (message: string, duration?: number) => addToast(message, 'info', duration),
    [addToast],
  );
  const showWarning = useCallback(
    (message: string, duration?: number) => addToast(message, 'warning', duration),
    [addToast],
  );

  return (
    <ToastContext.Provider
      value={{
        toasts: state.toasts,
        addToast,
        removeToast,
        showSuccess,
        showError,
        showInfo,
        showWarning,
      }}
    >
      {children}
      <ToastContainer toasts={state.toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a <ToastProvider>');
  }
  return ctx;
}

// ─── Toast UI Container ───────────────────────────────────────────────────────

const VARIANT_ICONS: Record<ToastVariant, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠',
};

const VARIANT_LABELS: Record<ToastVariant, string> = {
  success: 'Success',
  error: 'Error',
  info: 'Info',
  warning: 'Warning',
};

function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  if (toasts.length === 0) return null;

  // Separate by aria-live politeness
  const polite = toasts.filter((t) => t.variant !== 'error');
  const assertive = toasts.filter((t) => t.variant === 'error');

  return (
    <div className="toast-viewport" aria-label="Notifications">
      {/* Polite region — success, info, warning */}
      <div aria-live="polite" aria-atomic="false" className="toast-live-region">
        {polite.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onRemove={onRemove} />
        ))}
      </div>

      {/* Assertive region — errors */}
      <div aria-live="assertive" aria-atomic="false" className="toast-live-region">
        {assertive.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onRemove={onRemove} />
        ))}
      </div>
    </div>
  );
}

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  return (
    <div
      role="status"
      className={`toast toast--${toast.variant}`}
      aria-label={`${VARIANT_LABELS[toast.variant]}: ${toast.message}`}
    >
      <span className="toast__icon" aria-hidden="true">
        {VARIANT_ICONS[toast.variant]}
      </span>
      <span className="toast__message">{toast.message}</span>
      <button
        type="button"
        className="toast__close"
        aria-label={`Dismiss ${VARIANT_LABELS[toast.variant].toLowerCase()} notification`}
        onClick={() => onRemove(toast.id)}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
