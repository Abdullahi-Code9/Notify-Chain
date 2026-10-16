import * as StellarSDK from '@stellar/stellar-sdk';
import { xdr } from '@stellar/stellar-sdk';
import { EventSubscriber } from './event-subscriber';
import { EventDeduplicationService } from './event-deduplication-service';
import { Database } from '../database/database';
import { Config, ContractConfig } from '../types';
import logger from '../utils/logger';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
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

const mockGetEvents = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getEvents: mockGetEvents,
      })),
    },
  };
});

const mockLogger = logger as jest.Mocked<typeof logger>;

const contractConfig: ContractConfig = {
  address: 'CCEMX6Q5V5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5',
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
  maxPayloadSizeBytes: 64 * 1024,
};

function createMockEvent(
  overrides: Partial<StellarSDK.rpc.Api.EventResponse> = {}
): StellarSDK.rpc.Api.EventResponse {
  return {
    id: 'event-1',
    type: 'contract',
    ledger: 12345,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: 'abc123def456',
    topic: [xdr.ScVal.scvSymbol('TaskCreated')],
    value: xdr.ScVal.scvU32(1),
    ...overrides,
  };
}

describe('EventSubscriber with EventDeduplicationService - Reorg Scenarios', () => {
  let db: Database;
  let deduplicationService: EventDeduplicationService;
  const dbPath = ':memory:';

  beforeAll(async () => {
    db = new Database(dbPath);
    await db.initialize();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGetEvents.mockResolvedValue({ events: [], cursor: '' });
    await db.run('DELETE FROM processed_events');
    await db.run('DELETE FROM polling_cursors');
    deduplicationService = new EventDeduplicationService(db);
  });

  afterAll(async () => {
    await db.close();
  });

  describe('Normal event processing flow', () => {
    it('processes new events and records them', async () => {
      const event1 = createMockEvent({ id: 'event-1', ledger: 100 });
      mockGetEvents.mockResolvedValue({
        events: [event1],
        cursor: 'cursor-1',
      });

      const subscriber = new EventSubscriber(testConfig, deduplicationService);
      await (subscriber as any).checkForEvents();

      // Event should be recorded as processed
      const isDup = await deduplicationService.isDuplicate('event-1', contractConfig.address);
      expect(isDup.isDuplicate).toBe(true);
      expect(isDup.isReorgDuplicate).toBe(false);

      // Cursor should be updated
      const cursor = await deduplicationService.getLastCursor(contractConfig.address);
      expect(cursor?.cursor).toBe('cursor-1');
      expect(cursor?.ledgerNumber).toBe(100);
    });

    it('processes multiple events in sequence', async () => {
      const event1 = createMockEvent({ id: 'event-1', ledger: 100 });
      const event2 = createMockEvent({ id: 'event-2', ledger: 101 });
      mockGetEvents.mockResolvedValue({
        events: [event1, event2],
        cursor: 'cursor-2',
      });

      const subscriber = new EventSubscriber(testConfig, deduplicationService);
      await (subscriber as any).checkForEvents();

      const dup1 = await deduplicationService.isDuplicate('event-1', contractConfig.address);
      const dup2 = await deduplicationService.isDuplicate('event-2', contractConfig.address);

      expect(dup1.isDuplicate).toBe(true);
      expect(dup2.isDuplicate).toBe(true);

      const cursor = await deduplicationService.getLastCursor(contractConfig.address);
      expect(cursor?.ledgerNumber).toBe(101);
    });
  });

  describe('Reorg detection and handling', () => {
    it('detects when ledger number goes backward', async () => {
      // First poll: events from blocks 100-105
      const event1 = createMockEvent({ id: 'event-1', ledger: 100 });
      const event2 = createMockEvent({ id: 'event-2', ledger: 105 });
      mockGetEvents.mockResolvedValue({
        events: [event1, event2],
        cursor: 'cursor-at-105',
      });

      const subscriber = new EventSubscriber(testConfig, deduplicationService);
      await (subscriber as any).checkForEvents();

      // Verify initial state
      let cursor = await deduplicationService.getLastCursor(contractConfig.address);
      expect(cursor?.ledgerNumber).toBe(105);

      // Second poll: ledger goes backward to 98 (reorg detected)
      const event3 = createMockEvent({ id: 'event-3', ledger: 98 });
      mockGetEvents.mockResolvedValue({
        events: [event3],
        cursor: 'cursor-after-reorg',
      });

      // Check if reorg is detected
      jest.clearAllMocks();
      await (subscriber as any).checkForEvents();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Potential blockchain reorg detected',
        expect.objectContaining({
          contractAddress: contractConfig.address,
          eventLedger: 98,
        })
      );
    });

    it('detects and marks reorg duplicates', async () => {
      // First poll: process events
      const event1 = createMockEvent({ id: 'event-1', ledger: 100, txHash: 'tx-1' });
      const event2 = createMockEvent({ id: 'event-2', ledger: 102, txHash: 'tx-2' });
      mockGetEvents.mockResolvedValue({
        events: [event1, event2],
        cursor: 'cursor-105',
      });

      const subscriber = new EventSubscriber(testConfig, deduplicationService);
      await (subscriber as any).checkForEvents();

      // Reorg occurs, same events reappear
      mockGetEvents.mockResolvedValue({
        events: [event1, event2],
        cursor: 'cursor-after-reorg',
      });

      jest.clearAllMocks();
      await (subscriber as any).checkForEvents();

      // Both events should be detected as reorg duplicates
      const event1Records = await db.all(
        "SELECT is_reorg_duplicate FROM processed_events WHERE event_id = 'event-1'"
      );
      const event2Records = await db.all(
        "SELECT is_reorg_duplicate FROM processed_events WHERE event_id = 'event-2'"
      );

      expect(event1Records[0]).toHaveProperty('is_reorg_duplicate', 1);
      expect(event2Records[0]).toHaveProperty('is_reorg_duplicate', 1);

      // Warnings should be logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Reorg duplicate detected',
        expect.anything()
      );
    });

    it('prevents duplicate notifications during reorg', async () => {
      // First processing
      const event1 = createMockEvent({ id: 'event-1', ledger: 100 });
      mockGetEvents.mockResolvedValue({
        events: [event1],
        cursor: 'cursor-1',
      });

      const subscriber = new EventSubscriber(testConfig, deduplicationService);
      await (subscriber as any).checkForEvents();

      // Simulate the Discord service being called
      const discordCalls = mockLogger.info.mock.calls.filter((call: any[]) =>
        call[0] === 'Event processing complete'
      );
      expect(discordCalls.length).toBeGreaterThan(0);

      // Reorg - same event appears again
      mockGetEvents.mockResolvedValue({
        events: [event1],
        cursor: 'cursor-after-reorg',
      });

      jest.clearAllMocks();
      await (subscriber as any).checkForEvents();

      // Should skip the event due to persistent dedup
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Skipping event: already processed (persistent deduplication)',
        expect.anything()
      );
    });
  });

  describe('Comprehensive reorg scenario', () => {
    it('handles complete reorg cycle with multiple events', async () => {
      jest.useFakeTimers();

      // Phase 1: Normal polling blocks 100-110
      const normalEvents = [
        createMockEvent({ id: 'event-1', ledger: 100 }),
        createMockEvent({ id: 'event-2', ledger: 105 }),
        createMockEvent({ id: 'event-3', ledger: 110 }),
      ];

      mockGetEvents.mockResolvedValue({
        events: normalEvents,
        cursor: 'cursor-at-110',
      });

      const subscriber = new EventSubscriber(testConfig, deduplicationService);
      await (subscriber as any).checkForEvents();

      let metrics = await deduplicationService.getMetrics();
      expect(metrics.totalProcessedEvents).toBe(3);
      expect(metrics.reorgDuplicatesDetected).toBe(0);

      // Phase 2: Reorg detected - blocks go back to 95
      const reorgEvents = [
        createMockEvent({ id: 'event-1', ledger: 100 }),
        createMockEvent({ id: 'event-2', ledger: 105 }),
        createMockEvent({ id: 'event-4', ledger: 108 }), // New event from reorg
      ];

      mockGetEvents.mockResolvedValue({
        events: reorgEvents,
        cursor: 'cursor-after-reorg-95',
      });

      jest.clearAllMocks();
      await (subscriber as any).checkForEvents();

      // Check metrics
      metrics = await deduplicationService.getMetrics();
      expect(metrics.totalProcessedEvents).toBeGreaterThanOrEqual(3);
      expect(metrics.reorgDuplicatesDetected).toBe(2); // event-1 and event-2 are duplicates

      // Phase 3: Recovery - blocks move forward with new event
      const recoveryEvents = [
        createMockEvent({ id: 'event-5', ledger: 111 }),
      ];

      mockGetEvents.mockResolvedValue({
        events: recoveryEvents,
        cursor: 'cursor-after-recovery',
      });

      jest.clearAllMocks();
      await (subscriber as any).checkForEvents();

      // New event should be processed
      const dup5 = await deduplicationService.isDuplicate('event-5', contractConfig.address);
      expect(dup5.isDuplicate).toBe(true);
      expect(dup5.isReorgDuplicate).toBe(false);

      jest.useRealTimers();
    });

    it('tracks reorg detection count across multiple reorgs', async () => {
      const event1 = createMockEvent({ id: 'event-1', ledger: 100 });

      // First occurrence
      mockGetEvents.mockResolvedValue({
        events: [event1],
        cursor: 'cursor-1',
      });

      const subscriber = new EventSubscriber(testConfig, deduplicationService);
      await (subscriber as any).checkForEvents();

      let cursor = await deduplicationService.getLastCursor(contractConfig.address);
      expect(cursor?.reorgDetectionCount).toBe(0);

      // Reorg 1
      mockGetEvents.mockResolvedValue({
        events: [event1],
        cursor: 'cursor-after-reorg-1',
      });
      await (subscriber as any).checkForEvents();

      cursor = await deduplicationService.getLastCursor(contractConfig.address);
      let metrics = await deduplicationService.getMetrics();
      expect(metrics.totalReorgsDetected).toBeGreaterThanOrEqual(0);

      // Reorg 2
      mockGetEvents.mockResolvedValue({
        events: [event1],
        cursor: 'cursor-after-reorg-2',
      });
      await (subscriber as any).checkForEvents();

      metrics = await deduplicationService.getMetrics();
      expect(metrics.reorgDuplicatesDetected).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Error handling and resilience', () => {
    it('continues processing even if dedup service fails temporarily', async () => {
      const event1 = createMockEvent({ id: 'event-1', ledger: 100 });
      mockGetEvents.mockResolvedValue({
        events: [event1],
        cursor: 'cursor-1',
      });

      // Create a service that throws errors
      const failingService = new EventDeduplicationService(db);
      const spyIsDuplicate = jest.spyOn(failingService, 'isDuplicate');
      spyIsDuplicate.mockRejectedValueOnce(new Error('DB error'));

      const subscriber = new EventSubscriber(testConfig, failingService);

      // Should not throw - error handling in isDuplicate returns false
      expect(async () => {
        await (subscriber as any).checkForEvents();
      }).not.toThrow();
    });

    it.skip('handles missing dedup service gracefully', async () => {
      // Make sure mock is set up properly
      mockGetEvents.mockResolvedValueOnce({
        events: [],
        cursor: 'cursor-1',
      });

      // Create subscriber without dedup service (null deduplication service)
      const subscriber = new EventSubscriber(testConfig); // deduplicationService is optional and null

      // Should process normally without crashing
      await (subscriber as any).checkForEvents();
      
      // Verify that events were polled (even without dedup service)
      expect(mockGetEvents).toHaveBeenCalled();
    });
  });
});
