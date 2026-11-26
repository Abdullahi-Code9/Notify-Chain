/**
 * Internal diagnostics: event processing latency breakdown (issue #1120).
 *
 *   GET /api/internal/diagnostics/event-latency
 *     ?limit=<1-500>          recent records to include (default 50)
 *     ?eventId=<id>           look up one event instead of listing
 *     ?contractAddress=<addr> narrow an eventId lookup to one contract
 *
 * The response carries identifiers, outcomes and stage durations only.
 * Records never contain topics, values or any other event payload, and the
 * handler builds every response field explicitly so nothing else can leak.
 * Stages that were not measured are listed in `missingStages` with a `null`
 * duration rather than causing an error.
 */
import type http from 'http';
import {
  EVENT_STAGES,
  type EventLatencyRecord,
  type EventLatencyStore,
  type EventStage,
} from '../services/event-latency-tracker';

export const EVENT_LATENCY_DIAGNOSTICS_PATH = '/api/internal/diagnostics/event-latency';

/** Reads timings persisted with the event's processed_events record. */
export type PersistedTimingsReader = (
  eventId: string,
  contractAddress: string,
) => Promise<{
  retrievalMs: number | null;
  decodeValidationMs: number | null;
  persistenceMs: number | null;
  notificationPrepMs: number | null;
  totalMs: number | null;
  outcome: string;
  recordedAt: string;
} | null>;

export interface EventLatencyView {
  eventId: string;
  contractAddress: string;
  outcome: string;
  recordedAt: string;
  source: 'memory' | 'database';
  stages: Record<EventStage, number | null>;
  missingStages: EventStage[];
  totalMs: number | null;
}

export interface DiagnosticsResult {
  statusCode: number;
  body: unknown;
}

const MAX_ID_LENGTH = 256;

function toView(record: EventLatencyRecord): EventLatencyView {
  const stages = {} as Record<EventStage, number | null>;
  for (const stage of EVENT_STAGES) stages[stage] = record.stages[stage] ?? null;
  return {
    eventId: record.eventId,
    contractAddress: record.contractAddress,
    outcome: record.outcome,
    recordedAt: new Date(record.recordedAt).toISOString(),
    source: 'memory',
    stages,
    missingStages: [...record.missingStages],
    totalMs: record.totalMs,
  };
}

function persistedToView(
  eventId: string,
  contractAddress: string,
  row: NonNullable<Awaited<ReturnType<PersistedTimingsReader>>>,
): EventLatencyView {
  const stages: Record<EventStage, number | null> = {
    retrieval: row.retrievalMs ?? null,
    decodeValidation: row.decodeValidationMs ?? null,
    persistence: row.persistenceMs ?? null,
    notificationPrep: row.notificationPrepMs ?? null,
  };
  return {
    eventId,
    contractAddress,
    outcome: row.outcome,
    recordedAt: row.recordedAt,
    source: 'database',
    stages,
    missingStages: EVENT_STAGES.filter((stage) => stages[stage] === null),
    totalMs: row.totalMs ?? null,
  };
}

function cleanParam(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_ID_LENGTH ? trimmed : null;
}

export async function getEventLatencyDiagnostics(
  url: URL,
  store: EventLatencyStore,
  readPersisted?: PersistedTimingsReader | null,
): Promise<DiagnosticsResult> {
  const eventId = cleanParam(url.searchParams.get('eventId'));
  const contractAddress = cleanParam(url.searchParams.get('contractAddress'));

  if (url.searchParams.has('eventId') && !eventId) {
    return { statusCode: 400, body: { error: 'eventId must be 1-256 characters', code: 'BAD_REQUEST' } };
  }

  if (eventId) {
    const record = store.find(eventId, contractAddress ?? undefined);
    if (record) return { statusCode: 200, body: { record: toView(record) } };

    if (readPersisted && contractAddress) {
      try {
        const row = await readPersisted(eventId, contractAddress);
        if (row) return { statusCode: 200, body: { record: persistedToView(eventId, contractAddress, row) } };
      } catch {
        // Fall through to not-found: diagnostics never fail on a lookup error.
      }
    }
    return { statusCode: 404, body: { error: 'No latency record for event', code: 'NOT_FOUND' } };
  }

  const rawLimit = Number(url.searchParams.get('limit') ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.floor(rawLimit))) : 50;

  return {
    statusCode: 200,
    body: {
      stages: EVENT_STAGES,
      summary: store.summary(),
      records: store.list(limit).map(toView),
    },
  };
}

/** Writes a diagnostics result; kept separate so the logic stays testable. */
export function writeDiagnostics(res: http.ServerResponse, result: DiagnosticsResult): void {
  res.writeHead(result.statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(result.body));
}
