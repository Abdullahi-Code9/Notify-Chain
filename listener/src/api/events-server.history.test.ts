/**
 * Integration tests for GET /api/events/history
 *
 * Acceptance criteria:
 *  - Invalid ranges are rejected with 400 and a structured error body
 *  - Start and end ledger positions are individually validated
 *  - Large requests are handled safely (range > MAX_LEDGER_RANGE → 400)
 *  - Valid ranges return 200 with { count, startLedger, endLedger, events }
 *  - Events are filtered by ledger range via the registry
 */

import http from 'http';
import { createEventsServer } from './events-server';
import { eventRegistry } from '../store/event-registry';
import { MAX_LEDGER_RANGE } from '../utils/ledger-range-validator';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getHealth: jest.fn(),
      simulateTransaction: jest.fn(),
      getAccount: jest.fn().mockRejectedValue(new Error('not found') as never),
    })),
  },
  Keypair: { random: jest.fn(() => ({ publicKey: () => 'GAXXX' })) },
  Account: jest.fn(),
  Contract: jest.fn(() => ({ call: jest.fn() })),
  TransactionBuilder: jest.fn(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  })),
  BASE_FEE: '100',
  scValToNative: jest.fn(),
}), { virtual: true });

jest.mock('../store/event-registry', () => ({
  eventRegistry: {
    getEvents: jest.fn(() => []),
    getEventsByLedgerRange: jest.fn(() => []),
    count: jest.fn(() => 0),
  },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const mockRegistry = eventRegistry as jest.Mocked<typeof eventRegistry>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeServer(): http.Server {
  return createEventsServer({
    port: 0,
    stellarRpcUrl: 'http://localhost',
    stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
    contractAddresses: [],
  });
}

function get(
  server: http.Server,
  path: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/events/history', () => {
  let server: http.Server;

  beforeEach((done) => {
    jest.clearAllMocks();
    server = makeServer();
    server.listen(0, '127.0.0.1', done);
  });

  afterEach((done) => {
    server.close(done);
  });

  // ── 200 happy-path ─────────────────────────────────────────────────────────

  describe('valid requests → 200', () => {
    it('returns 200 with an empty events array when the registry has no matches', async () => {
      mockRegistry.getEventsByLedgerRange.mockReturnValue([]);

      const { status, body } = await get(server, '/api/events/history?fromLedger=100&toLedger=200');

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.count).toBe(0);
      expect(body.data.startLedger).toBe(100);
      expect(body.data.endLedger).toBe(200);
      expect(body.data.events).toEqual([]);
    });

    it('passes the parsed ledger numbers to the registry', async () => {
      mockRegistry.getEventsByLedgerRange.mockReturnValue([]);

      await get(server, '/api/events/history?fromLedger=500&toLedger=600');

      expect(mockRegistry.getEventsByLedgerRange).toHaveBeenCalledWith(500, 600);
    });

    it('returns the events provided by the registry', async () => {
      const fakeEvent = {
        eventId: 'evt-1',
        contractAddress: 'CABC',
        eventName: 'TaskCreated',
        ledger: 150,
        type: 'contract',
        topic: ['TaskCreated'],
        value: '42',
        txHash: 'abc123',
        receivedAt: 1000,
      };
      mockRegistry.getEventsByLedgerRange.mockReturnValue([fakeEvent]);

      const { status, body } = await get(server, '/api/events/history?fromLedger=100&toLedger=200');

      expect(status).toBe(200);
      expect(body.data.count).toBe(1);
      expect(body.data.events).toHaveLength(1);
      expect(body.data.events[0].eventId).toBe('evt-1');
    });

    it('returns count matching the number of events returned by the registry', async () => {
      const fakeEvents = [
        { eventId: 'evt-1', ledger: 101 },
        { eventId: 'evt-2', ledger: 102 },
        { eventId: 'evt-3', ledger: 103 },
      ];
      mockRegistry.getEventsByLedgerRange.mockReturnValue(fakeEvents as any);

      const { status, body } = await get(server, '/api/events/history?fromLedger=100&toLedger=200');

      expect(status).toBe(200);
      expect(body.data.count).toBe(3);
    });

    it('accepts a single-ledger range (fromLedger === toLedger)', async () => {
      mockRegistry.getEventsByLedgerRange.mockReturnValue([]);

      const { status, body } = await get(server, '/api/events/history?fromLedger=1&toLedger=1');

      expect(status).toBe(200);
      expect(body.data.startLedger).toBe(1);
      expect(body.data.endLedger).toBe(1);
    });

    it('accepts the exact maximum range width', async () => {
      mockRegistry.getEventsByLedgerRange.mockReturnValue([]);
      const to = 1 + MAX_LEDGER_RANGE - 1; // width == MAX_LEDGER_RANGE

      const { status } = await get(server, `/api/events/history?fromLedger=1&toLedger=${to}`);

      expect(status).toBe(200);
    });

    it('works via the /api/v1/ prefix (API versioning)', async () => {
      mockRegistry.getEventsByLedgerRange.mockReturnValue([]);

      const { status } = await get(server, '/api/v1/events/history?fromLedger=1&toLedger=100');

      expect(status).toBe(200);
    });
  });

  // ── 400 — missing parameters ───────────────────────────────────────────────

  describe('missing parameters → 400', () => {
    it('rejects a request with no query parameters', async () => {
      const { status, body } = await get(server, '/api/events/history');

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('rejects a request missing toLedger', async () => {
      const { status, body } = await get(server, '/api/events/history?fromLedger=100');

      expect(status).toBe(400);
      expect(body.success).toBe(false);
    });

    it('rejects a request missing fromLedger', async () => {
      const { status, body } = await get(server, '/api/events/history?toLedger=200');

      expect(status).toBe(400);
      expect(body.success).toBe(false);
    });

    it('includes field-level details for the missing parameter', async () => {
      const { body } = await get(server, '/api/events/history?fromLedger=100');

      expect(body.error.details).toBeDefined();
      const details = body.error.details as any;
      // validationErrorBody wraps the issues array under a `details` key
      const issues: Array<{ field: string; message: string }> =
        details.details ?? details;
      expect(Array.isArray(issues)).toBe(true);
      expect(issues.some((i) => i.field === 'toLedger')).toBe(true);
    });
  });

  // ── 400 — invalid parameter values ────────────────────────────────────────

  describe('invalid parameter values → 400', () => {
    it('rejects a non-integer fromLedger', async () => {
      const { status } = await get(server, '/api/events/history?fromLedger=1.5&toLedger=100');
      expect(status).toBe(400);
    });

    it('rejects an alphabetic fromLedger', async () => {
      const { status } = await get(server, '/api/events/history?fromLedger=abc&toLedger=100');
      expect(status).toBe(400);
    });

    it('rejects a zero fromLedger', async () => {
      const { status, body } = await get(server, '/api/events/history?fromLedger=0&toLedger=100');
      expect(status).toBe(400);
      expect(body.success).toBe(false);
    });

    it('rejects a negative fromLedger', async () => {
      const { status } = await get(server, '/api/events/history?fromLedger=-1&toLedger=100');
      expect(status).toBe(400);
    });

    it('rejects a non-integer toLedger', async () => {
      const { status } = await get(server, '/api/events/history?fromLedger=1&toLedger=99.9');
      expect(status).toBe(400);
    });

    it('rejects a zero toLedger', async () => {
      const { status } = await get(server, '/api/events/history?fromLedger=1&toLedger=0');
      expect(status).toBe(400);
    });

    it('rejects both parameters being zero', async () => {
      const { status } = await get(server, '/api/events/history?fromLedger=0&toLedger=0');
      expect(status).toBe(400);
    });
  });

  // ── 400 — invalid range relationships ─────────────────────────────────────

  describe('invalid range relationships → 400', () => {
    it('rejects an inverted range (from > to)', async () => {
      const { status, body } = await get(server, '/api/events/history?fromLedger=200&toLedger=100');

      expect(status).toBe(400);
      expect(body.success).toBe(false);
    });

    it('includes a descriptive message for an inverted range', async () => {
      const { body } = await get(server, '/api/events/history?fromLedger=500&toLedger=100');

      const details = body.error.details as any;
      const issues: Array<{ field: string; message: string }> =
        details.details ?? details;
      expect(issues.some((i) => i.message.includes('<= endLedger'))).toBe(true);
    });
  });

  // ── 400 — large request safety ─────────────────────────────────────────────

  describe('large request safety → 400', () => {
    it('rejects a range wider than MAX_LEDGER_RANGE', async () => {
      const from = 1;
      const to = MAX_LEDGER_RANGE + 1; // width = MAX_LEDGER_RANGE + 1
      const { status, body } = await get(
        server,
        `/api/events/history?fromLedger=${from}&toLedger=${to}`,
      );

      expect(status).toBe(400);
      expect(body.success).toBe(false);
    });

    it('includes the requested width in the rejection message', async () => {
      const from = 1;
      const to = MAX_LEDGER_RANGE + 500;
      const { body } = await get(
        server,
        `/api/events/history?fromLedger=${from}&toLedger=${to}`,
      );

      const details = body.error.details as any;
      const issues: Array<{ field: string; message: string }> =
        details.details ?? details;
      const rangeIssue = issues.find((i) => i.field === 'endLedger');
      expect(rangeIssue?.message).toContain('range too large');
    });

    it('does not call the event registry for an oversized request', async () => {
      const from = 1;
      const to = MAX_LEDGER_RANGE + 1;
      await get(server, `/api/events/history?fromLedger=${from}&toLedger=${to}`);

      expect(mockRegistry.getEventsByLedgerRange).not.toHaveBeenCalled();
    });
  });

  // ── Response envelope ──────────────────────────────────────────────────────

  describe('response envelope', () => {
    it('wraps success responses in the standard { success: true, data: … } shape', async () => {
      mockRegistry.getEventsByLedgerRange.mockReturnValue([]);

      const { body } = await get(server, '/api/events/history?fromLedger=1&toLedger=100');

      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
    });

    it('wraps error responses in the standard { success: false, error: … } shape', async () => {
      const { body } = await get(server, '/api/events/history?fromLedger=200&toLedger=100');

      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('BAD_REQUEST');
      expect(typeof body.error.message).toBe('string');
    });
  });
});
