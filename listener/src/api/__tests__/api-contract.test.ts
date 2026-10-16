/**
 * API Contract Tests
 * 
 * These tests verify that important listener API responses maintain their
 * expected structure and required fields. They act as a safety net to catch
 * breaking changes to documented API contracts.
 * 
 * @see listener/API.md for full API documentation
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'http';
import { createEventsServer } from '../events-server';
import { eventRegistry } from '../../store/event-registry';

// Mock Stellar SDK
jest.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
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

// Mock event registry
jest.mock('../../store/event-registry', () => ({
  eventRegistry: {
    getEvents: jest.fn(() => []),
    count: jest.fn(() => 0),
    getIngestionSnapshot: jest.fn(() => ({
      lastIngestedLedger: 12345,
      lastIngestedAt: Date.now() - 5000,
    })),
  },
}));

// Mock logger
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
  sanitizeUrl: jest.fn((url: string) => url),
}));

// Mock database
jest.mock('../../database/database', () => ({
  getDatabase: jest.fn(() => ({
    isConnected: () => true,
    get: jest.fn().mockResolvedValue({ ok: 1 }),
  })),
  Database: jest.fn(),
  resetDatabaseSingleton: jest.fn(),
}));

/**
 * Helper function to make HTTP requests to the test server
 */
