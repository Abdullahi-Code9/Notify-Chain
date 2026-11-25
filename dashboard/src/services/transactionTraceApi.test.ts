import { fetchTransactionTrace, getHorizonBaseUrl } from './transactionTraceApi';

const HASH = 'a'.repeat(64);
const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('transaction trace API', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock,
    });
  });

  it('resolves known Stellar networks and rejects unsupported values', () => {
    expect(getHorizonBaseUrl('TESTNET')).toBe('https://horizon-testnet.stellar.org');
    expect(getHorizonBaseUrl('public')).toBe('https://horizon.stellar.org');
    expect(() => getHorizonBaseUrl('private')).toThrow('Unsupported Stellar network');
  });

  it('loads transaction metadata and chronological operation records', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response({
          hash: HASH,
          ledger: 42,
          source_account: 'GABC',
          created_at: '2026-01-01T00:00:00Z',
          successful: true,
        }),
      )
      .mockResolvedValueOnce(
        response({
          _embedded: {
            records: [
              { id: '1', type: 'payment', source_account: 'GABC' },
              { id: '2', type: 'invoke_host_function', source_account: 'GDEF' },
            ],
          },
        }),
      );

    const trace = await fetchTransactionTrace(HASH);

    expect(trace.operations.map((operation) => operation.type)).toEqual([
      'payment',
      'invoke_host_function',
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://horizon-testnet.stellar.org/transactions/${HASH}/operations?order=asc&limit=200`,
    );
  });

  it('rejects invalid hashes without making a network request', async () => {
    await expect(fetchTransactionTrace('not-a-hash')).rejects.toThrow(
      'valid 64-character Stellar transaction hash',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports missing transactions and malformed operation responses', async () => {
    fetchMock.mockResolvedValueOnce(response({}, 404));
    await expect(fetchTransactionTrace(HASH)).rejects.toThrow(
      'Transaction not found on the selected network',
    );

    fetchMock
      .mockResolvedValueOnce(
        response({
          hash: HASH,
          ledger: 42,
          source_account: 'GABC',
          created_at: '2026-01-01T00:00:00Z',
          successful: true,
        }),
      )
      .mockResolvedValueOnce(response({}));
    await expect(fetchTransactionTrace(HASH)).rejects.toThrow('invalid operations response');
  });
});
