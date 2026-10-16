import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from '@jest/globals';
import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { Database, initializeDatabase, getDatabase } from '../database/database';
import { RateLimiter } from './rate-limiter';
import { createEventsServer } from './events-server';
import logger from '../utils/logger';

// Mock logger
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockRequest = (headers: Record<string, string> = {}, ip = '127.0.0.1') => {
  return {
    headers,
    socket: { remoteAddress: ip },
    url: '/api/schedule',
    method: 'POST',
  } as unknown as http.IncomingMessage;
};

const mockResponse = () => {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body = '';
  return {
    setHeader: jest
      .fn()
      .mockImplementation((name: any, val: any) => headers.set(name.toLowerCase(), String(val))),
    writeHead: jest.fn().mockImplementation((code: any, h: any) => {
      statusCode = code;
      if (h) {
        Object.entries(h).forEach(([n, v]) => headers.set(n.toLowerCase(), String(v)));
      }
    }),
    end: jest.fn().mockImplementation((val: any) => {
      body = val;
    }),
    _getHeaders: () => headers,
    _getStatusCode: () => statusCode,
    _getBody: () => body,
  } as unknown as http.ServerResponse & {
    _getHeaders: () => Map<string, string>;
    _getStatusCode: () => number;
    _getBody: () => string;
  };
};

