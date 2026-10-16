/**
 * Tests for the historical backfill safety limit (#628).
 *
 * When the listener starts without a stored cursor it now applies a configurable
 * ledger cap so it does not attempt to replay an arbitrarily large history
 * range after downtime or a configuration change.
 */
import * as StellarSDK from '@stellar/stellar-sdk';
import { EventSubscriber } from './event-subscriber';
import { Config, ContractConfig, BackfillConfig } from '../types';
import logger from '../utils/logger';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockGetEvents = jest.fn();
const mockGetLatestLedger = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getEvents: mockGetEvents,
        getLatestLedger: mockGetLatestLedger,
      })),
    },
  };
});

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('./discord-notification', () => ({
  DiscordNotificationService: jest.fn().mockImplementation(() => ({
    sendEventNotification: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock('../store/preference-store', () => ({
  preferenceStore: { isCategoryEnabled: jest.fn().mockReturnValue(true) },
}));

// Stub out payload validation and event-name extraction so tests that pass
// plain-object events don't need real XDR values.
jest.mock('../utils/event-utils', () => ({
  validateRpcResponse: jest.fn().mockReturnValue({ valid: true }),
  validateEventPayload: jest.fn().mockReturnValue({ valid: true }),
  validateRpcResponse: jest.fn().mockReturnValue({ valid: true }),
  getEventName: jest.fn().mockReturnValue('TaskCreated'),
  matchesEventFilter: jest.fn().mockReturnValue(true),
}));

// Stub the event registry so processEvent doesn't try to format XDR topics.
jest.mock('../store/event-registry', () => ({
  eventRegistry: {
    addFromInput: jest.fn().mockReturnValue({
      eventId: 'event-1',
      contractAddress: 'CCEMX6Q5V5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5',
      eventName: 'TaskCreated',
      ledger: 12345,
      type: 'contract',
      topic: [],
      value: {},
      txHash: 'abc123',
    }),
    count: jest.fn().mockReturnValue(0),
  },
}));

const mockLogger = logger as jest.Mocked<typeof logger>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const contractConfig: ContractConfig = {
  address: 'CCEMX6Q5V5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5',
  events: ['*'],
};

function makeConfig(backfill?: Partial<BackfillConfig>): Config {
  return {
    stellarNetwork: 'testnet',
    stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
    stellarRpcUrl: 'https://soroban-testnet.stellar.org:443',
    contractAddresses: [contractConfig],
    pollIntervalMs: 30000,
    maxReconnectAttempts: 5,
    reconnectDelayMs: 100,
    eventsApiPort: 8787,
    eventsApiCorsOrigin: 'http://localhost:5173',
    backfill: backfill !== undefined ? { maxLedgers: 10_000, ...backfill } : undefined,
  };
}

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
    topic: [] as any,
    value: {} as any,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EventSubscriber — backfill safety limit (#628)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEvents.mockResolvedValue({ events: [], cursor: '' });
  });

  describe('cold start with backfill limit enabled', () => {
    it('applies the ledger cap when no cursor is stored', async () => {
      const networkTip = 50_000;
      const maxLedgers = 10_000;
      mockGetLatestLedger.mockResolvedValue({ sequence: networkTip });

      const subscriber = new EventSubscriber(makeConfig({ maxLedgers }));
      await (subscriber as any).checkForEvents();

      expect(mockGetEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: networkTip - maxLedgers })
      );
    });

    it('logs a WARN with the applied start ledger and skipped ledger count', async () => {
      const networkTip = 50_000;
      const maxLedgers = 10_000;
      mockGetLatestLedger.mockResolvedValue({ sequence: networkTip });

      const subscriber = new EventSubscriber(makeConfig({ maxLedgers }));
      await (subscriber as any).checkForEvents();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Backfill safety limit applied: starting historical replay from ledger',
        expect.objectContaining({
          networkTipLedger: networkTip,
          backfillMaxLedgers: maxLedgers,
          startLedger: networkTip - maxLedgers,
          skippedLedgers: networkTip - maxLedgers - 1,
        })
      );
    });

    it('clamps startLedger to 1 when tip minus maxLedgers would be <= 0', async () => {
      // tip (500) minus maxLedgers (10000) = -9500 → clamp to 1
      mockGetLatestLedger.mockResolvedValue({ sequence: 500 });

      const subscriber = new EventSubscriber(makeConfig({ maxLedgers: 10_000 }));
      await (subscriber as any).checkForEvents();

      expect(mockGetEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 1 })
      );
    });

    it('uses the default limit of 10 000 when backfill config is omitted', async () => {
      // No backfill key in config — the subscriber should apply the 10k default.
      const networkTip = 100_000;
      mockGetLatestLedger.mockResolvedValue({ sequence: networkTip });

      const subscriber = new EventSubscriber(makeConfig());
      // makeConfig() with no args sets backfill: undefined
      await (subscriber as any).checkForEvents();

      expect(mockGetEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: networkTip - 10_000 })
      );
    });

    it('caches the resolved start ledger so getLatestLedger is called only once per session', async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 80_000 });

      const subscriber = new EventSubscriber(makeConfig({ maxLedgers: 5_000 }));

      // Two poll cycles — both contracts start cold.
      await (subscriber as any).checkForEvents();
      await (subscriber as any).checkForEvents();

      // getLatestLedger should only have been called once despite two poll cycles.
      expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
    });
  });

  describe('cold start with limit disabled (maxLedgers = 0)', () => {
    it('starts from ledger 1 when maxLedgers is 0 (unlimited)', async () => {
      const subscriber = new EventSubscriber(makeConfig({ maxLedgers: 0 }));
      await (subscriber as any).checkForEvents();

      expect(mockGetEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 1 })
      );
      // getLatestLedger must NOT be called when limit is disabled.
      expect(mockGetLatestLedger).not.toHaveBeenCalled();
    });
  });

  describe('real-time polling (cursor already stored)', () => {
    it('uses the stored cursor and does not call getLatestLedger after backfill', async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 50_000 });
      // First cold-start fetch returns an event and a cursor.
      mockGetEvents.mockResolvedValueOnce({
        events: [createMockEvent({ id: 'first' })],
        cursor: 'cursor-from-rpc',
      });
      // All subsequent fetches return empty (real-time steady state).
      mockGetEvents.mockResolvedValue({ events: [], cursor: 'cursor-from-rpc' });

      const subscriber = new EventSubscriber(makeConfig({ maxLedgers: 5_000 }));

      // First fetch: cold start — resolves start ledger, fetches events.
      await (subscriber as any).checkForEvents();
      // Second fetch: cursor now stored — must use cursor, not startLedger.
      await (subscriber as any).checkForEvents();

      // getLatestLedger must have been called only once (cold-start resolution).
      expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
      // Second RPC call must carry the cursor, not a startLedger.
      expect(mockGetEvents.mock.calls[1][0]).toMatchObject({ cursor: 'cursor-from-rpc' });
      expect(mockGetEvents.mock.calls[1][0]).not.toHaveProperty('startLedger');
    });
  });

  describe('RPC error during tip resolution', () => {
    it('falls back to ledger 1 and logs a WARN when getLatestLedger fails', async () => {
      mockGetLatestLedger.mockRejectedValue(new Error('RPC timeout'));

      const subscriber = new EventSubscriber(makeConfig({ maxLedgers: 5_000 }));
      await (subscriber as any).checkForEvents();

      // Must still proceed with startLedger: 1 so no events are silently missed.
      expect(mockGetEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 1 })
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to fetch network tip for backfill limit; falling back to ledger 1',
        expect.objectContaining({
          error: 'RPC timeout',
          backfillMaxLedgers: 5_000,
        })
      );
    });

    it('falls back to ledger 1 when getLatestLedger returns an unrecognised shape', async () => {
      // Returns an object with no recognised ledger field.
      mockGetLatestLedger.mockResolvedValue({ unknown: true });

      const subscriber = new EventSubscriber(makeConfig({ maxLedgers: 5_000 }));
      await (subscriber as any).checkForEvents();

      expect(mockGetEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 1 })
      );
    });
  });

  describe('resolveBackfillStartLedger — SDK response shape variants', () => {
    const VARIANTS = [
      { desc: 'sequence field',    response: { sequence: 70_000 },    expected: 70_000 },
      { desc: 'ledger field',      response: { ledger: 70_000 },      expected: 70_000 },
      { desc: 'latestLedger field',response: { latestLedger: 70_000 },expected: 70_000 },
    ];

    for (const { desc, response, expected } of VARIANTS) {
      it(`handles ${desc}`, async () => {
        mockGetLatestLedger.mockResolvedValue(response);

        const subscriber = new EventSubscriber(makeConfig({ maxLedgers: 1_000 }));
        const startLedger = await (subscriber as any).resolveBackfillStartLedger();

        expect(startLedger).toBe(expected - 1_000);
      });
    }
  });
});
