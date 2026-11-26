import { getEventLatencyDiagnostics } from './event-latency-diagnostics';
import { EventLatencyStore } from '../services/event-latency-tracker';

const url = (query = '') => new URL(`http://localhost/api/internal/diagnostics/event-latency${query}`);

describe('event latency diagnostics (#1120)', () => {
  let store: EventLatencyStore;

  beforeEach(() => {
    store = new EventLatencyStore();
    store.record({
      eventId: 'e1',
      contractAddress: 'CA',
      outcome: 'processed',
      stages: { retrieval: 4, decodeValidation: 1, persistence: 2, notificationPrep: 8 },
      recordedAt: 0,
    });
    store.record({ eventId: 'e2', contractAddress: 'CA', outcome: 'skipped', stages: { decodeValidation: 1 } });
  });

  it('lists recent records with a per-stage summary', async () => {
    const result = await getEventLatencyDiagnostics(url('?limit=1'), store);
    const body = result.body as any;
    expect(result.statusCode).toBe(200);
    expect(body.records).toHaveLength(1);
    expect(body.records[0].eventId).toBe('e2');
    expect(body.summary.sampleSize).toBe(2);
    expect(body.stages).toEqual(['retrieval', 'decodeValidation', 'persistence', 'notificationPrep']);
  });

  it('reports missing stages as null without failing', async () => {
    const result = await getEventLatencyDiagnostics(url('?eventId=e2'), store);
    const record = (result.body as any).record;
    expect(result.statusCode).toBe(200);
    expect(record.stages).toEqual({
      retrieval: null,
      decodeValidation: 1,
      persistence: null,
      notificationPrep: null,
    });
    expect(record.missingStages).toEqual(['retrieval', 'persistence', 'notificationPrep']);
  });

  it('exposes only identifiers, outcome and durations', async () => {
    const result = await getEventLatencyDiagnostics(url('?eventId=e1'), store);
    expect(Object.keys((result.body as any).record).sort()).toEqual(
      ['contractAddress', 'eventId', 'missingStages', 'outcome', 'recordedAt', 'source', 'stages', 'totalMs'].sort(),
    );
    expect((result.body as any).record.totalMs).toBe(15);
  });

  it('falls back to persisted timings and treats reader errors as not found', async () => {
    const reader = jest
      .fn()
      .mockResolvedValueOnce({
        retrievalMs: 1,
        decodeValidationMs: null,
        persistenceMs: 2,
        notificationPrepMs: null,
        totalMs: 3,
        outcome: 'processed',
        recordedAt: '2026-01-01 00:00:00',
      })
      .mockRejectedValueOnce(new Error('db down'));

    const found = await getEventLatencyDiagnostics(url('?eventId=old&contractAddress=CA'), store, reader);
    expect(found.statusCode).toBe(200);
    expect((found.body as any).record).toMatchObject({
      source: 'database',
      missingStages: ['decodeValidation', 'notificationPrep'],
    });

    const failed = await getEventLatencyDiagnostics(url('?eventId=old&contractAddress=CA'), store, reader);
    expect(failed.statusCode).toBe(404);
  });

  it('validates parameters', async () => {
    expect((await getEventLatencyDiagnostics(url('?eventId='), store)).statusCode).toBe(400);
    expect((await getEventLatencyDiagnostics(url('?eventId=missing'), store)).statusCode).toBe(404);
    const clamped = await getEventLatencyDiagnostics(url('?limit=abc'), store);
    expect((clamped.body as any).records).toHaveLength(2);
  });
});
