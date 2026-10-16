/**
 * Tests for Issue #482 — Notification Delivery Metrics API
 *
 * Covers:
 *  - GET /api/notifications/delivery-metrics (current snapshot)
 *  - GET /api/notifications/delivery-metrics/history (persisted history)
 *  - 503 when aggregator / store is missing
 *  - Optional ?reset=true behaviour
 *  - Query-param validation (?since invalid date)
 */

import http from 'http';
import { createEventsServer } from './events-server';
import {
  NotificationAnalyticsAggregator,
  NotificationAnalyticsSnapshot,
} from '../services/notification-analytics-aggregator';
import {
  NotificationMetricsStore,
  StoredMetricsSnapshot,
} from '../services/notification-metrics-store';

// ── Helpers ───────────────────────────────────────────────────────────────────

function request(
  server: http.Server,
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function startServer(options: Record<string, unknown>): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = createEventsServer({
      port: 0,
      stellarRpcUrl: 'http://localhost',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
      ...options,
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function closeServer(s: http.Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

// ── Stub aggregator ───────────────────────────────────────────────────────────

function makeStubAggregator(
  overrides: Partial<NotificationAnalyticsSnapshot> = {},
): NotificationAnalyticsAggregator {
  const base: NotificationAnalyticsSnapshot = {
    totalRecorded: 100,
    windowStart: 1_700_000_000_000,
    windowEnd: 1_700_003_600_000,
    overall: {
      total: 100,
      success: 90,
      failure: 8,
      retry: 2,
      skipped: 0,
      successRate: 0.9,
      averageDurationMs: 250,
    },
    byType: [],
    byContract: [],
    hourlyBuckets: [],
    errorBreakdown: { TIMEOUT: 5, INVALID_RECIPIENT: 3 },
    ...overrides,
  };

  const resetSpy = jest.fn();
  return {
    snapshot: () => base,
    reset: resetSpy,
    record: jest.fn(),
    get lifetimeCount() {
      return base.totalRecorded;
    },
    get size() {
      return base.totalRecorded;
    },
  } as unknown as NotificationAnalyticsAggregator;
}

// ── Stub metrics store ────────────────────────────────────────────────────────

function makeStubStore(rows: StoredMetricsSnapshot[] = []): NotificationMetricsStore {
  return {
    getHistory: jest.fn().mockResolvedValue(rows),
    saveSnapshot: jest.fn().mockResolvedValue(1),
    purgeOlderThan: jest.fn().mockResolvedValue(0),
  } as unknown as NotificationMetricsStore;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/notifications/delivery-metrics', () => {
  let server: http.Server;

  afterEach(async () => {
    if (server) await closeServer(server);
  });

  it('returns 200 with delivery statistics from the aggregator', async () => {
    const aggregator = makeStubAggregator();
    server = await startServer({ analyticsAggregator: aggregator });

    const res = await request(server, 'GET', '/api/notifications/delivery-metrics');

    expect(res.status).toBe(200);
    const body = res.body as { success: boolean; data: NotificationAnalyticsSnapshot };
    expect(body.success).toBe(true);
    expect(body.data.totalRecorded).toBe(100);
    expect(body.data.overall.success).toBe(90);
    expect(body.data.overall.successRate).toBe(0.9);
    expect(body.data.errorBreakdown).toEqual({ TIMEOUT: 5, INVALID_RECIPIENT: 3 });
  });

  it('returns 503 when no aggregator is configured', async () => {
    server = await startServer({ analyticsAggregator: null });

    const res = await request(server, 'GET', '/api/notifications/delivery-metrics');

    expect(res.status).toBe(503);
    const body = res.body as { error: string | { code: string; message: string } };
    const errorMessage = typeof body.error === 'string' ? body.error : body.error?.message;
    expect(errorMessage).toMatch(/unavailable/i);
  });

  it('includes byType, byContract, hourlyBuckets and errorBreakdown fields', async () => {
    const aggregator = makeStubAggregator();
    server = await startServer({ analyticsAggregator: aggregator });

    const res = await request(server, 'GET', '/api/notifications/delivery-metrics');
    const data = (res.body as { data: NotificationAnalyticsSnapshot }).data;

    expect(Array.isArray(data.byType)).toBe(true);
    expect(Array.isArray(data.byContract)).toBe(true);
    expect(Array.isArray(data.hourlyBuckets)).toBe(true);
    expect(typeof data.errorBreakdown).toBe('object');
  });

  it('resets the aggregator window when ?reset=true is passed', async () => {
    const aggregator = makeStubAggregator();
    const resetSpy = jest.spyOn(aggregator, 'reset');
    server = await startServer({ analyticsAggregator: aggregator });

    const res = await request(server, 'GET', '/api/notifications/delivery-metrics?reset=true');

    expect(res.status).toBe(200);
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT reset the aggregator when ?reset is absent', async () => {
    const aggregator = makeStubAggregator();
    const resetSpy = jest.spyOn(aggregator, 'reset');
    server = await startServer({ analyticsAggregator: aggregator });

    await request(server, 'GET', '/api/notifications/delivery-metrics');

    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('is also accessible via versioned path /api/v1/notifications/delivery-metrics', async () => {
    const aggregator = makeStubAggregator();
    server = await startServer({ analyticsAggregator: aggregator });

    const res = await request(server, 'GET', '/api/v1/notifications/delivery-metrics');

    expect(res.status).toBe(200);
  });
});

describe('GET /api/notifications/delivery-metrics/history', () => {
  let server: http.Server;

  afterEach(async () => {
    if (server) await closeServer(server);
  });

  it('returns 200 with an array of stored snapshots', async () => {
    const now = new Date().toISOString();
    const rows: StoredMetricsSnapshot[] = [
      {
        id: 1,
        capturedAt: now,
        snapshot: {
          totalRecorded: 50,
          windowStart: 0,
          windowEnd: 3600000,
          overall: {
            total: 50,
            success: 45,
            failure: 5,
            retry: 0,
            skipped: 0,
            successRate: 0.9,
            averageDurationMs: 200,
          },
          byType: [],
          byContract: [],
          hourlyBuckets: [],
          errorBreakdown: {},
        },
      },
    ];
    const store = makeStubStore(rows);
    server = await startServer({ metricsStore: store });

    const res = await request(server, 'GET', '/api/notifications/delivery-metrics/history');

    expect(res.status).toBe(200);
    const body = res.body as { success: boolean; data: { count: number; snapshots: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.count).toBe(1);
    expect(body.data.snapshots).toHaveLength(1);
  });

  it('returns 503 when no metrics store is configured', async () => {
    server = await startServer({ metricsStore: null });

    const res = await request(server, 'GET', '/api/notifications/delivery-metrics/history');

    expect(res.status).toBe(503);
  });

  it('passes the limit query param to the store', async () => {
    const store = makeStubStore([]);
    server = await startServer({ metricsStore: store });

    await request(server, 'GET', '/api/notifications/delivery-metrics/history?limit=10');

    expect(store.getHistory).toHaveBeenCalledWith(10, undefined);
  });

  it('passes a valid since param as a Date to the store', async () => {
    const store = makeStubStore([]);
    server = await startServer({ metricsStore: store });

    await request(
      server,
      'GET',
      '/api/notifications/delivery-metrics/history?since=2024-01-01T00:00:00.000Z',
    );

    expect(store.getHistory).toHaveBeenCalledWith(50, expect.any(Date));
  });

  it('returns 400 when since is not a valid ISO date', async () => {
    const store = makeStubStore([]);
    server = await startServer({ metricsStore: store });

    const res = await request(
      server,
      'GET',
      '/api/notifications/delivery-metrics/history?since=not-a-date',
    );

    expect(res.status).toBe(400);
  });

  it('returns an empty snapshots array when the store has no data', async () => {
    const store = makeStubStore([]);
    server = await startServer({ metricsStore: store });

    const res = await request(server, 'GET', '/api/notifications/delivery-metrics/history');
    const body = res.body as { data: { count: number; snapshots: unknown[] } };

    expect(body.data.count).toBe(0);
    expect(body.data.snapshots).toEqual([]);
  });
});