describe('RateLimiter', () => {
  let db: Database;
  const testDbPath = './data/test-rate-limiter.db';

  beforeAll(async () => {
    const dbDir = path.dirname(testDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    // Initialize database for rate limiter recording
    db = await initializeDatabase(testDbPath);
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await db.run('DELETE FROM rate_limit_events');
  });

  describe('Client Identification', () => {
    it('identifies client by x-api-key header', () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 1000,
        maxRequests: 5,
        clientOverrides: {},
      });
      const req = mockRequest({ 'x-api-key': 'test-key-123' });
      const client = limiter.identifyClient(req);

      expect(client.clientId).toBe('test-key-123');
      expect(client.clientType).toBe('API_KEY');
      limiter.destroy();
    });

    it('identifies client by Authorization Bearer token header', () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 1000,
        maxRequests: 5,
        clientOverrides: {},
      });
      const req = mockRequest({ authorization: 'Bearer token-abc' });
      const client = limiter.identifyClient(req);

      expect(client.clientId).toBe('token-abc');
      expect(client.clientType).toBe('API_KEY');
      limiter.destroy();
    });

    it('identifies client by x-forwarded-for header (first IP)', () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 1000,
        maxRequests: 5,
        clientOverrides: {},
      });
      const req = mockRequest({ 'x-forwarded-for': '192.168.1.1, 10.0.0.1' });
      const client = limiter.identifyClient(req);

      expect(client.clientId).toBe('192.168.1.1');
      expect(client.clientType).toBe('IP');
      limiter.destroy();
    });

    it('falls back to remote address when no headers present', () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 1000,
        maxRequests: 5,
        clientOverrides: {},
      });
      const req = mockRequest({}, '10.0.0.5');
      const client = limiter.identifyClient(req);

      expect(client.clientId).toBe('10.0.0.5');
      expect(client.clientType).toBe('IP');
      limiter.destroy();
    });
  });

  describe('Request Handling and Limits', () => {
    it('allows requests below limit and sets standard headers', async () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 60000,
        maxRequests: 3,
        clientOverrides: {},
      });

      const req = mockRequest({}, '127.0.0.1');
      const res = mockResponse();

      const allowed = await limiter.handle(req, res);
      expect(allowed).toBe(true);
      expect(res._getHeaders().get('x-ratelimit-limit')).toBe('3');
      expect(res._getHeaders().get('x-ratelimit-remaining')).toBe('2');
      expect(res._getHeaders().get('x-ratelimit-reset')).toBeDefined();
      limiter.destroy();
    });

    it('blocks request exceeding the limit and returns 429', async () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 60000,
        maxRequests: 2,
        clientOverrides: {},
      });

      const req = mockRequest({}, '127.0.0.1');

      // Request 1
      const allowed1 = await limiter.handle(req, mockResponse());
      expect(allowed1).toBe(true);

      // Request 2
      const allowed2 = await limiter.handle(req, mockResponse());
      expect(allowed2).toBe(true);

      // Request 3 - Exceeded
      const res3 = mockResponse();
      const allowed3 = await limiter.handle(req, res3);

      expect(allowed3).toBe(false);
      expect(res3._getStatusCode()).toBe(429);
      expect(res3._getHeaders().get('x-ratelimit-remaining')).toBe('0');
      expect(res3._getHeaders().get('retry-after')).toBeDefined();

      const body = JSON.parse(res3._getBody());
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.message).toContain('Rate limit exceeded');
      limiter.destroy();
    });

    it('supports disabling rate limiting via config', async () => {
      const limiter = new RateLimiter({
        enabled: false,
        windowMs: 60000,
        maxRequests: 1,
        clientOverrides: {},
      });

      const req = mockRequest({}, '127.0.0.1');

      const allowed1 = await limiter.handle(req, mockResponse());
      const allowed2 = await limiter.handle(req, mockResponse());

      expect(allowed1).toBe(true);
      expect(allowed2).toBe(true);
      limiter.destroy();
    });
  });

  describe('Client-Specific Overrides', () => {
    it('applies client-specific override rate limits', async () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 60000,
        maxRequests: 2,
        clientOverrides: {
          'vip-api-key': { maxRequests: 5 },
          'poor-api-key': { maxRequests: 1 },
        },
      });

      // VIP client is allowed 5 requests
      const vipReq = mockRequest({ 'x-api-key': 'vip-api-key' });
      for (let i = 0; i < 4; i++) {
        expect(await limiter.handle(vipReq, mockResponse())).toBe(true);
      }

      // Poor client is blocked after 1 request
      const poorReq = mockRequest({ 'x-api-key': 'poor-api-key' });
      expect(await limiter.handle(poorReq, mockResponse())).toBe(true);
      expect(await limiter.handle(poorReq, mockResponse())).toBe(false);
      limiter.destroy();
    });
  });

  describe('Metrics Tracking', () => {
    it('tracks allowed and blocked requests accurately', async () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 60000,
        maxRequests: 2,
        clientOverrides: {},
      });

      const req = mockRequest({}, '127.0.0.1');

      // Initial metrics
      let metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.allowedRequests).toBe(0);
      expect(metrics.blockedRequests).toBe(0);

      // Request 1: Allowed
      await limiter.handle(req, mockResponse());
      metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBe(1);
      expect(metrics.allowedRequests).toBe(1);
      expect(metrics.blockedRequests).toBe(0);

      // Request 2: Allowed
      await limiter.handle(req, mockResponse());
      metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBe(2);
      expect(metrics.allowedRequests).toBe(2);
      expect(metrics.blockedRequests).toBe(0);

      // Request 3: Blocked
      await limiter.handle(req, mockResponse());
      metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBe(3);
      expect(metrics.allowedRequests).toBe(2);
      expect(metrics.blockedRequests).toBe(1);

      limiter.destroy();
    });

    it('tracks top blocked clients', async () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 60000,
        maxRequests: 1,
        clientOverrides: {},
      });

      // Client A: 3 blocks
      const reqA = mockRequest({ 'x-api-key': 'client-a' });
      await limiter.handle(reqA, mockResponse());
      await limiter.handle(reqA, mockResponse());
      await limiter.handle(reqA, mockResponse());
      await limiter.handle(reqA, mockResponse());

      // Client B: 1 block
      const reqB = mockRequest({ 'x-api-key': 'client-b' });
      await limiter.handle(reqB, mockResponse());
      await limiter.handle(reqB, mockResponse());

      const metrics = limiter.getMetrics();
      expect(metrics.topBlockedClients.length).toBe(2);
      expect(metrics.topBlockedClients[0].blockCount).toBe(3);
      expect(metrics.topBlockedClients[1].blockCount).toBe(1);

      limiter.destroy();
    });

    it('resets metrics when requested', async () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 60000,
        maxRequests: 1,
        clientOverrides: {},
      });

      const req = mockRequest({}, '127.0.0.1');
      await limiter.handle(req, mockResponse());
      await limiter.handle(req, mockResponse());

      let metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBe(2);

      limiter.resetMetrics();

      metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.allowedRequests).toBe(0);
      expect(metrics.blockedRequests).toBe(0);

      limiter.destroy();
    });

    it('masks API keys in top blocked clients', async () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 60000,
        maxRequests: 1,
        clientOverrides: {},
      });

      const req = mockRequest({ 'x-api-key': 'sk_live_very_long_secret_key_12345' });
      await limiter.handle(req, mockResponse());
      await limiter.handle(req, mockResponse());

      const metrics = limiter.getMetrics();
      expect(metrics.topBlockedClients[0].clientId).toBe('sk_live_...');
      expect(metrics.topBlockedClients[0].clientId).not.toContain('secret');

      limiter.destroy();
    });

    it('does not mask IP addresses in top blocked clients', async () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 60000,
        maxRequests: 1,
        clientOverrides: {},
      });

      const req = mockRequest({}, '192.168.1.100');
      await limiter.handle(req, mockResponse());
      await limiter.handle(req, mockResponse());

      const metrics = limiter.getMetrics();
      expect(metrics.topBlockedClients[0].clientId).toBe('192.168.1.100');

      limiter.destroy();
    });
  });

  describe('Event Recording', () => {
    it('records rate limit violations to SQLite database and logs warning', async () => {
      const limiter = new RateLimiter({
        enabled: true,
        windowMs: 60000,
        maxRequests: 1,
        clientOverrides: {},
      });

      const req = mockRequest({ 'x-api-key': 'attacker-key' }, '8.8.8.8');

      // Request 1: Allowed
      await limiter.handle(req, mockResponse());

      // Request 2: Blocked (Rate limit exceeded)
      const res = mockResponse();
      await limiter.handle(req, res);

      // Verify logger warning was called
      expect(logger.warn).toHaveBeenCalledWith(
        'Rate limit exceeded',
        expect.objectContaining({
          clientId: 'attacker...',
          clientType: 'API_KEY',
          endpoint: '/api/schedule',
        }),
      );

      // Verify DB record
      // Need a small timeout to allow async DB insert to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const rows = await db.all('SELECT * FROM rate_limit_events');
      expect(rows.length).toBe(1);
      expect(rows[0].client_id).toBe('attacker-key');
      expect(rows[0].client_type).toBe('API_KEY');
      expect(rows[0].endpoint).toBe('/api/schedule');
      expect(rows[0].method).toBe('POST');
      expect(rows[0].limit_threshold).toBe(1);
      expect(rows[0].window_ms).toBe(60000);
      limiter.destroy();
    });
  });
});

