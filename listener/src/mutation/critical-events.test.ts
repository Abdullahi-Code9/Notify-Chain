import { EventDeduplicationService } from '../services/event-deduplication-service';
import { Database } from '../database/database';
import { matchesEventFilter } from '../utils/event-utils';
import { normalizeSorobanEvent } from '../services/event-normalization';
import { xdr } from '@stellar/stellar-sdk';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../database/database', () => ({ Database: jest.fn() }));

describe('critical normalization and filtering boundaries', () => {
  it('preserves transaction identity while normalizing contract whitespace', () => {
    const result = normalizeSorobanEvent(
      {
        id: 'event',
        type: 'contract',
        ledger: 0,
        txHash: 'transaction',
        topic: [],
        value: xdr.ScVal.scvU32(1),
      },
      { contractAddress: '  contract  ' },
    );
    expect(result).toMatchObject({
      ok: true,
      event: {
        eventId: 'event',
        contractAddress: 'contract',
        ledger: 0,
        txHash: 'transaction',
        payloadVersion: 1,
      },
    });
  });

  it('allows named and unnamed events with an empty allow-list', () => {
    expect(matchesEventFilter('NotificationScheduled', [])).toBe(true);
    expect(matchesEventFilter(null, [])).toBe(true);
  });
});

describe('critical event claim and completion transitions', () => {
  const run = jest.fn<(...args: unknown[]) => Promise<{ changes: number }>>();
  const all = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();
  let service: EventDeduplicationService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new EventDeduplicationService({ run, all } as unknown as Database);
  });

  it.each([0, 1])('only acquires a claim when exactly one row changes (%i)', async (changes) => {
    run.mockResolvedValue({ changes });
    await expect(service.claimEvent('event', 'contract', 20, 'tx', 'contract')).resolves.toEqual({
      claimed: changes === 1,
      alreadySeen: changes !== 1,
    });
  });

  it.each([true, false])('persists delivery outcome %s with terminal status', async (sent) => {
    run.mockResolvedValue({ changes: 1 });
    await service.completeEvent(
      'event', 'contract', 20, 'tx', 'contract', sent, 'ERROR', 'delivery failed',
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toEqual([
      'ERROR', sent ? 1 : 0, 'delivery failed', expect.any(String),
    ]);
  });

  it('creates a terminal record when a fail-open claim left no row', async () => {
    run.mockResolvedValueOnce({ changes: 0 }).mockResolvedValueOnce({ changes: 1 });
    await service.completeEvent('event', 'contract', 20, undefined, 'contract', true, 'PROCESSED');
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toContain('INSERT INTO processed_events');
    expect(run.mock.calls[1][1]).toEqual([
      'event', 'contract', expect.any(String), 20, null, 'contract', 1, 'PROCESSED', null,
    ]);
  });

  it.each([
    { ledger: 19, expected: true },
    { ledger: 20, expected: false },
    { ledger: 21, expected: false },
  ])('detects a reorg only when the ledger decreases ($ledger)', async ({ ledger, expected }) => {
    all.mockResolvedValue([
      {
        contract_address: 'contract',
        cursor: 'cursor',
        ledger_number: 20,
        reorg_detected: 0,
        reorg_detection_count: 0,
      },
    ]);
    await expect(service.detectReorg('contract', ledger)).resolves.toBe(expected);
  });
});
