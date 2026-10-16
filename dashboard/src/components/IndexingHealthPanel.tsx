import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchIndexingHealth } from '../services/indexingHealthApi';
import type { IndexingHealth, IndexingSyncStatus } from '../types/indexingHealth';
import { formatTimestampShort } from '../utils/formatTime';
import { formatDuration } from '../utils/formatDuration';

const DEFAULT_POLL_INTERVAL_MS = 5000;

function statusLabel(status: IndexingSyncStatus): string {
  switch (status) {
    case 'synced':
      return 'Synced';
    case 'syncing':
      return 'Syncing';
    case 'degraded':
    default:
      return 'Degraded';
  }
}

function statusClass(status: IndexingSyncStatus): string {
  switch (status) {
    case 'synced':
      return 'indexing-health__status--synced';
    case 'syncing':
      return 'indexing-health__status--syncing';
    case 'degraded':
    default:
      return 'indexing-health__status--degraded';
  }
}

export function IndexingHealthPanel(props: { healthUrl: string; pollIntervalMs?: number }) {
  const pollIntervalMs = props.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const [health, setHealth] = useState<IndexingHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const effectivePollIntervalMs = useMemo(() => {
    if (typeof document === 'undefined') return pollIntervalMs;
    return document.visibilityState === 'hidden' ? pollIntervalMs * 3 : pollIntervalMs;
  }, [pollIntervalMs]);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsRefreshing(true);
    try {
      const next = await fetchIndexingHealth(props.healthUrl, { signal: controller.signal });
      setHealth(next);
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRefreshing(false);
    }
  }, [props.healthUrl]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (ms: number) => {
      if (cancelled) return;
      timer = setTimeout(async () => {
        await refresh();
        schedule(effectivePollIntervalMs);
      }, ms);
    };

    void refresh();
    schedule(effectivePollIntervalMs);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [effectivePollIntervalMs, refresh]);

  const status: IndexingSyncStatus = health?.status ?? 'degraded';
  const indexedLedger = health?.indexedLedger ?? null;
  const tipLedger = health?.networkTipLedger ?? null;

  const indexedVsTip =
    indexedLedger === null || tipLedger === null
      ? '—'
      : `${indexedLedger.toLocaleString()} / ${tipLedger.toLocaleString()}`;

  const ledgerLag =
    health?.ledgerLag === null || health?.ledgerLag === undefined
      ? '—'
      : `${health.ledgerLag.toLocaleString()} block(s)`;

  const updatedAt = health ? formatTimestampShort(health.timestampMs) : '—';
  const processingDelay = health ? formatDuration(health.processingDelayMs) : '—';
  const detail = health?.detail ?? null;

  return (
    <section className="indexing-health" aria-label="Indexing health">
      <div className="indexing-health__header">
        <div>
          <p className="indexing-health__eyebrow">Maintainer</p>
          <h2 className="indexing-health__title">Indexing Health</h2>
        </div>

        <div className="indexing-health__meta">
          <span className={`indexing-health__status ${statusClass(status)}`}>
            {statusLabel(status)}
          </span>
          <span className="indexing-health__updated">
            {isRefreshing ? 'Updating…' : `Updated ${updatedAt}`}
          </span>
        </div>
      </div>

      {error && (
        <p className="indexing-health__error" role="alert">
          {error}
        </p>
      )}

      <dl className="indexing-health__grid">
        <div className="indexing-health__metric">
          <dt>Indexed Blocks</dt>
          <dd>{indexedVsTip}</dd>
        </div>
        <div className="indexing-health__metric">
          <dt>Ledger Lag</dt>
          <dd>{ledgerLag}</dd>
        </div>
        <div className="indexing-health__metric">
          <dt>Processing Delay</dt>
          <dd>{processingDelay}</dd>
        </div>
      </dl>

      {detail && <p className="indexing-health__detail">{detail}</p>}
    </section>
  );
}
