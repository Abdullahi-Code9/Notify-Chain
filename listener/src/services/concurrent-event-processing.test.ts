/**
 * Concurrent blockchain event processing.
 *
 * Verifies that when the same events are processed concurrently — by many
 * async tasks in one process, by overlapping poll cycles, and by two listener
 * instances with separate connections to the same SQLite file:
 *   - events are processed without data races (no lost updates, no errors),
 *   - duplicate processing is prevented (exactly one notification per event),
 *   - database state remains consistent (one row per event, final outcome
 *     preserved, nothing left stuck in PROCESSING).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as StellarSDK from '@stellar/stellar-sdk';
import { Database } from '../database/database';
import { EventDeduplicationService } from './event-deduplication-service';
import { EventSubscriber } from './event-subscriber';
import { Config, ContractConfig } from '../types';

// ── Module mocks (same pattern as event-subscriber-backfill.test.ts) ────────

const mockGetEvents = jest.fn();
const mockSendEventNotification = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('../__mocks__/@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getEvents: mockGetEvents,
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1_000 }),
      })),
    },
  };
});

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('./discord-notification', () => ({
  DiscordNotificationService: jest.fn().mockImplementation(() => ({
    sendEventNotification: mockSendEventNotification,
  })),
}));

jest.mock('../store/preference-store', () => ({
  preferenceStore: { isCategoryEnabled: jest.fn().mockReturnValue(true) },
}));

jest.mock('../utils/event-utils', () => ({
  validateEventPayload: jest.fn().mockReturnValue({ valid: true }),
  validateRpcResponse: jest.fn().mockReturnValue({ valid: true }),
  getEventName: jest.fn().mockReturnValue('TaskCreated'),
  matchesEventFilter: jest.fn().mockReturnValue(true),
}));

jest.mock('../store/event-registry', () => ({
  eventRegistry: {
    addFromInput: jest.fn().mockImplementation((input: { eventId: string }) => ({
      ...input,
      contractAddress: 'CCONTRACT',
    })),
    count: jest.fn().mockReturnValue(0),
  },
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const CONTRACT = 'CCONCURRENCYTESTCONTRACT';
const contractConfig: ContractConfig = { address: CONTRACT, name: 'Concurrency' } as ContractConfig;

function makeConfig(): Config {
  return {
    stellarNetwork: 'testnet',
    stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
    stellarRpcUrl: 'https://soroban-testnet.stellar.org:443',
    contractAddresses: [contractConfig],
    pollIntervalMs: 30_000,
    maxReconnectAttempts: 5,
    reconnectDelayMs: 100,
    eventsApiPort: 8787,
    eventsApiCorsOrigin: 'http://localhost:5173',
    eventBatchSize: 100,
    discord: { webhookUrl: 'https://discord.test/hook', webhookId: 'hook' },
  } as Config;
}

function makeEvent(i: number): StellarSDK.rpc.Api.EventResponse {
  return {
    id: `evt-${i}`,
    type: 'contract',
    ledger: 5_000 + i,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: `tx-${i}`,
    topic: [] as any,
    value: {} as any,
  } as StellarSDK.rpc.Api.EventResponse;
}

/** Small random delay so concurrent tasks genuinely interleave. */
const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)));

interface ProcessedRow {
  event_id: string;
  status: string;
  notification_sent: number;
  reorg_detection_count: number;
}

