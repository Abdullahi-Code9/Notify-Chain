import { useEventStore } from '../store/eventStore';
import { formatTimestampShort } from '../utils/formatTime';

export function SyncStatus() {
  const lastSuccessfulSyncAt = useEventStore((state) => state.lastSuccessfulSyncAt);
  const lastSyncFailureAt = useEventStore((state) => state.lastSyncFailureAt);
  const lastSyncError = useEventStore((state) => state.lastSyncError);
  const isLoading = useEventStore((state) => state.isLoading);

  // Show loading state during initial sync
  if (!lastSuccessfulSyncAt && !lastSyncFailureAt && isLoading) {
    return (
      <div className="sync-status sync-status--loading" title="Synchronizing event data...">
        <span className="sync-status__dot sync-status__dot--loading" aria-hidden="true" />
        <span>Syncing...</span>
      </div>
    );
  }

  // Hide component if never synced and not loading
  if (!lastSuccessfulSyncAt && !lastSyncFailureAt) return null;

  const label = lastSuccessfulSyncAt ? formatTimestampShort(lastSuccessfulSyncAt) : '—';
  const isError = Boolean(lastSyncError);

  return (
    <div
      className={`sync-status${isError ? ' sync-status--error' : ''}`}
      title={lastSyncError ?? undefined}
    >
      <span className="sync-status__dot" aria-hidden="true" />
      <span>Last sync: {label}</span>
      {isError && <span className="sync-status__error">refresh failed</span>}
    </div>
  );
}
