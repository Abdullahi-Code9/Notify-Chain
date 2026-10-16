/**
 * Event processing checkpoint tests (#783)
 *
 * Verifies that:
 *  - Checkpoints are stored (polling_cursors) after successful event processing.
 *  - Restarting the subscriber restores the persisted cursor into lastCursors
 *    so the first poll resumes from that position rather than ledger 1.
 *  - Checkpoints are only advanced when processing succeeds.
 *  - Recovery behaviour: a subscriber with no prior checkpoint starts from
 *    the beginning; one with a checkpoint resumes correctly.
 *
 * Uses an in-memory SQLite database (no file system state required) and a
 * real EventDeduplicationService so the full persistence path is exercised.
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { EventSubscriber } from './event-subscriber';
import { EventDeduplicationService } from './event-deduplication-service';
import { Database } from '../database/database';
import { Config, ContractConfig } from '../types';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('./discord-notification', () => ({
  DiscordNotificationService: jest.fn().mockImplementation(() => ({
    sendEventNotification: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock('../store/preference-store', () => ({
  preferenceStore: {
    isCategoryEnabled: jest.fn().mockReturnValue(true),
  },
}));

jest.mock('./polling-metrics', () => ({
  pollingMetrics: { record: jest.fn() },
}));

const mockGetEvents = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getEvents: mockGetEvents,
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 50_000 }),
      })),
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTRACT_ADDRESS = 'CCEMX6Q5V5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5';

const contractConfig: ContractConfig = {
  address: CONTRACT_ADDRESS,
  events: ['*'],
};

const testConfig: Config = {
  stellarNetwork: 'testnet',
  stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
  stellarRpcUrl: 'https://soroban-testnet.stellar.org:443',
  contractAddresses: [contractConfig],
  pollIntervalMs: 30000,
  eventBatchSize: 100,
  maxReconnectAttempts: 5,
  reconnectDelayMs: 100,
  eventsApiPort: 8787,
  eventsApiCorsOrigin: 'http://localhost:5173',
};

function makeEvent(
  id: string,
  ledger: number,
  overrides: Partial<StellarSDK.rpc.Api.EventResponse> = {}
): StellarSDK.rpc.Api.EventResponse {
  return {
    id,
    type: 'contract',
    ledger,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: `tx-${id}`,
    // Use plain arrays/objects — we never decode these in checkpoint tests
    // and xdr is only available after jest.mock runs, not at module scope.
    topic: [] as any,
    value: {} as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

async function setupDb(): Promise<{ db: Database; dedup: EventDeduplicationService }> {
  const db = new Database(':memory:');
  await db.initialize();
  const dedup = new EventDeduplicationService(db);
  return { db, dedup };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventSubscriber — checkpoint persistence', () => {
  let db: Database;
  let dedup: EventDeduplicationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({ db, dedup } = await setupDb());
    // Default: no events, empty cursor
    mockGetEvents.mockResolvedValue({ events: [], cursor: undefined });
  });

  afterEach(async () => {
    await db.close();
  });

  it('persists the cursor to polling_cursors after a successful poll with events', async () => {
    mockGetEvents.mockResolvedValue({
      events: [makeEvent('E1', 1000)],
      cursor: 'cursor-after-1000',
    });

    const subscriber = new EventSubscriber(testConfig, dedup);
    await (subscriber as any).checkForEvents();

    const record = await dedup.getLastCursor(CONTRACT_ADDRESS);
    expect(record).not.toBeNull();
    expect(record!.cursor).toBe('cursor-after-1000');
    expect(record!.ledgerNumber).toBe(1000);
  });

  it('advances the checkpoint ledger after each successful poll', async () => {
    mockGetEvents
      .mockResolvedValueOnce({
        events: [makeEvent('E1', 1000)],
        cursor: 'cursor-1000',
      })
      .mockResolvedValueOnce({
        events: [makeEvent('E2', 2000)],
        cursor: 'cursor-2000',
      });

    const subscriber = new EventSubscriber(testConfig, dedup);
    await (subscriber as any).checkForEvents();

    let record = await dedup.getLastCursor(CONTRACT_ADDRESS);
    expect(record!.cursor).toBe('cursor-1000');
    expect(record!.ledgerNumber).toBe(1000);

    await (subscriber as any).checkForEvents();

    record = await dedup.getLastCursor(CONTRACT_ADDRESS);
    expect(record!.cursor).toBe('cursor-2000');
    expect(record!.ledgerNumber).toBe(2000);
  });

  it('does not create a polling_cursors row when the RPC returns no cursor', async () => {
    mockGetEvents.mockResolvedValue({
      events: [makeEvent('E1', 1000)],
      cursor: undefined,
    });

    const subscriber = new EventSubscriber(testConfig, dedup);
    await (subscriber as any).checkForEvents();

    const record = await dedup.getLastCursor(CONTRACT_ADDRESS);
    expect(record).toBeNull();
  });

  it('does not advance the checkpoint when the RPC call throws', async () => {
    // First poll succeeds and writes a checkpoint
    mockGetEvents.mockResolvedValueOnce({
      events: [makeEvent('E1', 1000)],
      cursor: 'cursor-1000',
    });

    const subscriber = new EventSubscriber(testConfig, dedup);
    await (subscriber as any).checkForEvents();

    // Second poll fails — checkpoint must not move
    mockGetEvents.mockRejectedValueOnce(new Error('RPC timeout'));

    await expect((subscriber as any).checkForEvents()).rejects.toThrow(
      'Failed to fetch events for all'
    );

    const record = await dedup.getLastCursor(CONTRACT_ADDRESS);
    expect(record!.cursor).toBe('cursor-1000');
    expect(record!.ledgerNumber).toBe(1000);
  });

  it('persists checkpoints for each contract independently', async () => {
    const contract2: ContractConfig = {
      address: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      events: ['*'],
    };
    const multiConfig: Config = {
      ...testConfig,
      contractAddresses: [contractConfig, contract2],
    };

    mockGetEvents
      .mockResolvedValueOnce({ events: [makeEvent('E1', 500)], cursor: 'cursor-C1' })
      .mockResolvedValueOnce({ events: [makeEvent('E2', 800)], cursor: 'cursor-C2' });

    const subscriber = new EventSubscriber(multiConfig, dedup);
    await (subscriber as any).checkForEvents();

    const r1 = await dedup.getLastCursor(CONTRACT_ADDRESS);
    const r2 = await dedup.getLastCursor(contract2.address);

    expect(r1!.cursor).toBe('cursor-C1');
    expect(r1!.ledgerNumber).toBe(500);
    expect(r2!.cursor).toBe('cursor-C2');
    expect(r2!.ledgerNumber).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint restoration at startup
// ---------------------------------------------------------------------------

describe('EventSubscriber — checkpoint restoration at startup', () => {
  let db: Database;
  let dedup: EventDeduplicationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({ db, dedup } = await setupDb());
    mockGetEvents.mockResolvedValue({ events: [], cursor: undefined });
  });

  afterEach(async () => {
    await db.close();
  });

  it('restores a persisted cursor into lastCursors before the first poll', async () => {
    // Seed polling_cursors as if a previous run had reached ledger 5000
    await dedup.updatePollingCursor(CONTRACT_ADDRESS, 'cursor-from-prev-run', 5000);

    const subscriber = new EventSubscriber(testConfig, dedup);
    await (subscriber as any).restoreCheckpoints();

    // The in-memory map must now hold the persisted cursor
    const lastCursors: Map<string, string> = (subscriber as any).lastCursors;
    expect(lastCursors.get(CONTRACT_ADDRESS)).toBe('cursor-from-prev-run');
  });

  it('uses the restored cursor in the first RPC call after start()', async () => {
    await dedup.updatePollingCursor(CONTRACT_ADDRESS, 'checkpoint-cursor', 5000);

    // start() calls restoreCheckpoints() then poll() → checkForEvents() → getContractEvents()
    // poll() runs in the background so we yield after start() resolves
    let pollFired = false;
    mockGetEvents.mockImplementationOnce(async () => {
      pollFired = true;
      subscriber.stop();
      return { events: [], cursor: undefined };
    });

    const subscriber = new EventSubscriber(testConfig, dedup);
    await subscriber.start();

    await new Promise((r) => setTimeout(r, 10));

    expect(pollFired).toBe(true);
    expect(mockGetEvents).toHaveBeenCalledTimes(1);
    const firstCall = mockGetEvents.mock.calls[0][0] as StellarSDK.rpc.Api.GetEventsRequest;
    expect((firstCall as any).cursor).toBe('checkpoint-cursor');
    expect((firstCall as any).startLedger).toBeUndefined();
  });

  it('starts from the beginning when no checkpoint exists for a contract', async () => {
    // No row in polling_cursors

    let pollFired = false;
    mockGetEvents.mockImplementationOnce(async () => {
      pollFired = true;
      subscriber.stop();
      return { events: [], cursor: undefined };
    });

    const subscriber = new EventSubscriber(testConfig, dedup);
    await subscriber.start();

    // Yield the event loop so the background poll() iteration can run
    await new Promise((r) => setTimeout(r, 10));

    expect(pollFired).toBe(true);
    const firstCall = mockGetEvents.mock.calls[0][0] as StellarSDK.rpc.Api.GetEventsRequest;
    expect((firstCall as any).cursor).toBeUndefined();
    expect((firstCall as any).startLedger).toBeDefined();
  });

  it('restores checkpoints for multiple contracts independently', async () => {
    const contract2: ContractConfig = {
      address: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      events: ['*'],
    };
    const multiConfig: Config = {
      ...testConfig,
      contractAddresses: [contractConfig, contract2],
    };

    await dedup.updatePollingCursor(CONTRACT_ADDRESS, 'cursor-C1', 1000);
    await dedup.updatePollingCursor(contract2.address, 'cursor-C2', 2000);

    const subscriber = new EventSubscriber(multiConfig, dedup);
    await (subscriber as any).restoreCheckpoints();

    const lastCursors: Map<string, string> = (subscriber as any).lastCursors;
    expect(lastCursors.get(CONTRACT_ADDRESS)).toBe('cursor-C1');
    expect(lastCursors.get(contract2.address)).toBe('cursor-C2');
  });

  it('restores a checkpoint for one contract but not for another that has none', async () => {
    const contract2: ContractConfig = {
      address: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      events: ['*'],
    };
    const multiConfig: Config = {
      ...testConfig,
      contractAddresses: [contractConfig, contract2],
    };

    // Only C1 has a persisted cursor
    await dedup.updatePollingCursor(CONTRACT_ADDRESS, 'cursor-C1', 1000);

    const subscriber = new EventSubscriber(multiConfig, dedup);
    await (subscriber as any).restoreCheckpoints();

    const lastCursors: Map<string, string> = (subscriber as any).lastCursors;
    expect(lastCursors.get(CONTRACT_ADDRESS)).toBe('cursor-C1');
    expect(lastCursors.has(contract2.address)).toBe(false);
  });

  it('is a no-op and does not throw when deduplicationService is null', async () => {
    // No deduplication service — should complete silently
    const subscriber = new EventSubscriber(testConfig, undefined);
    await expect((subscriber as any).restoreCheckpoints()).resolves.toBeUndefined();

    const lastCursors: Map<string, string> = (subscriber as any).lastCursors;
    expect(lastCursors.size).toBe(0);
  });

  it('logs each restored checkpoint at info level', async () => {
    const mockLogger = logger as jest.Mocked<typeof logger>;
    await dedup.updatePollingCursor(CONTRACT_ADDRESS, 'cursor-logged', 7777);

    const subscriber = new EventSubscriber(testConfig, dedup);
    await (subscriber as any).restoreCheckpoints();

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Checkpoint restored',
      expect.objectContaining({
        contractAddress: CONTRACT_ADDRESS,
        cursor: 'cursor-logged',
        ledgerNumber: 7777,
      })
    );
  });

  it('logs the restoration summary with counts', async () => {
    const mockLogger = logger as jest.Mocked<typeof logger>;
    await dedup.updatePollingCursor(CONTRACT_ADDRESS, 'cursor-summary', 1000);

    const subscriber = new EventSubscriber(testConfig, dedup);
    await (subscriber as any).restoreCheckpoints();

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Checkpoint restore complete',
      expect.objectContaining({
        contractsConfigured: 1,
        contractsRestored: 1,
      })
    );
  });

  it('continues restoring remaining contracts when one getLastCursor call throws', async () => {
    const mockLogger = logger as jest.Mocked<typeof logger>;
    const contract2: ContractConfig = {
      address: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      events: ['*'],
    };
    const multiConfig: Config = {
      ...testConfig,
      contractAddresses: [contractConfig, contract2],
    };

    // C1 throws, C2 has a valid cursor
    await dedup.updatePollingCursor(contract2.address, 'cursor-C2', 2000);
    jest.spyOn(dedup, 'getLastCursor').mockImplementationOnce(() => {
      throw new Error('DB read failure');
    });

    const subscriber = new EventSubscriber(multiConfig, dedup);
    await expect((subscriber as any).restoreCheckpoints()).resolves.toBeUndefined();

    // C1 failure logged as a warning
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to restore checkpoint for contract; starting from beginning',
      expect.objectContaining({ contractAddress: CONTRACT_ADDRESS })
    );

    // C2 still restored despite C1 failure
    const lastCursors: Map<string, string> = (subscriber as any).lastCursors;
    expect(lastCursors.get(contract2.address)).toBe('cursor-C2');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: write then resume
// ---------------------------------------------------------------------------

describe('EventSubscriber — write checkpoint then resume from it', () => {
  let db: Database;
  let dedup: EventDeduplicationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    ({ db, dedup } = await setupDb());
    mockGetEvents.mockResolvedValue({ events: [], cursor: undefined });
  });

  afterEach(async () => {
    await db.close();
  });

  it('resumes from the last checkpoint after a simulated restart', async () => {
    // --- First "run" ---
    mockGetEvents.mockResolvedValue({
      events: [makeEvent('E1', 3000), makeEvent('E2', 3001)],
      cursor: 'cursor-at-3001',
    });

    const firstSubscriber = new EventSubscriber(testConfig, dedup);
    await (firstSubscriber as any).checkForEvents();

    // Checkpoint must be persisted
    const savedRecord = await dedup.getLastCursor(CONTRACT_ADDRESS);
    expect(savedRecord!.cursor).toBe('cursor-at-3001');
    expect(savedRecord!.ledgerNumber).toBe(3001);

    // --- Simulate restart: new subscriber instance, same DB ---
    jest.clearAllMocks();
    mockGetEvents.mockResolvedValue({ events: [], cursor: undefined });

    const secondSubscriber = new EventSubscriber(testConfig, dedup);

    // Before restoreCheckpoints the map is empty
    expect((secondSubscriber as any).lastCursors.size).toBe(0);

    await (secondSubscriber as any).restoreCheckpoints();

    // After restore it holds the persisted cursor
    expect((secondSubscriber as any).lastCursors.get(CONTRACT_ADDRESS)).toBe('cursor-at-3001');

    // The first poll after restore must use the restored cursor
    await (secondSubscriber as any).checkForEvents();

    const rpcRequest = mockGetEvents.mock.calls[0][0] as StellarSDK.rpc.Api.GetEventsRequest;
    expect((rpcRequest as any).cursor).toBe('cursor-at-3001');
    expect((rpcRequest as any).startLedger).toBeUndefined();
  });

  it('checkpoint is only advanced on success — failed polls leave it at the last good position', async () => {
    // Successful poll writes checkpoint at ledger 4000
    mockGetEvents.mockResolvedValueOnce({
      events: [makeEvent('E1', 4000)],
      cursor: 'cursor-4000',
    });

    const subscriber = new EventSubscriber(testConfig, dedup);
    await (subscriber as any).checkForEvents();

    expect((await dedup.getLastCursor(CONTRACT_ADDRESS))!.cursor).toBe('cursor-4000');

    // Failed poll — checkpoint must stay at 4000
    mockGetEvents.mockRejectedValueOnce(new Error('network error'));

    await expect((subscriber as any).checkForEvents()).rejects.toThrow();

    const record = await dedup.getLastCursor(CONTRACT_ADDRESS);
    expect(record!.cursor).toBe('cursor-4000');
    expect(record!.ledgerNumber).toBe(4000);

    // Third poll succeeds — checkpoint advances
    mockGetEvents.mockResolvedValueOnce({
      events: [makeEvent('E2', 5000)],
      cursor: 'cursor-5000',
    });

    await (subscriber as any).checkForEvents();

    const finalRecord = await dedup.getLastCursor(CONTRACT_ADDRESS);
    expect(finalRecord!.cursor).toBe('cursor-5000');
    expect(finalRecord!.ledgerNumber).toBe(5000);
  });
});