async function newDatabase(dbPath: string): Promise<Database> {
  const db = new Database(dbPath);
  await db.initialize();
  return db;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('concurrent event processing', () => {
  let dbPath: string;
  let dbA: Database;
  let dbB: Database;

  beforeEach(async () => {
    jest.clearAllMocks();
    dbPath = path.join(os.tmpdir(), `notify-concurrency-${process.pid}-${Date.now()}-${Math.random()}.db`);
    dbA = await newDatabase(dbPath);
    // Second, independent connection to the same file = a second listener instance.
    dbB = await newDatabase(dbPath);
  });

  afterEach(async () => {
    await dbA.close();
    await dbB.close();
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    }
  });

  describe('EventDeduplicationService.claimEvent', () => {
    it('grants exactly one claim when 50 tasks race for the same event', async () => {
      const service = new EventDeduplicationService(dbA);

      const results = await Promise.all(
        Array.from({ length: 50 }, async () => {
          await jitter();
          return service.claimEvent('evt-1', CONTRACT, 100, 'tx-1', 'contract');
        }),
      );

      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      const rows = await dbA.all('SELECT * FROM processed_events');
      expect(rows).toHaveLength(1);
    });

    it('grants exactly one claim across two listener instances (separate connections)', async () => {
      const instanceA = new EventDeduplicationService(dbA);
      const instanceB = new EventDeduplicationService(dbB);

      const results = await Promise.all(
        Array.from({ length: 40 }, async (_, i) => {
          await jitter();
          const svc = i % 2 === 0 ? instanceA : instanceB;
          return svc.claimEvent('evt-shared', CONTRACT, 100, 'tx', 'contract');
        }),
      );

      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      const rows = await dbA.all('SELECT * FROM processed_events');
      expect(rows).toHaveLength(1);
    });

    it('claims every distinct event exactly once under concurrency', async () => {
      const service = new EventDeduplicationService(dbA);
      const ids = Array.from({ length: 100 }, (_, i) => `evt-${i}`);

      // Each event is claimed 3 times concurrently.
      const results = await Promise.all(
        [...ids, ...ids, ...ids].map(async (id) => {
          await jitter();
          return { id, ...(await service.claimEvent(id, CONTRACT, 100, 'tx', 'contract')) };
        }),
      );

      const winners = results.filter((r) => r.claimed).map((r) => r.id);
      expect(winners.sort()).toEqual([...ids].sort());
      const count = await dbA.get<{ n: number }>('SELECT COUNT(*) AS n FROM processed_events');
      expect(count?.n).toBe(100);
    });

    it('does not let redetections overwrite the final outcome of a completed event', async () => {
      const service = new EventDeduplicationService(dbA);
      expect((await service.claimEvent('evt-1', CONTRACT, 100, 'tx', 'contract')).claimed).toBe(true);
      await service.completeEvent('evt-1', CONTRACT, 100, 'tx', 'contract', true, 'PROCESSED');

      await Promise.all(
        Array.from({ length: 20 }, async () => {
          await jitter();
          const claim = await service.claimEvent('evt-1', CONTRACT, 100, 'tx', 'contract');
          expect(claim.claimed).toBe(false);
          await service.recordRedetection('evt-1', CONTRACT, 100);
        }),
      );

      const row = await dbA.get<ProcessedRow>('SELECT * FROM processed_events WHERE event_id = ?', ['evt-1']);
      expect(row?.status).toBe('PROCESSED');
      expect(row?.notification_sent).toBe(1);
      expect(row?.reorg_detection_count).toBe(20); // no lost increments
    });

    it('does not count in-flight duplicates as reorg redetections', async () => {
      const service = new EventDeduplicationService(dbA);
      await service.claimEvent('evt-1', CONTRACT, 100, 'tx', 'contract');
      await service.recordRedetection('evt-1', CONTRACT, 100);

      const row = await dbA.get<ProcessedRow>('SELECT * FROM processed_events WHERE event_id = ?', ['evt-1']);
      expect(row?.status).toBe('PROCESSING');
      expect(row?.reorg_detection_count).toBe(0);
    });

    it('lets exactly one worker take over a claim abandoned past its lease', async () => {
      // Short 1s lease so the test can outlive it (CURRENT_TIMESTAMP has 1s resolution).
      const crashed = new EventDeduplicationService(dbA, { claimLeaseSeconds: 1 });
      expect((await crashed.claimEvent('evt-1', CONTRACT, 100, 'tx', 'contract')).claimed).toBe(true);
      // ... worker crashes here, never calls completeEvent ...
      await new Promise((r) => setTimeout(r, 2_100));

      const recovery = new EventDeduplicationService(dbB, { claimLeaseSeconds: 1 });
      const results = await Promise.all(
        Array.from({ length: 10 }, () => recovery.claimEvent('evt-1', CONTRACT, 100, 'tx', 'contract')),
      );
      expect(results.filter((r) => r.claimed)).toHaveLength(1);
    });

    it('honours an active claim within its lease', async () => {
      const service = new EventDeduplicationService(dbA); // default 300s lease
      await service.claimEvent('evt-1', CONTRACT, 100, 'tx', 'contract');
      const second = await service.claimEvent('evt-1', CONTRACT, 100, 'tx', 'contract');
      expect(second.claimed).toBe(false);
    });
  });

  describe('atomic counters (no lost updates)', () => {
    it('recordProcessedEvent: concurrent writers produce one row and an exact count', async () => {
      const a = new EventDeduplicationService(dbA);
      const b = new EventDeduplicationService(dbB);
      const writers = 30;

      await Promise.all(
        Array.from({ length: writers }, async (_, i) => {
          await jitter();
          await (i % 2 ? a : b).recordProcessedEvent('evt-1', CONTRACT, 100, 'tx', 'contract');
        }),
      );

      const rows = await dbA.all<ProcessedRow>('SELECT * FROM processed_events');
      expect(rows).toHaveLength(1);
      expect(rows[0].reorg_detection_count).toBe(writers - 1);
    });

    it('updatePollingCursor: concurrent reorg updates are all counted', async () => {
      const a = new EventDeduplicationService(dbA);
      const b = new EventDeduplicationService(dbB);
      const writers = 30;

      await Promise.all(
        Array.from({ length: writers }, async (_, i) => {
          await jitter();
          await (i % 2 ? a : b).updatePollingCursor(CONTRACT, `cursor-${i}`, 100 + i, true);
        }),
      );

      const rows = await dbA.all<{ reorg_detection_count: number }>('SELECT * FROM polling_cursors');
      expect(rows).toHaveLength(1);
      // First write inserts with count 0, every later write increments by 1.
      expect(rows[0].reorg_detection_count).toBe(writers - 1);
    });
  });

  describe('EventSubscriber end to end', () => {
    const EVENT_COUNT = 25;
    const events = Array.from({ length: EVENT_COUNT }, (_, i) => makeEvent(i));

    beforeEach(() => {
      mockGetEvents.mockResolvedValue({ events, cursor: 'cursor-1' });
      mockSendEventNotification.mockImplementation(async () => {
        await jitter();
        return true;
      });
    });

    async function assertConsistentState(): Promise<void> {
      // Exactly one notification per event.
      const sentIds = mockSendEventNotification.mock.calls.map((c) => c[0].id);
      expect(sentIds).toHaveLength(EVENT_COUNT);
      expect(new Set(sentIds).size).toBe(EVENT_COUNT);

      // One row per event, all finalised, none stuck in PROCESSING.
      const rows = await dbA.all<ProcessedRow>('SELECT * FROM processed_events ORDER BY event_id');
      expect(rows).toHaveLength(EVENT_COUNT);
      for (const row of rows) {
        expect(row.status).toBe('PROCESSED');
        expect(row.notification_sent).toBe(1);
      }
    }

    it('two listener instances polling the same events notify each event exactly once', async () => {
      const instanceA = new EventSubscriber(makeConfig(), new EventDeduplicationService(dbA));
      const instanceB = new EventSubscriber(makeConfig(), new EventDeduplicationService(dbB));

      await Promise.all([
        (instanceA as any).checkForEvents(),
        (instanceB as any).checkForEvents(),
      ]);

      await assertConsistentState();
    });

    it('overlapping poll cycles in one instance notify each event exactly once', async () => {
      const subscriber = new EventSubscriber(makeConfig(), new EventDeduplicationService(dbA));

      await Promise.all(Array.from({ length: 4 }, () => (subscriber as any).checkForEvents()));

      await assertConsistentState();
    });

    it('re-polling already-processed events sends nothing and keeps outcomes intact', async () => {
      const subscriber = new EventSubscriber(makeConfig(), new EventDeduplicationService(dbA));
      await (subscriber as any).checkForEvents();
      await assertConsistentState();

      mockSendEventNotification.mockClear();
      await Promise.all([
        (subscriber as any).checkForEvents(),
        (subscriber as any).checkForEvents(),
      ]);

      expect(mockSendEventNotification).not.toHaveBeenCalled();
      const rows = await dbA.all<ProcessedRow>('SELECT * FROM processed_events');
      expect(rows).toHaveLength(EVENT_COUNT);
      for (const row of rows) {
        expect(row.status).toBe('PROCESSED'); // not overwritten with SKIPPED
        expect(row.notification_sent).toBe(1);
        expect(row.reorg_detection_count).toBe(2);
      }
    });
  });
});
