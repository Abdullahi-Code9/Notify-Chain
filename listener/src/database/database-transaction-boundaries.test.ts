/**
 * Transaction boundaries and event integrity constraints (#1121).
 */
import { Database } from './database';
import { EventDeduplicationService } from '../services/event-deduplication-service';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

async function count(db: Database, sql: string, params: unknown[] = []): Promise<number> {
  return (await db.get<{ n: number }>(sql, params))!.n;
}

async function insertEvent(db: Database, eventId: string, fingerprint = `fp-${eventId}`): Promise<void> {
  await db.run(
    `INSERT INTO processed_events (event_id, contract_address, fingerprint, ledger_number, event_type)
     VALUES (?, 'CA', ?, 1, 'contract')`,
    [eventId, fingerprint],
  );
}

describe('Database transaction boundaries (#1121)', () => {
  let db: Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  it('serialises concurrent transactions instead of failing on a nested BEGIN', async () => {
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        db.transaction(async () => {
          await insertEvent(db, id);
          await new Promise((r) => setTimeout(r, 5));
        }),
      ),
    );
    expect(await count(db, 'SELECT COUNT(*) AS n FROM processed_events')).toBe(3);
  });

  it('rolls back every write of a failed transaction', async () => {
    await expect(
      db.transaction(async () => {
        await insertEvent(db, 'a');
        await insertEvent(db, 'a', 'other-fp'); // violates UNIQUE (contract_address, event_id)
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM processed_events')).toBe(0);
  });

  it('turns nested transactions into savepoints that roll back independently', async () => {
    await db.transaction(async () => {
      await insertEvent(db, 'outer');
      await expect(
        db.transaction(async () => {
          await insertEvent(db, 'inner');
          throw new Error('inner failure');
        }),
      ).rejects.toThrow('inner failure');
    });
    const rows = await db.all<{ event_id: string }>('SELECT event_id FROM processed_events');
    expect(rows.map((r) => r.event_id)).toEqual(['outer']);
  });

  it('rolls back the whole unit when an inner failure is not handled', async () => {
    await expect(
      db.transaction(async () => {
        await insertEvent(db, 'outer');
        await db.transaction(async () => {
          throw new Error('inner failure');
        });
      }),
    ).rejects.toThrow('inner failure');
    expect(await count(db, 'SELECT COUNT(*) AS n FROM processed_events')).toBe(0);
  });

  it('returns the callback result', async () => {
    await expect(db.transaction(async () => 42)).resolves.toBe(42);
  });
});

describe('event integrity constraints (#1121)', () => {
  let db: Database;
  let service: EventDeduplicationService;

  beforeEach(async () => {
    db = new Database(':memory:');
    await db.initialize();
    service = new EventDeduplicationService(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('applies the processed_events unique index on bootstrap', async () => {
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'ux_processed_events_contract_event'",
      ),
    ).toBe(1);
  });

  it('rejects timings that reference a missing event', async () => {
    await expect(
      db.run("INSERT INTO event_processing_timings (processed_event_id, outcome) VALUES (999, 'processed')"),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('completeEvent upserts a single record per event', async () => {
    await service.completeEvent('e1', 'CA', 5, 'tx', 'contract', false, 'ERROR', 'failed');
    await service.completeEvent('e1', 'CA', 5, 'tx', 'contract', true, 'PROCESSED');
    const rows = await db.all<{ status: string; notification_sent: number; error_reason: string | null }>(
      'SELECT status, notification_sent, error_reason FROM processed_events',
    );
    expect(rows).toEqual([{ status: 'PROCESSED', notification_sent: 1, error_reason: null }]);
  });

  it('stores stage timings against the processed event and cascades on delete', async () => {
    expect(await service.recordStageTimings('e1', 'CA', { retrievalMs: 1, outcome: 'processed' })).toBe(false);

    await service.completeEvent('e1', 'CA', 5, 'tx', 'contract', true, 'PROCESSED');
    expect(
      await service.recordStageTimings('e1', 'CA', {
        retrievalMs: 1,
        decodeValidationMs: 2,
        persistenceMs: -5, // invalid → stored as missing
        totalMs: 3,
        outcome: 'processed',
      }),
    ).toBe(true);
    await service.recordStageTimings('e1', 'CA', { retrievalMs: 4, totalMs: 4, outcome: 'processed' });

    const timings = await service.getStageTimings('e1', 'CA');
    expect(timings).toMatchObject({ retrievalMs: 4, decodeValidationMs: null, persistenceMs: null, totalMs: 4 });
    expect(await count(db, 'SELECT COUNT(*) AS n FROM event_processing_timings')).toBe(1);

    await db.run('DELETE FROM processed_events');
    expect(await count(db, 'SELECT COUNT(*) AS n FROM event_processing_timings')).toBe(0);
    expect(await service.getStageTimings('e1', 'CA')).toBeNull();
  });
});
