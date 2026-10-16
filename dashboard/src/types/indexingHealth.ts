export type IndexingSyncStatus = 'synced' | 'syncing' | 'degraded';

export interface IndexingHealthDto {
  status?: unknown;
  timestamp?: unknown;
  indexedLedger?: unknown;
  networkTipLedger?: unknown;
  ledgerLag?: unknown;
  processingDelayMs?: unknown;
  lastIngestedAt?: unknown;
  detail?: unknown;
}

export interface IndexingHealth {
  status: IndexingSyncStatus;
  timestampMs: number;
  indexedLedger: number | null;
  networkTipLedger: number | null;
  ledgerLag: number | null;
  processingDelayMs: number | null;
  lastIngestedAtMs: number | null;
  detail: string | null;
}

function parseNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function parseIndexingHealth(payload: unknown): IndexingHealth {
  const dto = (payload ?? {}) as IndexingHealthDto;
  const status =
    dto.status === 'synced' || dto.status === 'syncing' || dto.status === 'degraded'
      ? (dto.status as IndexingSyncStatus)
      : 'degraded';

  const timestampMs = parseTimestampMs(dto.timestamp) ?? Date.now();
  const indexedLedger = parseNumberOrNull(dto.indexedLedger);
  const networkTipLedger = parseNumberOrNull(dto.networkTipLedger);
  const ledgerLag = parseNumberOrNull(dto.ledgerLag);
  const processingDelayMs = parseNumberOrNull(dto.processingDelayMs);
  const lastIngestedAtMs = parseTimestampMs(dto.lastIngestedAt);
  const detail = typeof dto.detail === 'string' && dto.detail.trim() ? dto.detail.trim() : null;

  return {
    status,
    timestampMs,
    indexedLedger,
    networkTipLedger,
    ledgerLag,
    processingDelayMs,
    lastIngestedAtMs,
    detail,
  };
}
