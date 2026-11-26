import logger from '../utils/logger';
import {
  DEFAULT_METADATA_TIMEOUT_MS,
  EventResponseLike,
  TransactionMetadataResolver,
  deriveTransactionMetadata,
  extractTransactionContext,
} from './transaction-metadata-resolver';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockLogger = logger as jest.Mocked<typeof logger>;

const fullEvent: EventResponseLike = {
  id: 'evt-1',
  type: 'contract',
  ledger: 1234,
  ledgerClosedAt: '2026-01-01T00:00:00Z',
  transactionIndex: 2,
  operationIndex: 1,
  inSuccessfulContractCall: true,
  txHash: 'abc123',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('deriveTransactionMetadata', () => {
  it('marks a fully-populated event as complete with no missing fields', () => {
    const metadata = deriveTransactionMetadata(fullEvent);

    expect(metadata.metadataStatus).toBe('complete');
    expect(metadata.missingFields).toEqual([]);
    expect(metadata.reason).toBeUndefined();
    expect(metadata).toMatchObject({
      txHash: 'abc123',
      ledgerSequence: 1234,
      transactionIndex: 2,
      operationIndex: 1,
      ledgerClosedAt: '2026-01-01T00:00:00Z',
      inSuccessfulContractCall: true,
      operationType: null,
      sourceAccount: null,
    });
  });

  it('reports the missing required fields when the event is partial', () => {
    const metadata = deriveTransactionMetadata({
      txHash: 'abc123',
      ledger: 55,
      // transactionIndex / operationIndex absent
    });

    expect(metadata.metadataStatus).toBe('partial');
    expect(metadata.missingFields).toEqual(['transactionIndex', 'operationIndex']);
    expect(metadata.reason).toContain('transactionIndex');
  });

  it('marks metadata unavailable when no identity fields are present', () => {
    const metadata = deriveTransactionMetadata({ id: 'evt-only' });

    expect(metadata.metadataStatus).toBe('unavailable');
    expect(metadata.txHash).toBeNull();
    expect(metadata.ledgerSequence).toBeNull();
    expect(metadata.reason).toBeDefined();
  });

  it('handles null/undefined events without throwing', () => {
    expect(deriveTransactionMetadata(null).metadataStatus).toBe('unavailable');
    expect(deriveTransactionMetadata(undefined).metadataStatus).toBe('unavailable');
  });

  it('ignores non-primitive field values', () => {
    const metadata = deriveTransactionMetadata({
      txHash: '' as unknown as string,
      ledger: 'not-a-number' as unknown as number,
      transactionIndex: 3,
      operationIndex: 0,
    });

    expect(metadata.txHash).toBeNull();
    expect(metadata.ledgerSequence).toBeNull();
    expect(metadata.transactionIndex).toBe(3);
    expect(metadata.operationIndex).toBe(0);
    // No identity fields remain, so the status is unavailable.
    expect(metadata.metadataStatus).toBe('unavailable');
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(deriveTransactionMetadata(fullEvent))).toBe(true);
  });
});

describe('extractTransactionContext', () => {
  it('extracts the supported fields', () => {
    expect(
      extractTransactionContext({ sourceAccount: 'GABC', operationType: 'invoke', ledger: 42 }),
    ).toEqual({ sourceAccount: 'GABC', operationType: 'invoke', ledgerSequence: 42 });
  });

  it('returns null when none of the tracked fields are present', () => {
    expect(extractTransactionContext({})).toBeNull();
    expect(extractTransactionContext(null)).toBeNull();
    expect(extractTransactionContext('nope')).toBeNull();
  });
});

describe('TransactionMetadataResolver', () => {
  it('returns event-only metadata when no source is configured', async () => {
    const resolver = new TransactionMetadataResolver();
    const metadata = await resolver.resolve(fullEvent);

    expect(metadata.metadataStatus).toBe('complete');
    expect(metadata.sourceAccount).toBeNull();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('merges enrichment context and marks the metadata complete', async () => {
    const resolver = new TransactionMetadataResolver({
      source: {
        fetchTransactionContext: jest.fn().mockResolvedValue({
          sourceAccount: 'GSRC',
          operationType: 'invoke_host_function',
        }),
      },
    });

    const metadata = await resolver.resolve(fullEvent);

    expect(metadata.metadataStatus).toBe('complete');
    expect(metadata.sourceAccount).toBe('GSRC');
    expect(metadata.operationType).toBe('invoke_host_function');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('degrades to partial and warns when the lookup throws', async () => {
    const resolver = new TransactionMetadataResolver({
      source: {
        fetchTransactionContext: jest.fn().mockRejectedValue(new Error('rpc offline')),
      },
    });

    const metadata = await resolver.resolve(fullEvent);

    expect(metadata.metadataStatus).toBe('partial');
    expect(metadata.reason).toContain('rpc offline');
    // The valid event data is preserved even though enrichment failed.
    expect(metadata.txHash).toBe('abc123');
    expect(metadata.ledgerSequence).toBe(1234);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('lookup failed'),
      expect.objectContaining({ txHash: 'abc123' }),
    );
  });

  it('degrades to partial when the lookup returns no data', async () => {
    const resolver = new TransactionMetadataResolver({
      source: { fetchTransactionContext: jest.fn().mockResolvedValue(null) },
    });

    const metadata = await resolver.resolve(fullEvent);

    expect(metadata.metadataStatus).toBe('partial');
    expect(metadata.reason).toContain('no data');
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('treats a slow lookup as a timeout and continues', async () => {
    const resolver = new TransactionMetadataResolver({
      timeoutMs: 20,
      source: {
        fetchTransactionContext: jest.fn(
          () => new Promise(() => undefined), // never resolves
        ),
      },
    });

    const metadata = await resolver.resolve(fullEvent);

    expect(metadata.metadataStatus).toBe('partial');
    expect(metadata.reason).toContain('timed out');
    expect(metadata.txHash).toBe('abc123');
  });

  it('skips the lookup entirely when the event has no tx hash', async () => {
    const fetchTransactionContext = jest.fn();
    const resolver = new TransactionMetadataResolver({
      source: { fetchTransactionContext },
    });

    const metadata = await resolver.resolve({ ledger: 10, transactionIndex: 0, operationIndex: 0 });

    expect(fetchTransactionContext).not.toHaveBeenCalled();
    expect(metadata.metadataStatus).toBe('partial');
  });

  it('never throws, even when the lookup rejects with a non-Error', async () => {
    const resolver = new TransactionMetadataResolver({
      source: { fetchTransactionContext: jest.fn().mockRejectedValue('boom') },
    });

    await expect(resolver.resolve(fullEvent)).resolves.toMatchObject({
      metadataStatus: 'partial',
    });
  });

  it('rejects a non-positive timeout', () => {
    expect(() => new TransactionMetadataResolver({ timeoutMs: 0 })).toThrow(
      /timeoutMs must be a positive number/,
    );
  });

  it('exposes a sensible default timeout', () => {
    expect(DEFAULT_METADATA_TIMEOUT_MS).toBe(4000);
  });
});
