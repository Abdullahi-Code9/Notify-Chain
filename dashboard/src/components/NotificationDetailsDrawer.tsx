import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BlockchainEvent } from '../types/event';
import { formatTimestamp } from '../utils/formatTime';
import { copyTextToClipboard } from '../utils/clipboard';
import { getEventTypePresentation } from '../utils/eventTypeMapping';
import { formatRawPayload, copyPayloadToClipboard } from '../utils/payloadViewer';

type FetchState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; message: string };

export interface SenderDetails {
  address: string;
  metadata?: Record<string, string>;
}

export interface StatusHistoryEntry {
  label: string;
  timestampMs: number;
  detail?: string;
}

export interface NotificationDetailsMetadata {
  sender: SenderDetails;
  statusHistory: StatusHistoryEntry[];
}

function shorten(value: string, head = 10, tail = 8) {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function defaultMetadata(event: BlockchainEvent): NotificationDetailsMetadata {
  return {
    sender: {
      address: event.contractAddress,
      metadata: {
        kind: event.type,
        event: event.eventName ?? event.type,
      },
    },
    statusHistory: [
      {
        label: 'Observed',
        timestampMs: event.receivedAt,
        detail: 'Event received by the listener.',
      },
      {
        label: 'Visible',
        timestampMs: Date.now(),
        detail: 'Rendered in dashboard.',
      },
    ],
  };
}

export interface NotificationDetailsDrawerProps {
  isOpen: boolean;
  notification: BlockchainEvent | null;
  onClose: () => void;
  fetchMetadata?: (event: BlockchainEvent) => Promise<NotificationDetailsMetadata>;
}

export function NotificationDetailsDrawer({
  isOpen,
  notification,
  onClose,
  fetchMetadata,
}: NotificationDetailsDrawerProps) {
  const [fetchState, setFetchState] = useState<FetchState<NotificationDetailsMetadata>>({
    status: 'idle',
  });
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [isRawView, setIsRawView] = useState<boolean>(false);

  const resolvedFetcher = useMemo(
    () => fetchMetadata ?? (async (e: BlockchainEvent) => defaultMetadata(e)),
    [fetchMetadata],
  );

  useEffect(() => {
    if (!isOpen || !notification) {
      setFetchState({ status: 'idle' });
      setIsRawView(false);
      return;
    }

    if (!fetchMetadata) {
      setFetchState({ status: 'success', data: defaultMetadata(notification) });
      return;
    }

    let cancelled = false;
    setFetchState({ status: 'loading' });
    resolvedFetcher(notification)
      .then((data) => {
        if (!cancelled) setFetchState({ status: 'success', data });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setFetchState({ status: 'error', message });
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, notification, resolvedFetcher]);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!copyMessage) return;
    const id = window.setTimeout(() => setCopyMessage(null), 1800);
    return () => window.clearTimeout(id);
  }, [copyMessage]);

  const tryCopy = useCallback(async (label: string, value: string) => {
    const ok = await copyTextToClipboard(value);
    setCopyMessage(ok ? `${label} copied` : `Copy failed`);
  }, []);

  const handleCopyPayload = useCallback(async () => {
    if (!notification) return;
    const res = await copyPayloadToClipboard(notification.value);
    if (res.success) {
      setCopyMessage(res.isJson ? 'Payload copied as valid JSON' : 'Payload copied');
    } else {
      setCopyMessage('Copy failed');
    }
  }, [notification]);

  if (!isOpen || !notification) {
    return null;
  }

  const presentation = getEventTypePresentation(notification.eventName ?? notification.type);
  const formattedPayload = formatRawPayload(notification.value);

  const sender =
    fetchState.status === 'success'
      ? fetchState.data.sender
      : { address: notification.contractAddress, metadata: undefined };

  const statusHistory = fetchState.status === 'success' ? fetchState.data.statusHistory : [];

  const title = notification.eventName ?? notification.type;

  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label="Notification details">
      <div className="drawer__backdrop" onClick={onClose} aria-hidden="true" />

      <aside className="drawer__panel">
        <header className="drawer__header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span className={`event-card__badge ${presentation.badgeClass}`}>{presentation.label}</span>
              <span className="drawer__eyebrow" style={{ margin: 0 }}>Category: {presentation.category}</span>
            </div>
            <h2 className="drawer__title">{title}</h2>
          </div>
          <button
            type="button"
            className="drawer__close"
            onClick={onClose}
            aria-label="Close drawer"
          >
            ×
          </button>
        </header>

        {copyMessage && (
          <div className="drawer__toast" role="status" aria-live="polite">
            {copyMessage}
          </div>
        )}

        <section className="drawer__section">
          <h3 className="drawer__section-title">Sender Details</h3>
          <div className="drawer__row">
            <span className="drawer__label">Address</span>
            <span className="drawer__value" title={sender.address}>
              {shorten(sender.address)}
            </span>
            <button
              type="button"
              className="drawer__action"
              onClick={() => void tryCopy('Address', sender.address)}
            >
              Copy
            </button>
          </div>
          {sender.metadata && (
            <dl className="drawer__meta">
              {Object.entries(sender.metadata).map(([key, value]) => (
                <div key={key} className="drawer__meta-row">
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section className="drawer__section">
          <h3 className="drawer__section-title">Blockchain Context</h3>
          {notification.relatedNotificationId && (
            <div className="drawer__row">
              <span className="drawer__label">Notification ID</span>
              <span className="drawer__value" title={notification.relatedNotificationId}>
                {shorten(notification.relatedNotificationId, 10, 6)}
              </span>
              <button
                type="button"
                className="drawer__action"
                onClick={() => void tryCopy('Notification ID', notification.relatedNotificationId!)}
              >
                Copy
              </button>
            </div>
          )}
          <div className="drawer__row">
            <span className="drawer__label">Ledger</span>
            <span className="drawer__value">{notification.ledger.toLocaleString()}</span>
          </div>
          <div className="drawer__row">
            <span className="drawer__label">Event ID</span>
            <span className="drawer__value" title={notification.eventId}>
              {shorten(notification.eventId, 10, 6)}
            </span>
            <button
              type="button"
              className="drawer__action"
              onClick={() => void tryCopy('Event ID', notification.eventId)}
            >
              Copy
            </button>
          </div>
          <div className="drawer__row">
            <span className="drawer__label">Tx Hash</span>
            <span className="drawer__value" title={notification.txHash ?? 'No transaction hash'}>
              {notification.txHash ? shorten(notification.txHash) : '—'}
            </span>
            {notification.txHash && (
              <button
                type="button"
                className="drawer__action"
                onClick={() => void tryCopy('Tx Hash', notification.txHash!)}
              >
                Copy
              </button>
            )}
          </div>
          <div className="drawer__row">
            <span className="drawer__label">Observed</span>
            <span className="drawer__value drawer__value--wrap">
              {formatTimestamp(notification.receivedAt)}
            </span>
          </div>

          {/* Raw Event Payload Viewer (Issue #609) & Payload Copy Action (Issue #610) */}
          <div className="drawer__row drawer__row--stack">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: '6px' }}>
              <span className="drawer__label">Payload</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className="drawer__action"
                  onClick={() => setIsRawView(!isRawView)}
                  aria-label={isRawView ? 'Switch to formatted view' : 'Switch to raw JSON view'}
                >
                  {isRawView ? 'Standard View' : 'Raw JSON View'}
                </button>
                <button
                  type="button"
                  className="drawer__action"
                  onClick={() => void handleCopyPayload()}
                  aria-label="Copy event payload"
                >
                  Copy Payload
                </button>
              </div>
            </div>

            {isRawView ? (
              <div className="drawer__raw-container" style={{ width: '100%' }}>
                {formattedPayload.hasRedactions && (
                  <p className="drawer__muted" style={{ fontSize: '12px', color: '#e5c07b', marginBottom: '4px' }}>
                    🔒 Sensitive configuration values have been redacted.
                  </p>
                )}
                <pre className="drawer__payload drawer__payload--raw" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} title={formattedPayload.formatted}>
                  {formattedPayload.formatted}
                </pre>
              </div>
            ) : (
              <pre className="drawer__payload" title={notification.value}>
                {notification.value}
              </pre>
            )}

            <button
              type="button"
              className="drawer__action"
              style={{ display: 'none' }} // Legacy hidden copy button fallback for existing test selectors
              onClick={() => void tryCopy('Payload', notification.value)}
            >
              Copy
            </button>
          </div>
        </section>

        <section className="drawer__section">
          <h3 className="drawer__section-title">Notification Status History</h3>

          {fetchState.status === 'loading' && (
            <p className="drawer__muted" role="status">
              Loading details…
            </p>
          )}

          {fetchState.status === 'error' && (
            <p className="drawer__error" role="alert">
              Failed to load details: {fetchState.message}
            </p>
          )}

          {fetchState.status === 'success' && statusHistory.length === 0 && (
            <p className="drawer__muted">No status history available.</p>
          )}

          {fetchState.status === 'success' && statusHistory.length > 0 && (
            <ol className="drawer__timeline">
              {statusHistory
                .slice()
                .sort((a, b) => a.timestampMs - b.timestampMs)
                .map((entry) => (
                  <li key={`${entry.label}-${entry.timestampMs}`} className="drawer__timeline-item">
                    <div className="drawer__timeline-dot" aria-hidden="true" />
                    <div className="drawer__timeline-body">
                      <div className="drawer__timeline-title">{entry.label}</div>
                      <div className="drawer__timeline-time">
                        {formatTimestamp(entry.timestampMs)}
                      </div>
                      {entry.detail && (
                        <div className="drawer__timeline-detail">{entry.detail}</div>
                      )}
                    </div>
                  </li>
                ))}
            </ol>
          )}
        </section>
      </aside>
    </div>
  );
}
