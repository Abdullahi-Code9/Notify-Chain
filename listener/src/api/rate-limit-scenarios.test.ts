/**
 * API rate-limit scenario tests (issue #852)
 *
 * Verifies that the rate limiter behaves predictably under the three traffic
 * conditions called out in the issue:
 *
 *   - normal   – legitimate clients stay under their quota and are never blocked
 *   - burst    – a sudden spike is capped at exactly `maxRequests`
 *   - repeated – sustained traffic is re-admitted once the window rolls over
 *
 * plus two cross-cutting guarantees:
 *
 *   - the 429 response is a stable, machine-readable envelope
 *   - one client exhausting its quota never affects another client, and the
 *     observability routes stay reachable while throttled
 *
 * The unit-level cases drive `RateLimiter.handle` directly with fake
 * request/response objects; the final integration block exercises the same
 * behaviour end-to-end through a real `http.Server`.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import http from 'http';

import { RateLimiter } from './rate-limiter';
import { createEventsServer } from './events-server';
import type { RateLimitConfig } from '../types';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

interface MockResponse {
  res: http.ServerResponse;
  captured: () => CapturedResponse;
}

function makeRequest(
  headers: Record<string, string> = {},
  ip = '127.0.0.1',
  url = '/api/events',
  method = 'GET',
): http.IncomingMessage {
  return {
    headers,
    socket: { remoteAddress: ip },
    url,
    method,
  } as unknown as http.IncomingMessage;
}

/** Minimal ServerResponse stand-in that records the full wire response. */
function makeResponse(): MockResponse {
  const headers: Record<string, string> = {};
  let status = 200;
  let rawBody = '';

  const res = {
    setHeader: (name: string, value: unknown) => {
      headers[name.toLowerCase()] = String(value);
    },
    getHeader: (name: string) => headers[name.toLowerCase()],
    writeHead: (code: number, extra?: Record<string, unknown>) => {
      status = code;
      if (extra) {
        for (const [key, value] of Object.entries(extra)) {
          headers[key.toLowerCase()] = String(value);
        }
      }
    },
    end: (chunk?: unknown) => {
      if (chunk !== undefined) rawBody = String(chunk);
    },
  } as unknown as http.ServerResponse;

  return {
    res,
    captured: () => ({
      status,
      headers,
      body: rawBody ? JSON.parse(rawBody) : undefined,
    }),
  };
}

const baseConfig = (overrides: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
  enabled: true,
  windowMs: 60_000,
  maxRequests: 5,
  clientOverrides: {},
  ...overrides,
});

describe('Rate limiting under normal load (#852)', () => {
  let limiter: RateLimiter;

  afterEach(() => limiter?.destroy());

  it('admits every request from distinct clients that stay under quota', async () => {
    limiter = new RateLimiter(baseConfig({ maxRequests: 5 }));

    // Five independent API keys, each making four requests (< 5 quota).
    const results: boolean[] = [];
    for (let client = 0; client < 5; client++) {
      const req = makeRequest({ 'x-api-key': `client-${client}` });
      for (let i = 0; i < 4; i++) {
        results.push(await limiter.handle(req, makeResponse().res));
      }
    }

    expect(results.every(Boolean)).toBe(true);
    expect(results).toHaveLength(20);

    const metrics = limiter.getMetrics();
    expect(metrics.totalRequests).toBe(20);
    expect(metrics.allowedRequests).toBe(20);
    expect(metrics.blockedRequests).toBe(0);
    expect(metrics.uniqueClients).toBe(5);
  });

  it('reports a decreasing remaining quota without ever going negative', async () => {
    limiter = new RateLimiter(baseConfig({ maxRequests: 3 }));
    const req = makeRequest({ 'x-api-key': 'normal-client' });

    const remaining: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { res, captured } = makeResponse();
      await limiter.handle(req, res);
      remaining.push(captured().headers['x-ratelimit-remaining']);
    }

    expect(remaining).toEqual(['2', '1', '0']);
    expect(remaining.every((value) => Number(value) >= 0)).toBe(true);
  });

  it('does not block a client merely because others are active', async () => {
    limiter = new RateLimiter(baseConfig({ maxRequests: 2 }));

    const chatty = makeRequest({ 'x-api-key': 'chatty' });
    await limiter.handle(chatty, makeResponse().res);
    await limiter.handle(chatty, makeResponse().res);
    expect(await limiter.handle(chatty, makeResponse().res)).toBe(false);

    // A separate client still has its full quota available.
    const quiet = makeRequest({ 'x-api-key': 'quiet' });
    expect(await limiter.handle(quiet, makeResponse().res)).toBe(true);
    expect(await limiter.handle(quiet, makeResponse().res)).toBe(true);
  });
});