describe('Events Server Rate Limiting Integration', () => {
  let server: http.Server;
  const port = 8999;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const makeRequest = (
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: any }> => {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'GET',
          headers,
        },
        (res) => {
          resolve({ status: res.statusCode!, headers: res.headers });
        },
      );
      req.on('error', reject);
      req.end();
    });
  };

  it('applies rate limiting and blocks requests over HTTP', async () => {
    server = createEventsServer({
      port,
      stellarRpcUrl: 'https://soroban-testnet.stellar.org:443',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
      rateLimit: {
        enabled: true,
        windowMs: 60000,
        maxRequests: 2,
        clientOverrides: {},
      },
    });

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

    // Make 2 requests
    const res1 = await makeRequest('/api/events');
    const res2 = await makeRequest('/api/events');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Third request should be blocked with 429
    const res3 = await makeRequest('/api/events');
    expect(res3.status).toBe(429);
    expect(res3.headers['x-ratelimit-limit']).toBe('2');
    expect(res3.headers['x-ratelimit-remaining']).toBe('0');
    expect(res3.headers['retry-after']).toBeDefined();
  });

  it('provides rate limiting metrics via GET /api/rate-limit/metrics', async () => {
    server = createEventsServer({
      port,
      stellarRpcUrl: 'https://soroban-testnet.stellar.org:443',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
      rateLimit: {
        enabled: true,
        windowMs: 60000,
        maxRequests: 2,
        clientOverrides: {},
      },
    });

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

    // Make requests to generate metrics
    await makeRequest('/api/events');
    await makeRequest('/api/events');
    await makeRequest('/api/events'); // This one should be blocked

    // Fetch metrics
    const metricsResponse = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/api/rate-limit/metrics',
            method: 'GET',
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => {
              resolve({ status: res.statusCode!, body });
            });
          },
        );
        req.on('error', reject);
        req.end();
      },
    );

    expect(metricsResponse.status).toBe(200);
    const metrics = JSON.parse(metricsResponse.body);

    expect(metrics.totalRequests).toBeGreaterThanOrEqual(3);
    expect(metrics.allowedRequests).toBeGreaterThanOrEqual(2);
    expect(metrics.blockedRequests).toBeGreaterThanOrEqual(1);
    expect(metrics.uniqueClients).toBeGreaterThanOrEqual(1);
    expect(metrics.startTime).toBeDefined();
  });
});
