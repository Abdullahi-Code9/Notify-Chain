import { xdr } from '@stellar/stellar-sdk';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  HistoricalBackfillService,
  type BackfillResult,
} from './historical-backfill-service';
import { BackfillConfig, ContractConfig } from '../types';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      Server: jest.fn().mockImplementation(() => ({})),
    },
  };
});

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../store/event-registry', () => ({
  eventRegistry: {
    addFromInput: jest.fn(),
  },
}));

jest.mock('../store/preference-store', () => ({
  preferenceStore: {
    isCategoryEnabled: jest.fn().mockReturnValue(true),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    topic: [xdr.ScVal.scvSymbol('TestEvent')],
    value: xdr.ScVal.scvU32(1),
    ...overrides,
  };
}

const CONTRACT_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const contractConfig: ContractConfig = {
  address: CONTRACT_ADDRESS,
  events: ['*'],
};

const baseBackfillConfig: BackfillConfig = {
  enabled: true,
  startLedger: 100,
  endLedger: 200,
  maxPages: 10,
  maxEventsPerContract: 1000,
};

/** Build a deduplication service mock that never flags duplicates by default. */
function makeDeduplicationService(isDuplicateResult = false) {
  return {
    isDuplicate: jest.fn().mockResolvedValue({
      isDuplicate: isDuplicateResult,
      isReorgDuplicate: false,
    }),
    recordProcessedEvent: jest.fn().mockResolvedValue(undefined),
  } as any;
}

/** Build a single-page fetchPage stub returning the supplied events. */
function singlePageFetch(events: StellarSDK.rpc.Api.EventResponse[]) {
  return jest.fn().mockResolvedValue({ events, cursor: undefined });
}

/** Resolve endLedger to 200 (matching baseBackfillConfig.endLedger). */
const tipAt200 = jest.fn().mockResolvedValue(200);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HistoricalBackfillService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('returns a result with eventsRecovered equal to the number of new events', async () => {
      const events = [makeEvent('E1', 100), makeEvent('E2', 150)];
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      expect(result.totalEventsRecovered).toBe(2);
      expect(result.totalEventsSkipped).toBe(0);
      expect(result.totalEventsErrored).toBe(0);
      expect(result.contractResults).toHaveLength(1);
      expect(result.contractResults[0].completed).toBe(true);
    });

    it('calls recordProcessedEvent once per recovered event', async () => {
      const events = [makeEvent('E1', 100), makeEvent('E2', 110)];
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      expect(dedup.recordProcessedEvent).toHaveBeenCalledTimes(2);
      expect(dedup.recordProcessedEvent).toHaveBeenCalledWith(
        'E1',
        CONTRACT_ADDRESS,
        100,
        'tx-E1',
        'contract',
        false,         // no discord
        'PROCESSED',
        undefined
      );
    });

    it('adds recovered events to the in-memory event registry', async () => {
      const { eventRegistry } = jest.requireMock('../store/event-registry');
      const events = [makeEvent('E1', 100)];
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      expect(eventRegistry.addFromInput).toHaveBeenCalledTimes(1);
      expect(eventRegistry.addFromInput).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'E1',
          contractAddress: CONTRACT_ADDRESS,
          ledger: 100,
        })
      );
    });

    it('handles multiple contracts independently', async () => {
      const contract2: ContractConfig = {
        address: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        events: ['*'],
      };

      const fetchPage = jest
        .fn()
        .mockResolvedValueOnce({ events: [makeEvent('E1', 100)], cursor: undefined })
        .mockResolvedValueOnce({ events: [makeEvent('E2', 101), makeEvent('E3', 102)], cursor: undefined });

      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig, contract2],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      expect(result.totalEventsRecovered).toBe(3);
      expect(result.contractResults).toHaveLength(2);
      expect(result.contractResults[0].eventsRecovered).toBe(1);
      expect(result.contractResults[1].eventsRecovered).toBe(2);
    });
  });

  // ── Deduplication ──────────────────────────────────────────────────────────

  describe('deduplication — already-processed events are skipped', () => {
    it('skips events that are already in processed_events', async () => {
      const events = [makeEvent('ALREADY', 100), makeEvent('NEW', 101)];
      const dedup = {
        isDuplicate: jest
          .fn()
          .mockResolvedValueOnce({ isDuplicate: true, isReorgDuplicate: false })  // ALREADY
          .mockResolvedValueOnce({ isDuplicate: false, isReorgDuplicate: false }), // NEW
        recordProcessedEvent: jest.fn().mockResolvedValue(undefined),
      } as any;

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      expect(result.totalEventsSkipped).toBe(1);
      expect(result.totalEventsRecovered).toBe(1);
      // recordProcessedEvent should only be called for the non-duplicate
      expect(dedup.recordProcessedEvent).toHaveBeenCalledTimes(1);
      expect(dedup.recordProcessedEvent).toHaveBeenCalledWith(
        'NEW',
        expect.any(String),
        expect.any(Number),
        expect.any(String),
        expect.any(String),
        expect.any(Boolean),
        'PROCESSED',
        undefined
      );
    });

    it('skips all events when every event is already processed', async () => {
      const events = [makeEvent('D1', 100), makeEvent('D2', 101), makeEvent('D3', 102)];
      const dedup = makeDeduplicationService(true); // all duplicates

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      expect(result.totalEventsSkipped).toBe(3);
      expect(result.totalEventsRecovered).toBe(0);
      expect(dedup.recordProcessedEvent).not.toHaveBeenCalled();
    });

    it('does not add duplicate events to the event registry', async () => {
      const { eventRegistry } = jest.requireMock('../store/event-registry');
      const events = [makeEvent('DUP', 100)];
      const dedup = makeDeduplicationService(true);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      expect(eventRegistry.addFromInput).not.toHaveBeenCalled();
    });
  });

  // ── Event filtering ────────────────────────────────────────────────────────

  describe('event filtering', () => {
    it('skips events that do not match the contract event filter', async () => {
      const filteredContract: ContractConfig = {
        address: CONTRACT_ADDRESS,
        events: ['WantedEvent'],
      };
      const events = [
        makeEvent('E1', 100, { topic: [xdr.ScVal.scvSymbol('WantedEvent')] }),
        makeEvent('E2', 101, { topic: [xdr.ScVal.scvSymbol('UnwantedEvent')] }),
      ];
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [filteredContract],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      // E2 filtered out before dedup → counted as skipped
      expect(result.totalEventsSkipped).toBe(1);
      expect(result.totalEventsRecovered).toBe(1);
    });

    it('skips events with invalid payloads (missing ledger)', async () => {
      const invalidEvent = {
        id: 'BAD',
        type: 'contract',
        // ledger deliberately omitted → validateEventPayload returns invalid
        topic: [xdr.ScVal.scvSymbol('TestEvent')],
        value: xdr.ScVal.scvU32(1),
        txHash: 'tx-bad',
        ledgerClosedAt: '',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
      } as unknown as StellarSDK.rpc.Api.EventResponse;

      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch([invalidEvent]), getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      // An event with no ledger is filtered out by the pre-validation window
      // check (ledger <= endLedger is false for undefined). It is not scanned,
      // not recovered, and dedup is never reached.
      expect(result.totalEventsRecovered).toBe(0);
      expect(dedup.isDuplicate).not.toHaveBeenCalled();
    });

    it('skips events that pass the window filter but fail payload validation (missing value)', async () => {
      // ledger is inside the window so the event reaches processOneEvent,
      // but value is absent so validateEventPayload rejects it.
      const invalidEvent = makeEvent('BAD_VALUE', 150);
      (invalidEvent as any).value = undefined;

      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch([invalidEvent]), getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      expect(result.totalEventsSkipped).toBe(1);
      expect(result.totalEventsRecovered).toBe(0);
      expect(dedup.isDuplicate).not.toHaveBeenCalled();
    });

    it('skips events whose ledger is beyond endLedger', async () => {
      const events = [
        makeEvent('IN', 150),   // within window [100..200]
        makeEvent('OUT', 250),  // beyond endLedger=200
      ];
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      // OUT is filtered before dedup → only IN is recovered
      expect(result.totalEventsRecovered).toBe(1);
      expect(dedup.isDuplicate).toHaveBeenCalledTimes(1);
      expect(dedup.isDuplicate).toHaveBeenCalledWith('IN', CONTRACT_ADDRESS);
    });
  });

  // ── Pagination ─────────────────────────────────────────────────────────────

  describe('pagination', () => {
    it('follows cursors across multiple pages', async () => {
      const page1Events = [makeEvent('P1E1', 100), makeEvent('P1E2', 110)];
      const page2Events = [makeEvent('P2E1', 120)];

      const fetchPage = jest
        .fn()
        .mockResolvedValueOnce({ events: page1Events, cursor: 'cursor-after-page1' })
        .mockResolvedValueOnce({ events: page2Events, cursor: undefined });

      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        { ...baseBackfillConfig, maxPages: 5 },
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      expect(fetchPage).toHaveBeenCalledTimes(2);
      // Second call must use the cursor from page 1
      expect(fetchPage.mock.calls[1][3]).toBe('cursor-after-page1');
      expect(result.totalEventsRecovered).toBe(3);
      expect(result.contractResults[0].pagesProcessed).toBe(2);
    });

    it('stops paging when the RPC returns no cursor', async () => {
      const fetchPage = jest
        .fn()
        .mockResolvedValueOnce({ events: [makeEvent('E1', 100)], cursor: undefined });

      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        { ...baseBackfillConfig, maxPages: 10 },
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      // Only one page should have been fetched despite maxPages=10
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('stops paging when maxPages is reached', async () => {
      // Always return a cursor so pagination would continue indefinitely
      const fetchPage = jest
        .fn()
        .mockResolvedValue({ events: [makeEvent('E', 100)], cursor: 'next' });

      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        { ...baseBackfillConfig, maxPages: 3 },
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      expect(fetchPage).toHaveBeenCalledTimes(3);
    });

    it('stops paging when maxEventsPerContract is exceeded', async () => {
      // Each page returns one event and a cursor, but cap is 2
      const fetchPage = jest
        .fn()
        .mockResolvedValue({ events: [makeEvent('E', 100)], cursor: 'next' });

      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        { ...baseBackfillConfig, maxPages: 50, maxEventsPerContract: 2 },
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      // Third event tips the cap — paging stops
      expect(result.contractResults[0].pagesProcessed).toBeLessThanOrEqual(3);
    });

    it('stops paging when the last event in a batch is beyond endLedger', async () => {
      const fetchPage = jest
        .fn()
        .mockResolvedValueOnce({
          events: [makeEvent('E1', 100), makeEvent('E2', 250)], // E2 past endLedger=200
          cursor: 'should-not-follow',
        });

      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        { ...baseBackfillConfig, maxPages: 5 },
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      // Paging must stop after the first page since tail is past endLedger
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });
  });

  // ── endLedger resolution ───────────────────────────────────────────────────

  describe('endLedger resolution', () => {
    it('uses the configured endLedger when provided', async () => {
      const fetchPage = jest.fn().mockResolvedValue({ events: [], cursor: undefined });
      const getTip = jest.fn().mockResolvedValue(9999);
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        { ...baseBackfillConfig, endLedger: 150 },
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: getTip }
      );

      await svc.run();

      // getNetworkTipLedger should NOT be called when endLedger is explicit
      expect(getTip).not.toHaveBeenCalled();
    });

    it('falls back to the network tip when endLedger is omitted', async () => {
      const fetchPage = jest.fn().mockResolvedValue({ events: [], cursor: undefined });
      const getTip = jest.fn().mockResolvedValue(500);
      const dedup = makeDeduplicationService(false);

      const configNoEnd: BackfillConfig = {
        ...baseBackfillConfig,
        endLedger: undefined,
      };

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        configNoEnd,
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: getTip }
      );

      const result = await svc.run();

      expect(getTip).toHaveBeenCalledTimes(1);
      // Backfill completed (no events, but run finished)
      expect(result.contractResults[0].endLedger).toBe(500);
    });

    it('aborts and returns empty result when the network tip is unavailable and endLedger is not set', async () => {
      const fetchPage = jest.fn();
      const getTip = jest.fn().mockResolvedValue(null);
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        { ...baseBackfillConfig, endLedger: undefined },
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: getTip }
      );

      const result = await svc.run();

      expect(result.totalEventsScanned).toBe(0);
      expect(result.contractResults).toHaveLength(0);
      expect(fetchPage).not.toHaveBeenCalled();
    });
  });

  // ── RPC failure handling ───────────────────────────────────────────────────

  describe('RPC error handling', () => {
    it('stops processing a contract and marks it complete when a page fetch throws', async () => {
      const fetchPage = jest.fn().mockRejectedValue(new Error('RPC timeout'));
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      // Service should not throw — it logs the error and moves on
      expect(result.contractResults[0].completed).toBe(true);
      expect(result.totalEventsRecovered).toBe(0);
    });

    it('continues processing the second contract when the first contract RPC fails', async () => {
      const contract2: ContractConfig = {
        address: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        events: ['*'],
      };

      const fetchPage = jest
        .fn()
        .mockRejectedValueOnce(new Error('first contract failed'))
        .mockResolvedValueOnce({ events: [makeEvent('E1', 100)], cursor: undefined });

      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig, contract2],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      expect(result.contractResults).toHaveLength(2);
      expect(result.contractResults[0].eventsRecovered).toBe(0);
      expect(result.contractResults[1].eventsRecovered).toBe(1);
      expect(result.totalEventsRecovered).toBe(1);
    });
  });

  // ── Discord notifications ──────────────────────────────────────────────────

  describe('Discord notifications', () => {
    const mockDiscord = {
      sendEventNotification: jest.fn().mockResolvedValue(true),
    };

    beforeEach(() => {
      mockDiscord.sendEventNotification.mockReset().mockResolvedValue(true);
    });

    it('sends a Discord notification for each recovered event when discord is configured', async () => {
      const events = [makeEvent('E1', 100), makeEvent('E2', 110)];
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        mockDiscord as any,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      expect(mockDiscord.sendEventNotification).toHaveBeenCalledTimes(2);
    });

    it('does not send Discord notifications when discord service is null', async () => {
      const events = [makeEvent('E1', 100)];
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null, // no discord
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      expect(mockDiscord.sendEventNotification).not.toHaveBeenCalled();
    });

    it('records status ERROR when Discord notification throws', async () => {
      const events = [makeEvent('E1', 100)];
      const dedup = makeDeduplicationService(false);
      const failingDiscord = {
        sendEventNotification: jest.fn().mockRejectedValue(new Error('webhook down')),
      };

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        failingDiscord as any,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      expect(result.totalEventsErrored).toBe(1);
      expect(dedup.recordProcessedEvent).toHaveBeenCalledWith(
        'E1',
        CONTRACT_ADDRESS,
        100,
        'tx-E1',
        'contract',
        false,
        'ERROR',
        'webhook down'
      );
    });

    it('respects user notification preferences and skips Discord when category is disabled', async () => {
      const { preferenceStore } = jest.requireMock('../store/preference-store');
      preferenceStore.isCategoryEnabled.mockReturnValue(false);

      const events = [makeEvent('E1', 100)];
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [{ ...contractConfig, userId: 'alice' }],
        baseBackfillConfig,
        dedup,
        mockDiscord as any,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      expect(mockDiscord.sendEventNotification).not.toHaveBeenCalled();
      expect(preferenceStore.isCategoryEnabled).toHaveBeenCalledWith('alice', 'discord');
    });
  });

  // ── Progress observability ─────────────────────────────────────────────────

  describe('progress observability', () => {
    it('logs backfill start with ledger window and contract count', async () => {
      const logger = (await import('../utils/logger')).default as any;
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch([]), getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      expect(logger.info).toHaveBeenCalledWith(
        'Historical backfill starting',
        expect.objectContaining({
          startLedger: 100,
          endLedger: 200,
          contracts: 1,
        })
      );
    });

    it('logs a page-level progress line after each RPC page', async () => {
      const logger = (await import('../utils/logger')).default as any;
      const events = [makeEvent('E1', 100), makeEvent('E2', 110)];
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      expect(logger.info).toHaveBeenCalledWith(
        'Backfill: page processed',
        expect.objectContaining({
          contractAddress: CONTRACT_ADDRESS,
          page: 1,
          batchSize: 2,
        })
      );
    });

    it('logs backfill complete with aggregate counts', async () => {
      const logger = (await import('../utils/logger')).default as any;
      const events = [makeEvent('E1', 100)];
      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: singlePageFetch(events), getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      expect(logger.info).toHaveBeenCalledWith(
        'Historical backfill complete',
        expect.objectContaining({
          totalEventsRecovered: 1,
          totalEventsSkipped: 0,
        })
      );
    });

    it('logs a warning when maxEventsPerContract cap is hit', async () => {
      const logger = (await import('../utils/logger')).default as any;
      // Always return a cursor so pagination would continue
      const fetchPage = jest
        .fn()
        .mockResolvedValue({ events: [makeEvent('E', 100)], cursor: 'next' });

      const dedup = makeDeduplicationService(false);

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [contractConfig],
        { ...baseBackfillConfig, maxPages: 50, maxEventsPerContract: 1 },
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: tipAt200 }
      );

      await svc.run();

      expect(logger.warn).toHaveBeenCalledWith(
        'Backfill: maxEventsPerContract reached, stopping this contract',
        expect.objectContaining({ contractAddress: CONTRACT_ADDRESS, maxEvents: 1 })
      );
    });
  });

  // ── BackfillResult shape ───────────────────────────────────────────────────

  describe('BackfillResult shape', () => {
    it('result totals are the sum of per-contract counts', async () => {
      const c1: ContractConfig = { address: 'CA', events: ['*'] };
      const c2: ContractConfig = { address: 'CB', events: ['*'] };

      const dedup = {
        isDuplicate: jest
          .fn()
          // C1: E1 new, E2 dup
          .mockResolvedValueOnce({ isDuplicate: false, isReorgDuplicate: false })
          .mockResolvedValueOnce({ isDuplicate: true, isReorgDuplicate: false })
          // C2: E3 new
          .mockResolvedValueOnce({ isDuplicate: false, isReorgDuplicate: false }),
        recordProcessedEvent: jest.fn().mockResolvedValue(undefined),
      } as any;

      const fetchPage = jest
        .fn()
        .mockResolvedValueOnce({ events: [makeEvent('E1', 100), makeEvent('E2', 101)], cursor: undefined })
        .mockResolvedValueOnce({ events: [makeEvent('E3', 100)], cursor: undefined });

      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [c1, c2],
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage, getNetworkTipLedger: tipAt200 }
      );

      const result: BackfillResult = await svc.run();

      expect(result.totalEventsScanned).toBe(3);
      expect(result.totalEventsRecovered).toBe(2); // E1 + E3
      expect(result.totalEventsSkipped).toBe(1);   // E2 (dup)
      expect(result.totalEventsErrored).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns an empty result with no contracts configured', async () => {
      const dedup = makeDeduplicationService(false);
      const svc = new HistoricalBackfillService(
        'http://rpc.invalid',
        [], // no contracts
        baseBackfillConfig,
        dedup,
        null,
        { fetchPage: jest.fn(), getNetworkTipLedger: tipAt200 }
      );

      const result = await svc.run();

      expect(result.totalEventsScanned).toBe(0);
      expect(result.contractResults).toHaveLength(0);
    });
  });
});