describe('Rate limiting under burst load (#852)', () => {
  let limiter: RateLimiter;

  afterEach(() => limiter?.destroy());

  it('caps a concurrent burst at exactly maxRequests', async () => {
    const maxRequests = 5;
    const burstSize = 25;
    limiter = new RateLimiter(baseConfig({ maxRequests, windowMs: 60_000 }));

    const req = makeRequest({ 'x-api-key': 'burst-client' });
    const responses = await Promise.all(
      Array.from({ length: burstSize }, () => limiter.handle(req, makeResponse().res)),
    );

    const allowed = responses.filter(Boolean).length;
    const blocked = responses.filter((allowed) => !allowed).length;

    expect(allowed).toBe(maxRequests);
    expect(blocked).toBe(burstSize - maxRequests);
    expect(allowed + blocked).toBe(burstSize);

    const metrics = limiter.getMetrics();
    expect(metrics.totalRequests).toBe(burstSize);
    expect(metrics.allowedRequests).toBe(maxRequests);
    expect(metrics.blockedRequests).toBe(burstSize - maxRequests);
  });

  it('returns an identical, predictable 429 for every burst rejection', async () => {
    const maxRequests = 3;
    limiter = new RateLimiter(baseConfig({ maxRequests, windowMs: 60_000 }));
    const req = makeRequest({ 'x-api-key': 'burst-envelope' });

    const rejections: CapturedResponse[] = [];
    for (let i = 0; i < maxRequests + 10; i++) {
      const { res, captured } = makeResponse();
      const allowed = await limiter.handle(req, res);
      if (!allowed) rejections.push(captured());
    }

    expect(rejections).toHaveLength(10);
    for (const response of rejections) {
      expect(response.status).toBe(429);
      expect(response.headers['x-ratelimit-limit']).toBe(String(maxRequests));
      expect(response.headers['x-ratelimit-remaining']).toBe('0');
      expect(response.headers['x-ratelimit-reset']).toMatch(/^\d+$/);
      expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'RATE_LIMITED' },
      });
      expect(response.body.error.message).toContain('Rate limit exceeded');
    }
  });

  it('keeps the burst allowance honest under overlapping clients', async () => {
    limiter = new RateLimiter(baseConfig({ maxRequests: 4, windowMs: 60_000 }));

    const clients = ['alpha', 'beta', 'gamma'];
    const perClient = 6;

    const responses = await Promise.all(
      clients.flatMap((client) =>
        Array.from({ length: perClient }, () =>
          limiter.handle(makeRequest({ 'x-api-key': client }), makeResponse().res),
        ),
      ),
    );

    // Each client independently gets exactly 4 of its 6 requests.
    for (let i = 0; i < clients.length; i++) {
      const slice = responses.slice(i * perClient, (i + 1) * perClient);
      expect(slice.filter(Boolean)).toHaveLength(4);
    }
    expect(limiter.getMetrics().blockedRequests).toBe(clients.length * (perClient - 4));
  });
});

describe('Rate limiting under repeated load across windows (#852)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('re-admits a sustained client after the window rolls over', async () => {
    const limiter = new RateLimiter(baseConfig({ maxRequests: 2, windowMs: 1_000 }));
    const req = makeRequest({ 'x-api-key': 'sustained-client' });

    try {
      // Window 1: two allowed, the rest throttled.
      expect(await limiter.handle(req, makeResponse().res)).toBe(true);
      expect(await limiter.handle(req, makeResponse().res)).toBe(true);
      expect(await limiter.handle(req, makeResponse().res)).toBe(false);
      expect(limiter.getMetrics().blockedRequests).toBe(1);

      // Advance exactly one window: quota resets.
      jest.advanceTimersByTime(1_000);
      expect(await limiter.handle(req, makeResponse().res)).toBe(true);
      expect(await limiter.handle(req, makeResponse().res)).toBe(true);
      expect(await limiter.handle(req, makeResponse().res)).toBe(false);

      // Advance three windows at once: the client is fully re-admitted again.
      jest.advanceTimersByTime(3_000);
      expect(await limiter.handle(req, makeResponse().res)).toBe(true);
      expect(await limiter.handle(req, makeResponse().res)).toBe(true);

      const metrics = limiter.getMetrics();
      // 5 allowed (2 + 2 + 1... actually 2+2+2) and 2 blocked across three windows.
      expect(metrics.allowedRequests).toBe(6);
      expect(metrics.blockedRequests).toBe(2);
    } finally {
      limiter.destroy();
    }
  });

  it('does not leak quota across windows for a client that only trickles requests', async () => {
    const limiter = new RateLimiter(baseConfig({ maxRequests: 1, windowMs: 500 }));
    const req = makeRequest({ 'x-api-key': 'trickle-client' });

    try {
      for (let window = 0; window < 4; window++) {
        expect(await limiter.handle(req, makeResponse().res)).toBe(true);
        // A second request in the same window is blocked.
        expect(await limiter.handle(req, makeResponse().res)).toBe(false);
        jest.advanceTimersByTime(500);
      }

      const metrics = limiter.getMetrics();
      expect(metrics.allowedRequests).toBe(4);
      expect(metrics.blockedRequests).toBe(4);
    } finally {
      limiter.destroy();
    }
  });
});