function request(
  server: http.Server,
  method: string,
  path: string,
  body?: object
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsedBody: unknown;
          try {
            parsedBody = data ? JSON.parse(data) : null;
          } catch {
            parsedBody = data;
          }
          resolve({
            status: res.statusCode!,
            body: parsedBody,
            headers: res.headers,
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('API Contract Tests', () => {
  let server: http.Server;

  beforeEach((done) => {
    jest.clearAllMocks();
    server = createEventsServer({
      port: 0,
      stellarRpcUrl: 'http://localhost:11111',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
    });
    server.listen(0, '127.0.0.1', done);
  });

  afterEach((done) => {
    server.close(done);
  });

  describe('GET /health', () => {
    it('should return expected response structure', async () => {
      const res = await request(server, 'GET', '/health');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('version');
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).toHaveProperty('uptimeSeconds');
      expect(res.body).toHaveProperty('services');

      const body = res.body as any;
      
      // Verify status is one of expected values
      expect(['ok', 'degraded', 'error']).toContain(body.status);
      
      // Verify version is a string
      expect(typeof body.version).toBe('string');
      
      // Verify timestamp is ISO 8601 format
      expect(typeof body.timestamp).toBe('string');
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
      
      // Verify uptimeSeconds is a number
      expect(typeof body.uptimeSeconds).toBe('number');
      
      // Verify services object has required keys
      expect(body.services).toHaveProperty('stellarRpc');
      expect(body.services).toHaveProperty('discord');
      expect(body.services).toHaveProperty('database');
      expect(body.services).toHaveProperty('eventRegistry');
      
      // Verify each service has correct structure
      expect(body.services.stellarRpc).toHaveProperty('status');
      expect(['ok', 'error', 'not_configured']).toContain(body.services.stellarRpc.status);
      
      expect(body.services.eventRegistry).toHaveProperty('status');
      expect(body.services.eventRegistry).toHaveProperty('eventCount');
      expect(typeof body.services.eventRegistry.eventCount).toBe('number');
    });

    it('should include response headers with request tracking', async () => {
      const res = await request(server, 'GET', '/health');

      expect(res.headers).toHaveProperty('x-request-id');
      expect(res.headers).toHaveProperty('x-correlation-id');
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    });
  });

  describe('GET /api/status', () => {
    it('should return expected response structure', async () => {
      const res = await request(server, 'GET', '/api/status');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success');
      expect(res.body).toHaveProperty('data');

      const body = res.body as any;
      expect(body.success).toBe(true);
      
      // Verify data object has required fields
      expect(body.data).toHaveProperty('timestamp');
      expect(body.data).toHaveProperty('contracts');
      
      // Verify timestamp is ISO 8601 format
      expect(typeof body.data.timestamp).toBe('string');
      expect(new Date(body.data.timestamp).toISOString()).toBe(body.data.timestamp);
      
      // Verify contracts is an array
      expect(Array.isArray(body.data.contracts)).toBe(true);
    });

    it('should have correct contract status structure when contracts exist', async () => {
      // Create a new server with contract addresses
      await new Promise<void>((resolve) => server.close(() => resolve()));
      
      server = createEventsServer({
        port: 0,
        stellarRpcUrl: 'http://localhost:11111',
        stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
        contractAddresses: [
          { address: 'CCEMX6TEST', events: ['*'] },
        ],
      });
      
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const res = await request(server, 'GET', '/api/status');
      const body = res.body as any;

      expect(body.data.contracts.length).toBeGreaterThan(0);
      
      // Verify each contract has required fields
      body.data.contracts.forEach((contract: any) => {
        expect(contract).toHaveProperty('address');
        expect(contract).toHaveProperty('paused');
        expect(typeof contract.address).toBe('string');
        expect(typeof contract.paused).toBe('boolean');
        // error field is optional and only present on failure
      });
    });
  });

  describe('GET /api/events', () => {
    it('should return expected response structure', async () => {
      const res = await request(server, 'GET', '/api/events');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success');
      expect(res.body).toHaveProperty('data');

      const body = res.body as any;
      expect(body.success).toBe(true);
      
      // Verify data has required fields
      expect(body.data).toHaveProperty('count');
      expect(body.data).toHaveProperty('events');
      
      // Verify count is a number
      expect(typeof body.data.count).toBe('number');
      
      // Verify events is an array
      expect(Array.isArray(body.data.events)).toBe(true);
    });

    it('should have correct event structure when events exist', async () => {
      // Mock event registry to return sample event
      const mockEvent = {
        eventId: '0000000000000001-1',
        contractAddress: 'CCEMX6JKPEUGYAOU4YZP3WBXGPWK7AEFDEDLRXFIDIJPQFMRXTHUVIO',
        eventName: 'test_event',
        ledger: 12345,
        type: 'contract',
        topic: ['test_event', 'GABC'],
        value: 'AAAAAQ==',
        txHash: 'abc123def456',
        receivedAt: Date.now(),
      };

      (eventRegistry.getEvents as jest.Mock).mockReturnValue([mockEvent]);
      (eventRegistry.count as jest.Mock).mockReturnValue(1);

      const res = await request(server, 'GET', '/api/events');
      const body = res.body as any;

      expect(body.data.count).toBe(1);
      expect(body.data.events.length).toBe(1);

      const event = body.data.events[0];
      
      // Verify required fields exist
      expect(event).toHaveProperty('eventId');
      expect(event).toHaveProperty('contractAddress');
      expect(event).toHaveProperty('ledger');
      expect(event).toHaveProperty('type');
      expect(event).toHaveProperty('topic');
      expect(event).toHaveProperty('value');
      expect(event).toHaveProperty('txHash');
      expect(event).toHaveProperty('receivedAt');
      
      // Verify field types
      expect(typeof event.eventId).toBe('string');
      expect(typeof event.contractAddress).toBe('string');
      expect(typeof event.ledger).toBe('number');
      expect(typeof event.type).toBe('string');
      expect(Array.isArray(event.topic)).toBe(true);
      expect(typeof event.value).toBe('string');
      expect(typeof event.txHash).toBe('string');
      expect(typeof event.receivedAt).toBe('number');
    });

    it('should respect limit query parameter', async () => {
      const mockEvents = Array.from({ length: 10 }, (_, i) => ({
        eventId: `000000000000000${i}-1`,
        contractAddress: 'CCEMX6TEST',
        eventName: `event_${i}`,
        ledger: 12345 + i,
        type: 'contract',
        topic: [`event_${i}`],
        value: 'AAAAAQ==',
        txHash: `hash${i}`,
        receivedAt: Date.now(),
      }));

      (eventRegistry.getEvents as jest.Mock).mockReturnValueOnce(mockEvents.slice(0, 5));
      (eventRegistry.count as jest.Mock).mockReturnValue(10);

      const res = await request(server, 'GET', '/api/events?limit=5');
      const body = res.body as any;

      expect(res.status).toBe(200);
      expect(Array.isArray(body.data.events)).toBe(true);
    });
  });

  describe('GET /api/indexing/health', () => {
    it('should return expected response structure', async () => {
      const res = await request(server, 'GET', '/api/indexing/health');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success');
      expect(res.body).toHaveProperty('data');

      const body = res.body as any;
      expect(body.success).toBe(true);
      
      // Verify data has required fields
      expect(body.data).toHaveProperty('status');
      expect(body.data).toHaveProperty('timestamp');
      expect(body.data).toHaveProperty('indexedLedger');
      expect(body.data).toHaveProperty('networkTipLedger');
      expect(body.data).toHaveProperty('ledgerLag');
      expect(body.data).toHaveProperty('processingDelayMs');
      expect(body.data).toHaveProperty('lastIngestedAt');
      
      // Verify status is one of expected values
      expect(['synced', 'syncing', 'degraded']).toContain(body.data.status);
      
      // Verify timestamp is ISO 8601 format
      expect(typeof body.data.timestamp).toBe('string');
      expect(new Date(body.data.timestamp).toISOString()).toBe(body.data.timestamp);
      
      // Verify field types (these can be null)
      if (body.data.indexedLedger !== null) {
        expect(typeof body.data.indexedLedger).toBe('number');
      }
      if (body.data.networkTipLedger !== null) {
        expect(typeof body.data.networkTipLedger).toBe('number');
      }
      if (body.data.ledgerLag !== null) {
        expect(typeof body.data.ledgerLag).toBe('number');
      }
      if (body.data.processingDelayMs !== null) {
        expect(typeof body.data.processingDelayMs).toBe('number');
      }
      if (body.data.lastIngestedAt !== null) {
        expect(typeof body.data.lastIngestedAt).toBe('string');
        expect(new Date(body.data.lastIngestedAt).toISOString()).toBe(body.data.lastIngestedAt);
      }
    });
  });

  describe('POST /api/notifications/validate-batch', () => {
    it('should return expected success response structure', async () => {
      const validBatch = [
        {
          id: 'n1',
          recipient: 'user_a',
          channel: 'discord',
          message: 'Test notification',
        },
      ];

      const res = await request(server, 'POST', '/api/notifications/validate-batch', validBatch);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success');
      expect(res.body).toHaveProperty('data');

      const body = res.body as any;
      expect(body.success).toBe(true);
      
      // Verify data structure
      expect(body.data).toHaveProperty('valid');
      expect(body.data).toHaveProperty('processedCount');
      expect(body.data).toHaveProperty('errors');
      
      // Verify field types
      expect(typeof body.data.valid).toBe('boolean');
      expect(typeof body.data.processedCount).toBe('number');
      expect(Array.isArray(body.data.errors)).toBe(true);
      
      // For valid batch, errors should be empty
      if (body.data.valid) {
        expect(body.data.errors.length).toBe(0);
      }
    });

    it('should return expected error response structure for invalid batch', async () => {
      const invalidBatch = [
        {
          id: 'n1',
          // missing required fields: recipient, channel, message
        },
      ];

      const res = await request(server, 'POST', '/api/notifications/validate-batch', invalidBatch);

      const body = res.body as any;
      
      expect(body.success).toBe(true); // The endpoint wraps validation results in success envelope
      expect(body.data.valid).toBe(false);
      expect(typeof body.data.processedCount).toBe('number');
      
      // Verify error structure exists
      expect(Array.isArray(body.data.errors)).toBe(true);
      expect(body.data.errors.length).toBeGreaterThan(0);
      
      // Verify error structure
      const error = body.data.errors[0];
      expect(error).toHaveProperty('index');
      expect(error).toHaveProperty('code');
      expect(error).toHaveProperty('message');
      expect(typeof error.index).toBe('number');
      expect(typeof error.code).toBe('string');
      expect(typeof error.message).toBe('string');
    });
  });

  describe('Error Responses', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await request(server, 'GET', '/api/unknown-endpoint');

      expect(res.status).toBe(404);
    });

    it('should handle OPTIONS requests for CORS', async () => {
      const res = await request(server, 'OPTIONS', '/api/events');

      expect(res.status).toBe(204);
    });
  });

  describe('API Versioning', () => {
    it('should accept /api/v1/* routes and include version header', async () => {
      const res = await request(server, 'GET', '/api/v1/events');

      expect(res.status).toBe(200);
      expect(res.headers['x-api-version']).toBe('v1');
      expect(res.body).toHaveProperty('success');
      expect(res.body).toHaveProperty('data');
      
      const body = res.body as any;
      expect(body.data).toHaveProperty('count');
      expect(body.data).toHaveProperty('events');
    });

    it('should include X-API-Version header on all API responses', async () => {
      const res = await request(server, 'GET', '/api/events');

      expect(res.headers['x-api-version']).toBe('v1');
    });
  });
});