describe('Rate limiting client isolation and exemptions (#852)', () => {
  let limiter: RateLimiter;

  afterEach(() => limiter?.destroy());

  it('keeps API-key buckets and IP buckets independent', async () => {
    limiter = new RateLimiter(baseConfig({ maxRequests: 1 }));

    const keyed = makeRequest({ 'x-api-key': 'keyed-client' }, '10.0.0.1');
    const anonymous = makeRequest({}, '10.0.0.2');

    expect(await limiter.handle(keyed, makeResponse().res)).toBe(true);
    expect(await limiter.handle(keyed, makeResponse().res)).toBe(false);

    // A different identity still gets its own allowance.
    expect(await limiter.handle(anonymous, makeResponse().res)).toBe(true);
    expect(await limiter.handle(anonymous, makeResponse().res)).toBe(false);
  });

  it('applies per-client overrides without affecting the default quota', async () => {
    limiter = new RateLimiter(
      baseConfig({
        maxRequests: 2,
        clientOverrides: {
          premium: { maxRequests: 5 },
        },
      }),
    );

    const premium = makeRequest({ 'x-api-key': 'premium' });
    for (let i = 0; i < 5; i++) {
      expect(await limiter.handle(premium, makeResponse().res)).toBe(true);
    }
    expect(await limiter.handle(premium, makeResponse().res)).toBe(false);

    const standard = makeRequest({ 'x-api-key': 'standard' });
    expect(await limiter.handle(standard, makeResponse().res)).toBe(true);
    expect(await limiter.handle(standard, makeResponse().res)).toBe(true);
    expect(await limiter.handle(standard, makeResponse().res)).toBe(false);
  });

  it('treats a disabled limiter as a pass-through for all traffic', async () => {
    limiter = new RateLimiter(baseConfig({ enabled: false, maxRequests: 1 }));
    const req = makeRequest({ 'x-api-key': 'anything' });
    for (let i = 0; i < 50; i++) {
      expect(await limiter.handle(req, makeResponse().res)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end enforcement through a real HTTP server
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: body ? JSON.parse(body) : undefined,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Rate limiting over HTTP (#852)', () => {
  let server: http.Server | undefined;

  const startServer = async (rateLimit: RateLimitConfig): Promise<number> => {
    server = createEventsServer({
      port: 0,
      stellarRpcUrl: 'https://soroban-testnet.stellar.org:443',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
      rateLimit,
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server!.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    return address.port;
  };

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('enforces the quota end-to-end and returns the predictable 429 envelope', async () => {
    const port = await startServer(baseConfig({ maxRequests: 2, windowMs: 60_000 }));

    const first = await httpGet(port, '/api/events', { 'x-api-key': 'e2e-client' });
    const second = await httpGet(port, '/api/events', { 'x-api-key': 'e2e-client' });
    const third = await httpGet(port, '/api/events', { 'x-api-key': 'e2e-client' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.headers['x-ratelimit-limit']).toBe('2');
    expect(third.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(third.body).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
  });

  it('never blocks legitimate concurrent traffic from other clients', async () => {
    const port = await startServer(baseConfig({ maxRequests: 3, windowMs: 60_000 }));

    const responses = await Promise.all([
      httpGet(port, '/api/events', { 'x-api-key': 'client-one' }),
      httpGet(port, '/api/events', { 'x-api-key': 'client-two' }),
      httpGet(port, '/api/events', { 'x-api-key': 'client-three' }),
      httpGet(port, '/api/events', { 'x-api-key': 'client-one' }),
      httpGet(port, '/api/events', { 'x-api-key': 'client-two' }),
    ]);

    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  it('keeps /health and /api/rate-limit/metrics reachable while throttled', async () => {
    const port = await startServer(baseConfig({ maxRequests: 1, windowMs: 60_000 }));

    const allowed = await httpGet(port, '/api/events', { 'x-api-key': 'exhausted' });
    const throttled = await httpGet(port, '/api/events', { 'x-api-key': 'exhausted' });
    expect(allowed.status).toBe(200);
    expect(throttled.status).toBe(429);

    // Observability routes are exempt so callers can still diagnose throttling.
    const metrics = await httpGet(port, '/api/rate-limit/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.body.blockedRequests).toBeGreaterThanOrEqual(1);

    const health = await httpGet(port, '/health');
    // /health may report 200 or 503 depending on the (network-isolated) environment,
    // but it must never be rate limited.
    expect(health.status).not.toBe(429);
  });
});
